import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import type * as fsPromises from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:net";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commitItemMutations, previewItemMutations } from "../../../../src/sdk/item-transaction.js";
import type { PmSettings } from "../../../../src/types/index.js";
import { createEmptyExtensionRegistrationRegistry, getActiveExtensionRegistrations, setActiveExtensionRegistrations } from "../../../../src/core/extensions/index.js";
import { PM_CONTEXT_INTENTS_FILE } from "../../../../src/sdk/context-intent-runtime.js";
import { getSessionStatePath, setFocusedItem } from "../../../../src/core/session/session-state.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

const copying = vi.hoisted(() => ({ change: "none", configurationSource: "", transientNamespace: "" }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>();
  return { ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (copying.change === "unavailable-root" && String(args[0]) === path.parse(path.resolve(String(args[0]))).root) throw Object.assign(new Error("Unavailable filesystem root"), { code: "ENOENT" });
      if (copying.change === "denied-lookup" && String(args[0]).endsWith(`${path.sep}snapshot-probe.txt${path.sep}child`)) throw Object.assign(new Error("Ancestor lookup denied"), { code: "EACCES" });
      try { return await actual.lstat(...args); }
      catch (error) {
        // Windows reports ENOENT below a regular file where POSIX reports ENOTDIR.
        if (copying.change === "invalid-lookup" && (error as NodeJS.ErrnoException).code === "ENOTDIR") {
          throw Object.assign(error as Error, { code: "ENOENT" });
        }
        throw error;
      }
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      if ((copying.change === "opened-pipe" && String(args[0]).endsWith("snapshot-probe.txt")) || (copying.change === "opened-configuration-pipe" && String(args[0]).endsWith("settings.json"))) {
        await actual.rm(args[0]);
        execFileSync("mkfifo", [String(args[0])]);
      }
      return actual.open(...args);
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (copying.change.startsWith("stream") && String(args[0]).endsWith("snapshot-probe.txt")) throw new Error("Whole-file buffering is forbidden for this large fixture");
      return actual.readFile(...args);
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      await actual.writeFile(...args);
      if (copying.change === "configuration-race" && String(args[0]).includes(`${path.sep}configuration${path.sep}`) && String(args[0]).endsWith("types.json")) {
        await actual.writeFile(path.join(copying.configurationSource, "schema", "types.json"), JSON.stringify({ definitions: [{ name: "Concurrent", folder: "concurrent" }] }));
      }
    },
    cp: async (...args: Parameters<typeof actual.cp>) => {
      if (copying.change === "permission") throw Object.assign(new Error("Synthetic read denial"), { code: "EACCES" });
      if (copying.change === "invalid-path") throw Object.assign(new Error("Invalid nested path"), { code: "ENOTDIR", path: path.join(String(args[0]), "snapshot-probe.txt", "child") });
      if (copying.change === "missing-no-path") throw Object.assign(new Error("Missing path without filesystem provenance"), { code: "ENOENT" });
      if (copying.change === "invalid-lookup") throw Object.assign(new Error("Missing invalid nested path"), { code: "ENOENT", path: path.join(String(args[0]), "snapshot-probe.txt", "child") });
      if (copying.change === "existing-root") throw Object.assign(new Error("Missing path reported for an existing filesystem root"), { code: "ENOENT", path: path.parse(String(args[0])).root });
      if (copying.change === "unavailable-root") throw Object.assign(new Error("Unavailable filesystem root"), { code: "ENOENT", path: path.parse(String(args[0])).root });
      if (copying.change === "root-descendant") throw Object.assign(new Error("Vanished mounted ancestor"), { code: "ENOENT", path: path.join(path.parse(String(args[0])).root, `pm-preview-absent-${process.pid}`) });
      if (copying.change === "denied-lookup") throw Object.assign(new Error("Missing path whose ancestor cannot be checked"), { code: "ENOENT", path: path.join(String(args[0]), "snapshot-probe.txt", "child") });
      if (copying.change === "disappearing") {
        const originalFilter = args[2]?.filter;
        await actual.cp(args[0], args[1], { ...args[2], filter: async (source, destination) => {
          if (path.basename(source) === "snapshot-probe.txt") await actual.rm(source);
          return originalFilter ? originalFilter(source, destination) : true;
        } });
        return;
      }
      await actual.cp(...args);
      const changes: Record<string, readonly [string, string]> = {
        search: [path.join("search", "snapshot-probe.txt"), "rebuilt index"],
        "unrelated-change": [path.join("project", "source.txt"), "edited project source"],
        "custom-folder-change": [path.join("project", "tracked", "experiments", "pm-custom.toon"), "concurrent item change"],
        "configured-schema-change": [path.join("project", "tracked", "types.json"), "concurrent schema change"],
        "context-intents": [PM_CONTEXT_INTENTS_FILE, JSON.stringify({ intents: [] })],
        "changed-session": [path.relative(String(args[0]), getSessionStatePath(String(args[0]))), JSON.stringify({ focused_item: "pm-later-focus" })],
        "unrelated-runtime": [path.join("runtime", "snapshot-probe.txt"), "updated unrelated runtime"],
        source: ["snapshot-probe.txt", "changed"],
        staged: ["snapshot-probe.txt", "changed"],
      };
      const change = changes[copying.change];
      if (change) await actual.writeFile(path.join(String(copying.change === "staged" ? args[1] : args[0]), change[0]), change[1]);
      else if (copying.change === "namespace-cache") await actual.writeFile(path.join(String(args[0]), copying.transientNamespace, "derived-cache.json"), "rebuilt cache");
      else if (copying.change === "stream-tail-change") {
        const file = await actual.open(path.join(String(args[1]), "snapshot-probe.txt"), "r+");
        try { await file.write(Buffer.from("Z"), 0, 1, 2 * 1024 * 1024 - 1); }
        finally { await file.close(); }
      }
    },
  };
});
afterEach(() => { copying.change = "none"; copying.configurationSource = ""; copying.transientNamespace = ""; });

