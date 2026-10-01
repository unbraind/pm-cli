import { symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { previewItemMutations } from "../../../../src/sdk/item-transaction.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

const copying = vi.hoisted(() => ({ change: "none" }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual,
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

  it.skipIf(process.platform === "win32")("preserves a persistent dangling symlink error rather than advising retry", async () => {
    await withTempPmPath(async (context) => {
      await symlink(path.join(context.pmPath, "missing-target"), path.join(context.pmPath, "dangling-link"));
      await expect(previewItemMutations({ pmRoot: context.pmPath, transactionId: "dangling-path", author: "snapshot-agent", mutations: [{ op: "create", id: "pm-dangling", options: { title: "Dangling preview", type: "Task" } }] })).rejects.toMatchObject({ code: "ENOENT", path: path.join(context.pmPath, "dangling-link") });
    });
  });
});
