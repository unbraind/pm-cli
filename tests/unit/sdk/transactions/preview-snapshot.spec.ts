import { mkdir, symlink, writeFile } from "node:fs/promises";
import type * as fsPromises from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:net";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { previewItemMutations } from "../../../../src/sdk/item-transaction.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

const copying = vi.hoisted(() => ({ change: "none" }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>();
  return { ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (copying.change === "opened-pipe" && String(args[0]).endsWith("snapshot-probe.txt")) {
        await actual.rm(args[0]);
        execFileSync("mkfifo", [String(args[0])]);
      }
      return actual.open(...args);
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (copying.change.startsWith("stream") && String(args[0]).endsWith("snapshot-probe.txt")) throw new Error("Whole-file buffering is forbidden for this large fixture");
      return actual.readFile(...args);
    },
    cp: async (...args: Parameters<typeof actual.cp>) => {
      if (copying.change === "permission") throw Object.assign(new Error("Synthetic read denial"), { code: "EACCES" });
      if (copying.change === "invalid-path") throw Object.assign(new Error("Invalid nested path"), { code: "ENOTDIR", path: path.join(String(args[0]), "snapshot-probe.txt", "child") });
      if (copying.change === "missing-no-path") throw Object.assign(new Error("Missing path without filesystem provenance"), { code: "ENOENT" });
      if (copying.change === "invalid-lookup") throw Object.assign(new Error("Missing invalid nested path"), { code: "ENOENT", path: path.join(String(args[0]), "snapshot-probe.txt", "child") });
      if (copying.change === "disappearing") {
        const originalFilter = args[2]?.filter;
        await actual.cp(args[0], args[1], { ...args[2], filter: async (source, destination) => {
          if (path.basename(source) === "snapshot-probe.txt") await actual.rm(source);
          return originalFilter ? originalFilter(source, destination) : true;
        } });
        return;
      }
      await actual.cp(...args);
      if (copying.change === "stream-tail-change") {
        const file = await actual.open(path.join(String(args[1]), "snapshot-probe.txt"), "r+");
        try { await file.write(Buffer.from("Z"), 0, 1, 2 * 1024 * 1024 - 1); }
        finally { await file.close(); }
      } else if (["source", "staged"].includes(copying.change)) {
        const target = copying.change === "source" ? args[0] : args[1];
        await actual.writeFile(path.join(String(target), "snapshot-probe.txt"), "changed");
      }
    },
  };
});
afterEach(() => { copying.change = "none"; });