describe("semantic preview snapshot consistency", () => {
  it("ignores a search-index rebuild during staging without writing source items", async () => {
    await withTempPmPath(async (context) => {
      await writeFile(path.join(context.pmPath, "search", "snapshot-probe.txt"), "old index");
      const settings = await readFile(path.join(context.pmPath, "settings.json"), "utf8");
      copying.change = "search";
      await expect(previewItemMutations({ pmRoot: context.pmPath, transactionId: "search-cache", author: "snapshot-agent", mutations: [{ op: "create", id: "pm-cache", options: { title: "Cache-independent preview", type: "Task" } }] })).resolves.toMatchObject({ validated: true, state: "staged_snapshot" });
      expect(await readFile(path.join(context.pmPath, "settings.json"), "utf8")).toBe(settings);
      expect(await readFile(path.join(context.pmPath, "search", "snapshot-probe.txt"), "utf8")).toBe("rebuilt index");
      expect(context.runCli(["get", "pm-cache", "--json"]).code).toBe(3);
    });
  });

  for (const change of ["unrelated-link", "unrelated-change", "custom-folder-change", "configured-schema-change", "settings-folder", "extension-folder"]) {
  it.skipIf(process.platform === "win32" && change === "unrelated-link")(`bounds root-layout snapshots to configured tracker storage: ${change}`, async () => {
    await withTempPmPath(async (context) => {
      const rootLayout = path.join(context.tempRoot, "root-layout");
      await cp(context.pmPath, rootLayout, { recursive: true });
      await mkdir(path.join(rootLayout, "project", "tracked"), { recursive: true });
      const settings = JSON.parse(await readFile(path.join(rootLayout, "settings.json"), "utf8")) as PmSettings;
      settings.schema.files.types = "project/tracked/types.json";
      await writeFile(path.join(rootLayout, "settings.json"), JSON.stringify(settings));
      await writeFile(path.join(rootLayout, "project", "tracked", "types.json"), JSON.stringify({ definitions: [{ name: "Experiment", folder: "project/tracked/experiments" }] }));
      expect(context.runCli(["--pm-path", rootLayout, "create", "Experiment", "Existing experiment", "--id", "custom", "--json"]).code).toBe(0);
      if (change.endsWith("-folder")) {
        await writeFile(path.join(rootLayout, "project", "tracked", "types.json"), "[]");
        if (change === "settings-folder") {
          settings.item_types.definitions = [{ name: "Experiment", folder: "project/tracked/experiments" }];
          await writeFile(path.join(rootLayout, "settings.json"), JSON.stringify(settings));
        }
      }
      await writeFile(path.join(rootLayout, "project", "source.txt"), "unrelated project source");
      if (change === "unrelated-link") await symlink(context.tempRoot, path.join(rootLayout, "project", "linked-source"));
      const before = await readFile(path.join(rootLayout, "project", "tracked", "experiments", "pm-custom.toon"), "utf8");
      copying.change = change;
      const registrations = getActiveExtensionRegistrations();
      if (change === "extension-folder") setActiveExtensionRegistrations({ ...createEmptyExtensionRegistrationRegistry(), item_types: [{ layer: "project", name: "experiment-type", types: [{ name: "Experiment", folder: "project/tracked/experiments" }] }] });
      try {
        const preview = previewItemMutations({ pmRoot: rootLayout, transactionId: "root-layout", author: "snapshot-agent", mutations: [{ op: "update", id: "pm-custom", options: { title: "Staged experiment title" } }] });
        if (["custom-folder-change", "configured-schema-change"].includes(change)) await expect(preview).rejects.toMatchObject({ exitCode: 4, context: { code: "transaction_preview_snapshot_changed" } });
        else {
          await expect(preview).resolves.toMatchObject({ validated: true, state: "staged_snapshot" });
          expect(await readFile(path.join(rootLayout, "project", "tracked", "experiments", "pm-custom.toon"), "utf8")).toBe(before);
        }
      } finally { setActiveExtensionRegistrations(registrations); }
    });
  });
  }

  for (const mode of ["absolute-inside", "optional-types", "empty-schema", "external-file", "root-directory", "linked-parent", "schema-directory", "search-schema"]) {
  it.skipIf(process.platform === "win32" && mode === "linked-parent")(`contains configured schema reads and scaffolding: ${mode}`, async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as PmSettings;
      const outside = path.join(context.tempRoot, "outside");
      await mkdir(outside);
      const outsideSchema = path.join(outside, "statuses.json");
      await writeFile(outsideSchema, "[]");
      if (mode === "absolute-inside") {
        settings.schema.files.statuses = path.join(context.pmPath, "schema", "missing-statuses.json");
      } else if (mode === "optional-types") settings.schema.files.types = "schema/missing-types.json";
      else if (mode === "empty-schema") settings.schema.files.statuses = " ";
      else if (mode === "external-file") settings.schema.files.statuses = outsideSchema;
      else if (mode === "root-directory") settings.schema.files.statuses = context.pmPath;
      else if (mode === "linked-parent") {
        await symlink(outside, path.join(context.pmPath, "linked-schema"));
        settings.schema.files.statuses = "linked-schema/statuses.json";
      } else if (mode === "schema-directory") settings.schema.files.statuses = "schema";
      else {
        settings.schema.files.statuses = "search/configured-statuses.json";
        await writeFile(path.join(context.pmPath, "search", "configured-statuses.json"), "[]");
      }
      await writeFile(settingsPath, JSON.stringify(settings));
      const before = await readFile(settingsPath, "utf8");
      const preview = previewItemMutations({ pmRoot: context.pmPath, transactionId: "schema-boundary", author: "snapshot-agent", mutations: [{ op: "create", id: "pm-schema", options: { title: "Contained schema preview", type: "Task" } }] });
      if (["absolute-inside", "optional-types", "empty-schema", "search-schema"].includes(mode)) await expect(preview).resolves.toMatchObject({ validated: true });
      else if (["external-file", "root-directory"].includes(mode)) await expect(preview).rejects.toMatchObject({ exitCode: 2, context: { code: "transaction_preview_external_schema" } });
      else await expect(preview).rejects.toThrow("Transaction preview requires regular files and directories");
      expect(await readFile(settingsPath, "utf8")).toBe(before);
      expect(await readFile(outsideSchema, "utf8")).toBe("[]");
      await expect(readFile(path.join(context.pmPath, "schema", "missing-statuses.json"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(path.join(context.pmPath, "schema", "missing-types.json"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
  }

  it.each(["missing", "invalid-json", "invalid-schema"])("preserves settings diagnostics and fallback without repairing source settings: %s", async (mode) => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const contents = mode === "invalid-json" ? "{" : "{}";
      if (mode === "missing") await rm(settingsPath);
      else await writeFile(settingsPath, contents);
      const preview = previewItemMutations({ pmRoot: context.pmPath, transactionId: "fallback-settings", author: "snapshot-agent", mutations: [{ op: "create", id: "pm-fallback", options: { title: "Fallback settings preview", type: "Task" } }] });
      if (mode === "missing") await expect(preview).rejects.toMatchObject({ exitCode: 3, context: { code: "tracker_not_initialized", reason: "settings_missing" } });
      else await expect(preview).resolves.toMatchObject({ validated: true });
      if (mode === "missing") await expect(readFile(settingsPath)).rejects.toMatchObject({ code: "ENOENT" });
      else expect(await readFile(settingsPath, "utf8")).toBe(contents);
      await expect(readFile(path.join(context.pmPath, "tasks", "pm-fallback.toon"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("rejects configuration changes between storage discovery and the first snapshot fingerprint", async () => {
    await withTempPmPath(async (context) => {
      copying.change = "configuration-race";
      copying.configurationSource = context.pmPath;
      await expect(previewItemMutations({ pmRoot: context.pmPath, transactionId: "configuration-capture", author: "snapshot-agent", mutations: [{ op: "create", id: "pm-config-race", options: { title: "Configuration-consistent preview", type: "Task" } }] })).rejects.toMatchObject({ exitCode: 4, context: { code: "transaction_preview_snapshot_changed" } });
    });
  });

  it.each(["invalid-json", "changed"])("retains root-layout context-intent declarations during preview: %s", async (mode) => {
    await withTempPmPath(async (context) => {
      const rootLayout = path.join(context.tempRoot, "root-layout");
      await cp(context.pmPath, rootLayout, { recursive: true });
      const declaration = path.join(rootLayout, PM_CONTEXT_INTENTS_FILE);
      await writeFile(declaration, mode === "invalid-json" ? "{" : "[]");
      const settings = await readFile(path.join(rootLayout, "settings.json"), "utf8");
      if (mode === "changed") copying.change = "context-intents";
      const preview = previewItemMutations({ pmRoot: rootLayout, transactionId: "context-intents", author: "snapshot-agent", mutations: [{ op: "create", id: "pm-intents", options: { title: "Context-aware preview", type: "Task" } }] });
      if (mode === "changed") await expect(preview).rejects.toMatchObject({ exitCode: 4, context: { code: "transaction_preview_snapshot_changed" } });
      else await expect(preview).rejects.toThrow(`Invalid ${PM_CONTEXT_INTENTS_FILE}`);
      expect(await readFile(path.join(rootLayout, "settings.json"), "utf8")).toBe(settings);
      expect(await readFile(declaration, "utf8")).toBe(mode === "invalid-json" ? "{" : JSON.stringify({ intents: [] }));
      await expect(readFile(path.join(rootLayout, "tasks", "pm-intents.toon"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  for (const mode of ["stale-parent", "explicit-parent", "changed-session", "unrelated-runtime", "session-link", "session-directory"]) {
  it.skipIf(process.platform === "win32" && mode === "session-link")(`preserves core focus semantics while excluding unrelated runtime state: ${mode}`, async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as PmSettings;
      settings.validation.parent_reference = "strict_error";
      await writeFile(settingsPath, JSON.stringify(settings));
      await setFocusedItem(context.pmPath, "pm-missing-focus");
      const sessionPath = getSessionStatePath(context.pmPath);
      if (mode.startsWith("session-")) {
        await rm(sessionPath);
        if (mode === "session-link") {
          const outside = path.join(context.tempRoot, "outside-session.json");
          await writeFile(outside, "{}");
          await symlink(outside, sessionPath);
        } else await mkdir(sessionPath);
      }
      copying.change = mode;
      const options = { pmRoot: context.pmPath, transactionId: "focused-preview", author: "snapshot-agent", mutations: [{ op: "create" as const, id: "pm-child", options: { title: "Focus-aware child", type: "Task", ...(mode === "stale-parent" ? {} : { parent: "none" }) } }] };
      const preview = previewItemMutations(options);
      if (mode === "stale-parent") {
        await expect(preview).rejects.toMatchObject({ exitCode: 2, context: { transaction_operation: { index: 0, op: "create", id: "pm-child" } } });
        await expect(commitItemMutations(options)).rejects.toThrow('Parent item "pm-missing-focus" was not found');
      } else if (mode === "changed-session") await expect(preview).rejects.toMatchObject({ exitCode: 4, context: { code: "transaction_preview_snapshot_changed" } });
      else if (mode.startsWith("session-")) await expect(preview).rejects.toThrow("Transaction preview requires regular files and directories");
      else await expect(preview).resolves.toMatchObject({ validated: true });
      if (!mode.startsWith("session-")) expect(await readFile(sessionPath, "utf8")).toBe(JSON.stringify({ focused_item: mode === "changed-session" ? "pm-later-focus" : "pm-missing-focus" }));
      await expect(readFile(path.join(context.pmPath, "tasks", "pm-child.toon"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
  }

  it.each(["search", "runtime", "locks"])("retains registered item folders under %s while excluding derived siblings", async (namespace) => {
    await withTempPmPath(async (context) => {
      const rootLayout = path.join(context.tempRoot, "root-layout");
      await cp(context.pmPath, rootLayout, { recursive: true });
      const settingsPath = path.join(rootLayout, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as PmSettings;
      settings.item_types.definitions = [{ name: "Experiment", folder: `${namespace}/experiments` }];
      await writeFile(settingsPath, JSON.stringify(settings));
      expect(context.runCli(["--pm-path", rootLayout, "create", "Experiment", "Existing experiment", "--id", "experiment", "--json"]).code).toBe(0);
      const itemPath = path.join(rootLayout, namespace, "experiments", "pm-experiment.toon");
      const before = await readFile(itemPath, "utf8");
      await writeFile(path.join(rootLayout, namespace, "derived-cache.json"), "old cache");
      copying.change = "namespace-cache";
      copying.transientNamespace = namespace;
      const options = { pmRoot: rootLayout, transactionId: "registered-storage", author: "snapshot-agent", mutations: [{ op: "update" as const, id: "pm-experiment", options: { title: "Updated experiment" } }, { op: "create" as const, id: "pm-next", options: { title: "Next experiment", type: "Experiment" } }] };
      await expect(previewItemMutations(options)).resolves.toMatchObject({ validated: true });
      expect(await readFile(itemPath, "utf8")).toBe(before);
      expect(await readFile(path.join(rootLayout, namespace, "derived-cache.json"), "utf8")).toBe("rebuilt cache");
      await expect(readFile(path.join(rootLayout, namespace, "experiments", "pm-next.toon"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(commitItemMutations(options)).resolves.toMatchObject({ status: "committed" });
      expect(await readFile(itemPath, "utf8")).toContain("Updated experiment");
      expect(await readFile(path.join(rootLayout, namespace, "experiments", "pm-next.toon"), "utf8")).toContain("Next experiment");
    });
  });

  it.each(["source", "staged", "disappearing", "root-descendant"])("rejects %s state changes during copying instead of validating a mixed snapshot", async (change) => {
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
  it.each(["invalid-path", "missing-no-path", "invalid-lookup", "existing-root", "unavailable-root", "denied-lookup"])("preserves persistent or unattributed path errors: %s", async (change) => {
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

  it.skipIf(process.platform === "win32").each(["opened-pipe", "opened-configuration-pipe"])("refuses a regular file replaced by a pipe before opening without waiting for a writer: %s", async (mode) => {
    await withTempPmPath(async (context) => {
      await writeFile(path.join(context.pmPath, "snapshot-probe.txt"), "regular file");
      copying.change = mode;
      await expect(previewItemMutations({ pmRoot: context.pmPath, transactionId: "pipe-race", author: "snapshot-agent", mutations: [{ op: "create", id: "pm-pipe", options: { title: "Pipe preview", type: "Task" } }] })).rejects.toThrow("Transaction preview requires regular files and directories");
    });
  });

  it.skipIf(process.platform === "win32")("accepts an explicitly selected linked tracker root as the snapshot boundary", async () => {
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
