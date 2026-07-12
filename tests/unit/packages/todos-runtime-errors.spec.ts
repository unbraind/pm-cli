import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Drive the export/import error branches in the built-in todos runtime
 * (packages/pm-todos/extensions/todos/runtime.ts) that real-fs setups cannot
 * reach deterministically:
 *   - locateItem returns null for a listed id (todos_export_missing_item)
 *   - readLocatedItem throws for a located id (todos_export_read_failed)
 *   - a candidate todo markdown file cannot be read during import
 *   - the item-type registry fallback chain for unknown todo types
 *
 * Each requires the listed/located/read views to disagree, so we partial-mock
 * the SDK and node:fs/promises and import the runtime fresh so the mock binds.
 */

const SDK_SPECIFIER = "../../../src/sdk/index.js";
const FS_PROMISES_SPECIFIER = "node:fs/promises";

const tempRoots: string[] = [];

afterEach(async () => {
  vi.resetModules();
  vi.doUnmock(SDK_SPECIFIER);
  vi.doUnmock(FS_PROMISES_SPECIFIER);
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

describe("todos runtime export/import error branches", () => {
  it("warns on missing-item and read-failed items while exporting healthy ones", async () => {
    const pmRoot = await mkdtemp(path.join(os.tmpdir(), "pm-todos-export-errors-"));
    tempRoots.push(pmRoot);

    const actual = await vi.importActual<typeof import("../../../src/sdk/index.js")>("../../../src/sdk/index.js");

    const listed = [
      { id: "pm-missing", type: "Task" },
      { id: "pm-readfail", type: "Task" },
      { id: "pm-healthy", type: "Task" },
    ];

    vi.doMock(SDK_SPECIFIER, () => ({
      ...actual,
      resolvePmRoot: () => pmRoot,
      ensureTrackerInitialized: () => undefined,
      readSettings: async () => ({
        id_prefix: "pm-",
        item_format: "md",
        type_to_folder: { Task: "tasks" },
      }),
      resolveItemTypeRegistry: () => ({
        types: ["Task"],
        type_to_folder: { Task: "tasks" },
      }),
      getActiveExtensionRegistrations: () => undefined,
      listAllItemMetadata: async () => listed,
      locateItem: async (_root: string, id: string) => {
        if (id === "pm-missing") {
          return null;
        }
        return { id, type: "Task", itemPath: path.join(pmRoot, "tasks", `${id}.md`), item_format: "md" };
      },
      readLocatedItem: async (located: { id: string }) => {
        if (located.id === "pm-readfail") {
          throw new Error("synthetic read failure");
        }
        return {
          raw: "{}\n",
          document: {
            metadata: { id: located.id, title: "Healthy", type: "Task" },
            body: "healthy body",
          },
        };
      },
      writeFileAtomic: async () => undefined,
      runActiveOnWriteHooks: async () => [],
    }));

    const runtime = await import("../../../packages/pm-todos/extensions/todos/runtime.ts");
    const exported = await runtime.runTodosExport({ folder: path.join(pmRoot, "out") }, {} as never);

    expect(exported.ok).toBe(true);
    expect(exported.exported).toBe(1);
    expect(exported.ids).toEqual(["pm-healthy"]);
    expect(exported.warnings).toContain("todos_export_missing_item:pm-missing");
    expect(exported.warnings).toContain("todos_export_read_failed:pm-readfail");
  });

  it("warns when a candidate todo markdown file cannot be read during import", async () => {
    const pmRoot = await mkdtemp(path.join(os.tmpdir(), "pm-todos-import-readfail-"));
    tempRoots.push(pmRoot);

    const actualSdk = await vi.importActual<typeof import("../../../src/sdk/index.js")>("../../../src/sdk/index.js");
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

    vi.doMock(SDK_SPECIFIER, () => ({
      ...actualSdk,
      resolvePmRoot: () => pmRoot,
      ensureTrackerInitialized: () => undefined,
      readSettings: async () => ({
        id_prefix: "pm-",
        item_format: "md",
        type_to_folder: { Task: "tasks" },
        author_default: "tester",
      }),
      resolveItemTypeRegistry: () => ({
        types: ["Task"],
        type_to_folder: { Task: "tasks" },
      }),
      getActiveExtensionRegistrations: () => undefined,
      runActiveOnReadHooks: async () => [],
    }));

    const dirent = { name: "unreadable.md", isFile: () => true } as unknown;

    vi.doMock(FS_PROMISES_SPECIFIER, () => ({
      ...actualFs,
      default: {
        ...actualFs,
        readdir: async () => [dirent],
        readFile: async () => {
          throw new Error("synthetic read failure");
        },
      },
      readdir: async () => [dirent],
      readFile: async () => {
        throw new Error("synthetic read failure");
      },
    }));

    const runtime = await import("../../../packages/pm-todos/extensions/todos/runtime.ts");
    const imported = await runtime.runTodosImport({ folder: path.join(pmRoot, "todos") }, {} as never);

    expect(imported.ok).toBe(true);
    expect(imported.imported).toBe(0);
    expect(imported.warnings).toContain("todos_import_read_failed:unreadable.md");
  });

  it("falls back through the item-type registry chain for unknown todo types", async () => {
    for (const typeNames of [["Story"], [] as string[]]) {
      vi.resetModules();
      const pmRoot = await mkdtemp(path.join(os.tmpdir(), "pm-todos-import-typefallback-"));
      tempRoots.push(pmRoot);

      const actualSdk = await vi.importActual<typeof import("../../../src/sdk/index.js")>("../../../src/sdk/index.js");
      const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

      vi.doMock(SDK_SPECIFIER, () => ({
        ...actualSdk,
        resolvePmRoot: () => pmRoot,
        ensureTrackerInitialized: () => undefined,
        readSettings: async () => ({
          id_prefix: "pm-",
          item_format: "md",
          type_to_folder: {},
          author_default: "tester",
        }),
        resolveItemTypeRegistry: () => ({ types: typeNames, type_to_folder: {} }),
        getActiveExtensionRegistrations: () => undefined,
        runActiveOnReadHooks: async () => [],
        // Returning a located item bails importTodoCandidate AFTER toItemType ran,
        // so the heavy commit path is skipped while the fallback chain executes.
        locateItem: async () => ({ id: "pm-known", type: "Task", itemPath: "x", item_format: "md" }),
      }));

      const dirent = { name: "known.md", isFile: () => true } as unknown;
      const todoContent = `${JSON.stringify({ id: "known", title: "Known", type: "definitely-unknown-type" })}\n`;

      vi.doMock(FS_PROMISES_SPECIFIER, () => ({
        ...actualFs,
        default: { ...actualFs, readdir: async () => [dirent], readFile: async () => todoContent },
        readdir: async () => [dirent],
        readFile: async () => todoContent,
      }));

      const runtime = await import("../../../packages/pm-todos/extensions/todos/runtime.ts");
      const imported = await runtime.runTodosImport({ folder: path.join(pmRoot, "todos") }, {} as never);
      expect(imported.warnings).toContain("todos_import_item_exists:pm-known");

      vi.doUnmock(SDK_SPECIFIER);
      vi.doUnmock(FS_PROMISES_SPECIFIER);
    }
  });
});