describe("semantic preview snapshot consistency", () => {
  it.each(["source", "staged", "disappearing"])("rejects %s state changes during copying instead of validating a mixed snapshot", async (change) => {
    await withTempPmPath(async (context) => {
      await writeFile(path.join(context.pmPath, "snapshot-probe.txt"), "original");
      copying.change = change;
      await expect(previewItemMutations({ pmRoot: context.pmPath, transactionId: "copy-consistency", author: "snapshot-agent", mutations: [{ op: "create", id: "pm-preview", options: { title: "Preview", type: "Task" } }] })).rejects.toMatchObject({ exitCode: 4, context: { code: "transaction_preview_snapshot_changed" } });
    });
  });
  it.each(["stream-copy", "stream-tail-change"])("hashes large snapshot files in bounded chunks: %s", async (change) => {
    await withTempPmPath(async (context) => {
      await writeFile(path.join(context.pmPath, "snapshot-probe.txt"), Buffer.alloc(2 * 1024 * 1024, "a"));
      copying.change = change;
      const preview = previewItemMutations({ pmRoot: context.pmPath, transactionId: "streamed-copy", author: "snapshot-agent", mutations: [{ op: "create", id: "pm-streamed", options: { title: "Streamed preview", type: "Task" } }] });
      if (change === "stream-copy") await expect(preview).resolves.toMatchObject({ validated: true });
      else await expect(preview).rejects.toMatchObject({ exitCode: 4, context: { code: "transaction_preview_snapshot_changed" } });
    });
  });

  it("preserves permission failures rather than labeling them concurrent changes", async () => {
    await withTempPmPath(async (context) => {
      copying.change = "permission";
      await expect(previewItemMutations({ pmRoot: context.pmPath, transactionId: "permission-copy", author: "snapshot-agent", mutations: [{ op: "create", id: "pm-permission", options: { title: "Permission preview", type: "Task" } }] })).rejects.toMatchObject({ code: "EACCES" });
    });
  });
  it.each(["invalid-path", "missing-no-path", "invalid-lookup"])("preserves persistent or unattributed path errors: %s", async (change) => {
    await withTempPmPath(async (context) => {
      await writeFile(path.join(context.pmPath, "snapshot-probe.txt"), "file rather than directory");
      copying.change = change;
      await expect(previewItemMutations({ pmRoot: context.pmPath, transactionId: "persistent-path", author: "snapshot-agent", mutations: [{ op: "create", id: "pm-path", options: { title: "Path preview", type: "Task" } }] })).rejects.toMatchObject({ code: change === "invalid-path" ? "ENOTDIR" : "ENOENT" });
    });
  });

  it("includes empty regular files in a valid snapshot", async () => {
    await withTempPmPath(async (context) => {
      await writeFile(path.join(context.pmPath, "empty-entry"), "");
      await expect(previewItemMutations({ pmRoot: context.pmPath, transactionId: "empty-file", author: "snapshot-agent", mutations: [{ op: "create", id: "pm-empty", options: { title: "Empty file preview", type: "Task" } }] })).resolves.toMatchObject({ validated: true });
    });
  });

  it.skipIf(process.platform === "win32")("refuses a regular file replaced by a pipe before opening without waiting for a writer", async () => {
    await withTempPmPath(async (context) => {
      await writeFile(path.join(context.pmPath, "snapshot-probe.txt"), "regular file");
      copying.change = "opened-pipe";
      await expect(previewItemMutations({ pmRoot: context.pmPath, transactionId: "pipe-race", author: "snapshot-agent", mutations: [{ op: "create", id: "pm-pipe", options: { title: "Pipe preview", type: "Task" } }] })).rejects.toThrow("Transaction preview requires regular files and directories");
    });
  });

  it.skipIf(process.platform === "win32")("accepts an explicitly selected linked tracker root while rejecting links within it", async () => {
    await withTempPmPath(async (context) => {
      const linkedRoot = path.join(context.tempRoot, "selected-root");
      await symlink(context.pmPath, linkedRoot);
      await expect(previewItemMutations({ pmRoot: linkedRoot, transactionId: "linked-root", author: "snapshot-agent", mutations: [{ op: "create", id: "pm-root", options: { title: "Selected root preview", type: "Task" } }] })).resolves.toMatchObject({ validated: true });
    });
  });

  it.skipIf(process.platform === "win32").each(["file", "directory", "cycle"])("rejects a %s symlink before staging external or cyclic contents", async (kind) => {
    await withTempPmPath(async (context) => {
      const outside = path.join(path.dirname(context.pmPath), "outside");
      await mkdir(outside);
      await writeFile(path.join(outside, "secret.txt"), "outside tracker");
      const target = kind === "cycle" ? context.pmPath : kind === "file" ? path.join(outside, "secret.txt") : outside;
      await symlink(target, path.join(context.pmPath, "linked-entry"));
      await expect(previewItemMutations({ pmRoot: context.pmPath, transactionId: "linked-preview", author: "snapshot-agent", mutations: [{ op: "create", id: "pm-linked", options: { title: "Linked preview", type: "Task" } }] })).rejects.toThrow("Transaction preview requires regular files and directories");
    });
  });

  it.skipIf(process.platform === "win32")("rejects a non-regular socket before opening its contents", async () => {
    await withTempPmPath(async (context) => {
      const socket = createServer();
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.listen(path.join(context.pmPath, "special-entry"), resolve);
      });
      try {
        await expect(previewItemMutations({ pmRoot: context.pmPath, transactionId: "special-preview", author: "snapshot-agent", mutations: [{ op: "create", id: "pm-special", options: { title: "Special preview", type: "Task" } }] })).rejects.toThrow("Transaction preview requires regular files and directories");
      } finally {
        await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
      }
    });
  });

  it.skipIf(process.platform === "win32")("preserves a persistent dangling symlink error rather than advising retry", async () => {
    await withTempPmPath(async (context) => {
      await symlink(path.join(context.pmPath, "missing-target"), path.join(context.pmPath, "dangling-link"));
      await expect(previewItemMutations({ pmRoot: context.pmPath, transactionId: "dangling-path", author: "snapshot-agent", mutations: [{ op: "create", id: "pm-dangling", options: { title: "Dangling preview", type: "Task" } }] })).rejects.toMatchObject({ code: "ENOENT", path: path.join(context.pmPath, "dangling-link") });
    });
  });
});
