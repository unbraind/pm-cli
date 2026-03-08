import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireLock } from "../../src/core/lock/lock.js";
import { clearActiveExtensionHooks, setActiveExtensionHooks } from "../../src/core/extensions/index.js";
import { splitFrontMatter } from "../../src/core/item/item-format.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import { runTodosExport, runTodosImport } from "../../src/extensions/builtins/todos/import-export.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

async function writeTodoMarkdown(
  folder: string,
  filename: string,
  frontMatter: Record<string, unknown> | string,
  body = "",
): Promise<void> {
  const frontMatterText = typeof frontMatter === "string" ? frontMatter : JSON.stringify(frontMatter, null, 2);
  const content = body.length > 0 ? `${frontMatterText}\n\n${body}\n` : `${frontMatterText}\n`;
  await writeFile(path.join(folder, filename), content, "utf8");
}

describe("built-in todos extension import/export", () => {
  afterEach(() => {
    clearActiveExtensionHooks();
  });

  it("rejects import and export when tracker storage is not initialized", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-cli-todos-no-init-"));
    const pmPath = path.join(tempRoot, ".agents", "pm");
    try {
      await expect(runTodosImport({}, { path: pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
      await expect(runTodosExport({}, { path: pmPath })).rejects.toMatchObject({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("returns not-found when todos import source folder is missing", async () => {
    await withTempPmPath(async (context) => {
      const missingFolder = path.join(context.tempRoot, "missing-todos-source");
      await expect(runTodosImport({ folder: missingFolder }, {})).rejects.toMatchObject({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    });
  });

  it("imports todos markdown files with deterministic PM defaults", async () => {
    await withTempPmPath(async (context) => {
      const sourceFolder = path.join(context.tempRoot, "todos-source");
      await mkdir(sourceFolder, { recursive: true });

      await writeFile(
        path.join(sourceFolder, "todo-one.md"),
        `${JSON.stringify(
          {
            id: "todo-one",
            title: "Todos Import One",
            status: "blocked",
            tags: ["todos", "import"],
            created_at: "2026-02-01T10:00:00.000Z",
            assignee: "todos-author",
            dependencies: [],
            comments: [],
            notes: [],
            learnings: [],
            files: [],
            docs: [],
            tests: [],
          },
          null,
          2,
        )}\n\nImported body one.\n`,
        "utf8",
      );
      await writeFile(
        path.join(sourceFolder, "todo-missing-title.md"),
        `${JSON.stringify(
          {
            id: "todo-missing-title",
            status: "open",
            tags: ["todos"],
          },
          null,
          2,
        )}\n\nMissing title should be skipped.\n`,
        "utf8",
      );

      const imported = await runTodosImport(
        {
          folder: sourceFolder,
          author: "unit-test",
          message: "Unit todos import",
        },
        {},
      );
      expect(imported.ok).toBe(true);
      expect(imported.folder).toBe(sourceFolder);
      expect(imported.imported).toBe(1);
      expect(imported.skipped).toBe(1);
      expect(imported.ids).toEqual(["pm-todo-one"]);
      expect(imported.warnings).toContain("todos_import_missing_title:todo-missing-title.md");

      const getImported = context.runCli(["get", "pm-todo-one", "--json"], { expectJson: true });
      expect(getImported.code).toBe(0);
      const getImportedJson = getImported.json as {
        item: { type: string; status: string; priority: number; description: string };
        body: string;
      };
      expect(getImportedJson.item.type).toBe("Task");
      expect(getImportedJson.item.status).toBe("blocked");
      expect(getImportedJson.item.priority).toBe(2);
      expect(getImportedJson.item.description).toBe("");
      expect(getImportedJson.body).toBe("Imported body one.");

      const history = context.runCli(["history", "pm-todo-one", "--json"], { expectJson: true });
      expect(history.code).toBe(0);
      const historyJson = history.json as { history: Array<{ op: string }> };
      expect(historyJson.history.some((entry) => entry.op === "import")).toBe(true);
    });
  });

  it("imports confidence variants and drops invalid confidence values", async () => {
    await withTempPmPath(async (context) => {
      const sourceFolder = path.join(context.tempRoot, "todos-confidence-source");
      await mkdir(sourceFolder, { recursive: true });

      await writeTodoMarkdown(sourceFolder, "confidence-number.md", {
        id: "confidence-number",
        title: "Confidence Number",
        confidence: 44,
      });
      await writeTodoMarkdown(sourceFolder, "confidence-text.md", {
        id: "confidence-text",
        title: "Confidence Text",
        confidence: "high",
      });
      await writeTodoMarkdown(sourceFolder, "confidence-empty.md", {
        id: "confidence-empty",
        title: "Confidence Empty",
        confidence: "   ",
      });
      await writeTodoMarkdown(sourceFolder, "confidence-invalid.md", {
        id: "confidence-invalid",
        title: "Confidence Invalid",
        confidence: "uncertain",
      });

      const imported = await runTodosImport({ folder: sourceFolder }, {});
      expect(imported.imported).toBe(4);
      expect(imported.skipped).toBe(0);

      const numberItem = context.runCli(["get", "pm-confidence-number", "--json"], { expectJson: true });
      expect(numberItem.code).toBe(0);
      expect((numberItem.json as { item: { confidence?: number } }).item.confidence).toBe(44);

      const textItem = context.runCli(["get", "pm-confidence-text", "--json"], { expectJson: true });
      expect(textItem.code).toBe(0);
      expect((textItem.json as { item: { confidence?: string } }).item.confidence).toBe("high");

      const emptyItem = context.runCli(["get", "pm-confidence-empty", "--json"], { expectJson: true });
      expect(emptyItem.code).toBe(0);
      expect("confidence" in (emptyItem.json as { item: Record<string, unknown> }).item).toBe(false);

      const invalidItem = context.runCli(["get", "pm-confidence-invalid", "--json"], { expectJson: true });
      expect(invalidItem.code).toBe(0);
      expect("confidence" in (invalidItem.json as { item: Record<string, unknown> }).item).toBe(false);
    });
  });

  it("covers import fallback branches, lock conflicts, and deterministic warnings", async () => {
    await withTempPmPath(async (context) => {
      const sourceFolder = path.join(context.tempRoot, "todos-branch-source");
      await mkdir(sourceFolder, { recursive: true });

      await writeFile(path.join(context.pmPath, "tasks", "pm-existing-import.md"), "{}\n", "utf8");

      await writeTodoMarkdown(sourceFolder, "01-invalid-json.md", "{ invalid-json");
      await writeTodoMarkdown(sourceFolder, "02-array-frontmatter.md", "[]", "Invalid object");
      await writeTodoMarkdown(sourceFolder, "03-no-frontmatter.md", "Plain markdown body only.");
      await writeTodoMarkdown(sourceFolder, "04-missing-title.md", {
        id: "missing-title",
        status: "open",
      });
      await writeTodoMarkdown(sourceFolder, "05-existing-id.md", {
        id: "existing-import",
        title: "Existing should skip",
      });
      await writeTodoMarkdown(sourceFolder, "06-lock-conflict.md", {
        id: "lock-conflict",
        title: "Lock conflict candidate",
      });
      await writeTodoMarkdown(
        sourceFolder,
        ".md",
        {
          title: "Generated hidden filename id",
          status: "not-a-status",
          type: "not-a-type",
          priority: "9",
          tags: "one,Two,one",
          estimated_minutes: "15",
          created_at: "not-an-iso",
          updated_at: "also-not-an-iso",
          author: "   ",
          description: "   ",
          deadline: "not-a-date",
          confidence: "73",
        },
        "  generated body with trailing spaces   ",
      );
      await writeTodoMarkdown(
        sourceFolder,
        "07-typed-item.md",
        {
          id: "typed-item",
          title: "Typed item",
          type: "issue",
          status: "closed",
          priority: "3",
          tags: ["Beta", "alpha", "beta", ""],
          created_at: "2026-02-05T00:00:00.000Z",
          updated_at: "2026-02-06T00:00:00.000Z",
          assignee: "typed-author",
          deadline: "2026-02-07T00:00:00.000Z",
          confidence: "med",
          acceptance_criteria: "Typed acceptance",
          close_reason: "done",
          estimated_minutes: 20,
        },
        "typed body",
      );
      await writeTodoMarkdown(sourceFolder, "tagless.md", {
        title: "Tagless",
        priority: 4,
        tags: 42,
        estimated_minutes: "invalid-number",
      });

      const previousPmAuthor = process.env.PM_AUTHOR;
      const releaseConflictLock = await acquireLock(context.pmPath, "pm-lock-conflict", 1800, "foreign-author");

      try {
        process.env.PM_AUTHOR = "   ";

        const importResult = await runTodosImport(
          {
            folder: path.relative(process.cwd(), sourceFolder),
            author: "   ",
            message: "   ",
          },
          {},
        );

        expect(importResult.ok).toBe(true);
        expect(importResult.imported).toBe(3);
        expect(importResult.skipped).toBe(6);
        expect(importResult.ids).toContain("pm-typed-item");
        expect(importResult.ids).toContain("pm-tagless");
        expect(importResult.warnings).toContain("todos_import_invalid_front_matter:01-invalid-json.md");
        expect(importResult.warnings).toContain("todos_import_invalid_front_matter:02-array-frontmatter.md");
        expect(importResult.warnings).toContain("todos_import_invalid_front_matter:03-no-frontmatter.md");
        expect(importResult.warnings).toContain("todos_import_missing_title:04-missing-title.md");
        expect(importResult.warnings).toContain("todos_import_item_exists:pm-existing-import");
        expect(importResult.warnings).toContain("todos_import_lock_conflict:pm-lock-conflict");

        const generatedId = importResult.ids.find((id) => id !== "pm-typed-item" && id !== "pm-tagless");
        expect(typeof generatedId).toBe("string");
        expect(generatedId?.startsWith("pm-")).toBe(true);

        const generated = context.runCli(["get", generatedId ?? "", "--json"], { expectJson: true });
        expect(generated.code).toBe(0);
        const generatedItem = generated.json as {
          item: {
            type: string;
            status: string;
            priority: number;
            tags: string[];
            author: string;
            estimated_minutes: number;
            description: string;
            created_at: string;
            updated_at: string;
            confidence?: number | "low" | "medium" | "high";
          };
          body: string;
        };
        expect(generatedItem.item.type).toBe("Task");
        expect(generatedItem.item.status).toBe("open");
        expect(generatedItem.item.priority).toBe(2);
        expect(generatedItem.item.tags).toEqual(["one", "two"]);
        expect(generatedItem.item.author).toBe("unknown");
        expect(generatedItem.item.estimated_minutes).toBe(15);
        expect(generatedItem.item.description).toBe("");
        expect(generatedItem.item.confidence).toBe(73);
        expect(generatedItem.item.created_at).toBe(generatedItem.item.updated_at);
        expect(generatedItem.body).toBe("  generated body with trailing spaces");

        const typed = context.runCli(["get", "pm-typed-item", "--json"], { expectJson: true });
        expect(typed.code).toBe(0);
        const typedItem = typed.json as {
          item: {
            type: string;
            status: string;
            priority: number;
            tags: string[];
            created_at: string;
            updated_at: string;
            assignee?: string;
            deadline?: string;
            confidence?: number | "low" | "medium" | "high";
            acceptance_criteria?: string;
            close_reason?: string;
            estimated_minutes?: number;
          };
          body: string;
        };
        expect(typedItem.item.type).toBe("Issue");
        expect(typedItem.item.status).toBe("closed");
        expect(typedItem.item.priority).toBe(3);
        expect(typedItem.item.tags).toEqual(["alpha", "beta"]);
        expect(typedItem.item.created_at).toBe("2026-02-05T00:00:00.000Z");
        expect(typedItem.item.updated_at).toBe("2026-02-06T00:00:00.000Z");
        expect(typedItem.item.assignee).toBe("typed-author");
        expect(typedItem.item.deadline).toBe("2026-02-07T00:00:00.000Z");
        expect(typedItem.item.confidence).toBe("medium");
        expect(typedItem.item.acceptance_criteria).toBe("Typed acceptance");
        expect(typedItem.item.close_reason).toBe("done");
        expect(typedItem.item.estimated_minutes).toBe(20);
        expect(typedItem.body).toBe("typed body");
      } finally {
        await releaseConflictLock();
        if (previousPmAuthor === undefined) {
          delete process.env.PM_AUTHOR;
        } else {
          process.env.PM_AUTHOR = previousPmAuthor;
        }
      }
    });
  });

  it("uses settings author fallback and default .pi/todos source folder", async () => {
    await withTempPmPath(async (context) => {
      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as { author_default?: string };
      settings.author_default = "settings-author";
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      const previousPmAuthor = process.env.PM_AUTHOR;
      const previousCwd = process.cwd();
      let importedId = "";
      try {
        delete process.env.PM_AUTHOR;
        process.chdir(context.tempRoot);
        const defaultFolder = path.join(context.tempRoot, ".pi", "todos");
        await mkdir(defaultFolder, { recursive: true });
        await writeTodoMarkdown(defaultFolder, "default-source.md", {
          id: "default-source",
          title: "Default source import",
        });

        const imported = await runTodosImport({ folder: "   " }, {});
        expect(imported.imported).toBe(1);
        expect(imported.ids).toEqual(["pm-default-source"]);
        importedId = imported.ids[0] ?? "";
      } finally {
        process.chdir(previousCwd);
        if (previousPmAuthor === undefined) {
          delete process.env.PM_AUTHOR;
        } else {
          process.env.PM_AUTHOR = previousPmAuthor;
        }
      }

      const importedItem = context.runCli(["get", importedId, "--json"], { expectJson: true });
      expect(importedItem.code).toBe(0);
      const importedJson = importedItem.json as { item: { author: string } };
      expect(importedJson.item.author).toBe("settings-author");
    });
  });

  it("rolls back imported item bytes when history append fails", async () => {
    await withTempPmPath(async (context) => {
      const sourceFolder = path.join(context.tempRoot, "todos-history-rollback");
      await mkdir(sourceFolder, { recursive: true });
      await writeTodoMarkdown(sourceFolder, "rollback-history.md", {
        id: "rollback-history",
        title: "Rollback history",
      });

      await mkdir(path.join(context.pmPath, "history", "pm-rollback-history.jsonl"), { recursive: true });

      await expect(runTodosImport({ folder: sourceFolder }, {})).rejects.toBeInstanceOf(Error);
      await expect(access(path.join(context.pmPath, "tasks", "pm-rollback-history.md"))).rejects.toBeDefined();
    });
  });

  it("exports PM items to todos markdown format", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Todos Export Fixture",
          "--description",
          "Fixture item for todos export",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "todos,export",
          "--body",
          "Todos export body",
          "--deadline",
          "none",
          "--estimate",
          "20",
          "--acceptance-criteria",
          "Todos export serializes mapped fields",
          "--author",
          "unit-test",
          "--message",
          "Create todos export fixture",
          "--assignee",
          "todos-export-author",
          "--dep",
          "none",
          "--comment",
          "none",
          "--note",
          "none",
          "--learning",
          "none",
          "--file",
          "none",
          "--test",
          "none",
          "--doc",
          "none",
        ],
        { expectJson: true },
      );
      expect(created.code).toBe(0);
      const id = (created.json as { item: { id: string } }).item.id;

      const destinationFolder = path.join(context.tempRoot, "todos-exported");
      const exported = await runTodosExport(
        {
          folder: destinationFolder,
        },
        {},
      );
      expect(exported.ok).toBe(true);
      expect(exported.folder).toBe(destinationFolder);
      expect(exported.exported).toBeGreaterThanOrEqual(1);
      expect(exported.ids).toContain(id);
      expect(exported.warnings).toEqual([]);

      const exportedRaw = await readFile(path.join(destinationFolder, `${id}.md`), "utf8");
      const split = splitFrontMatter(exportedRaw);
      const frontMatter = JSON.parse(split.frontMatter) as Record<string, unknown>;
      expect(frontMatter).toMatchObject({
        id,
        title: "Todos Export Fixture",
        status: "open",
        assignee: "todos-export-author",
      });
      expect(frontMatter.tags).toEqual(["export", "todos"]);
      expect(typeof frontMatter.created_at).toBe("string");
      expect(split.body.trim()).toBe("Todos export body");
    });
  });

  it("exports empty-body items without markdown body separator using relative folder path", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Todos Export Empty Body",
          "--description",
          "",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "2",
          "--tags",
          "todos,empty",
          "--body",
          "",
          "--deadline",
          "none",
          "--estimate",
          "0",
          "--acceptance-criteria",
          "",
          "--author",
          "unit-test",
          "--message",
          "Create empty body fixture",
          "--assignee",
          "none",
          "--dep",
          "none",
          "--comment",
          "none",
          "--note",
          "none",
          "--learning",
          "none",
          "--file",
          "none",
          "--test",
          "none",
          "--doc",
          "none",
        ],
        { expectJson: true },
      );
      expect(created.code).toBe(0);
      const id = (created.json as { item: { id: string } }).item.id;

      const previousCwd = process.cwd();
      try {
        process.chdir(context.tempRoot);
        const exported = await runTodosExport({ folder: "todos-relative-export" }, {});
        expect(exported.ids).toContain(id);

        const exportedRaw = await readFile(path.join(context.tempRoot, "todos-relative-export", `${id}.md`), "utf8");
        const split = splitFrontMatter(exportedRaw);
        expect(split.body).toBe("");
      } finally {
        process.chdir(previousCwd);
      }
    });
  });

  it("uses default .pi/todos export folder when folder option is blank", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Todos Export Default Folder",
          "--description",
          "",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "2",
          "--tags",
          "todos,default-folder",
          "--body",
          "default export body",
          "--deadline",
          "none",
          "--estimate",
          "0",
          "--acceptance-criteria",
          "",
          "--author",
          "unit-test",
          "--message",
          "Create default folder export fixture",
          "--assignee",
          "none",
          "--dep",
          "none",
          "--comment",
          "none",
          "--note",
          "none",
          "--learning",
          "none",
          "--file",
          "none",
          "--test",
          "none",
          "--doc",
          "none",
        ],
        { expectJson: true },
      );
      expect(created.code).toBe(0);
      const id = (created.json as { item: { id: string } }).item.id;

      const previousCwd = process.cwd();
      try {
        process.chdir(context.tempRoot);
        const exported = await runTodosExport({ folder: "   " }, {});
        expect(exported.folder).toBe(".pi/todos");
        expect(exported.ids).toContain(id);

        const exportedRaw = await readFile(path.join(context.tempRoot, ".pi", "todos", `${id}.md`), "utf8");
        expect(exportedRaw).toContain(id);
      } finally {
        process.chdir(previousCwd);
      }
    });
  });

  it("dispatches import read/write hooks and surfaces hook warnings deterministically", async () => {
    await withTempPmPath(async (context) => {
      const sourceFolder = path.join(context.tempRoot, "todos-hooked-import");
      await mkdir(sourceFolder, { recursive: true });
      await writeTodoMarkdown(sourceFolder, "hooked.md", {
        id: "hooked",
        title: "Hooked todo import",
      });

      const hookEvents: string[] = [];
      setActiveExtensionHooks({
        beforeCommand: [],
        afterCommand: [],
        onRead: [
          {
            layer: "project",
            name: "todos-read-hook",
            run: (hookContext) => {
              hookEvents.push(`read:${path.basename(hookContext.path)}`);
            },
          },
          {
            layer: "project",
            name: "todos-read-boom",
            run: () => {
              throw new Error("boom-read");
            },
          },
        ],
        onWrite: [
          {
            layer: "project",
            name: "todos-write-hook",
            run: (hookContext) => {
              hookEvents.push(`write:${hookContext.op}:${path.basename(hookContext.path)}`);
            },
          },
          {
            layer: "project",
            name: "todos-write-boom",
            run: () => {
              throw new Error("boom-write");
            },
          },
        ],
        onIndex: [],
      });

      const imported = await runTodosImport({ folder: sourceFolder }, { path: context.pmPath });
      expect(imported.ok).toBe(true);
      expect(imported.imported).toBe(1);
      expect(imported.skipped).toBe(0);
      expect(imported.ids).toEqual(["pm-hooked"]);
      expect(imported.warnings).toEqual([
        "extension_hook_failed:project:todos-read-boom:onRead",
        "extension_hook_failed:project:todos-read-boom:onRead",
        "extension_hook_failed:project:todos-write-boom:onWrite",
        "extension_hook_failed:project:todos-write-boom:onWrite",
      ]);
      expect(hookEvents).toContain("read:todos-hooked-import");
      expect(hookEvents).toContain("read:hooked.md");
      expect(hookEvents).toContain("write:import:pm-hooked.md");
      expect(hookEvents).toContain("write:import:history:pm-hooked.jsonl");
    });
  });

  it("dispatches export write hooks for generated todos markdown files", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Todos Export Hook Fixture",
          "--description",
          "",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--tags",
          "todos,hook-export",
          "--body",
          "hook export body",
          "--deadline",
          "none",
          "--estimate",
          "0",
          "--acceptance-criteria",
          "",
          "--author",
          "unit-test",
          "--message",
          "Create hook export fixture",
          "--assignee",
          "none",
          "--dep",
          "none",
          "--comment",
          "none",
          "--note",
          "none",
          "--learning",
          "none",
          "--file",
          "none",
          "--test",
          "none",
          "--doc",
          "none",
        ],
        { expectJson: true },
      );
      expect(created.code).toBe(0);
      const id = (created.json as { item: { id: string } }).item.id;

      const hookEvents: string[] = [];
      setActiveExtensionHooks({
        beforeCommand: [],
        afterCommand: [],
        onRead: [],
        onWrite: [
          {
            layer: "project",
            name: "todos-export-write-hook",
            run: (hookContext) => {
              hookEvents.push(`write:${hookContext.op}:${path.basename(hookContext.path)}`);
            },
          },
          {
            layer: "project",
            name: "todos-export-write-boom",
            run: () => {
              throw new Error("boom-export-write");
            },
          },
        ],
        onIndex: [],
      });

      const destinationFolder = path.join(context.tempRoot, "todos-export-hooks");
      const exported = await runTodosExport({ folder: destinationFolder }, { path: context.pmPath });
      expect(exported.ok).toBe(true);
      expect(exported.ids).toContain(id);
      expect(exported.warnings).toContain("extension_hook_failed:project:todos-export-write-boom:onWrite");
      expect(hookEvents).toContain(`write:todos:export:${id}.md`);
    });
  });

  it("records export warnings when located items are missing or unreadable", async () => {
    await withTempPmPath(async (context) => {
      const itemStoreModulePath = "../../src/core/store/item-store.js";
      vi.resetModules();
      vi.doMock(itemStoreModulePath, async () => {
        const actualModule = (await vi.importActual(itemStoreModulePath)) as typeof import("../../src/core/store/item-store.js");
        return {
          ...actualModule,
          listAllFrontMatter: async () => [{ id: "raw-id" }, { id: "pm-read-failed" }],
          locateItem: async (_pmRoot: string, rawId: string) => {
            if (rawId === "raw-id") {
              return null;
            }
            return {
              id: "pm-read-failed",
              type: "Task",
              itemPath: path.join(context.pmPath, "tasks", "pm-read-failed.md"),
            };
          },
          readLocatedItem: async () => {
            throw new Error("forced read failure");
          },
        };
      });

      const mockedModule = await import("../../src/extensions/builtins/todos/import-export.js");
      const exported = await mockedModule.runTodosExport(
        { folder: path.join(context.tempRoot, "todos-mocked-export") },
        { path: context.pmPath },
      );
      expect(exported.exported).toBe(0);
      expect(exported.ids).toEqual([]);
      expect(exported.warnings).toHaveLength(2);
      expect(exported.warnings).toContain("todos_export_missing_item:raw-id");
      expect(exported.warnings).toContain("todos_export_read_failed:pm-read-failed");
    });
  });

  it("marks todos markdown as invalid when split front-matter parses to non-object JSON", async () => {
    await withTempPmPath(async (context) => {
      const itemFormatModulePath = "../../src/core/item/item-format.js";
      vi.resetModules();
      vi.doMock(itemFormatModulePath, async () => {
        const actualModule = (await vi.importActual(itemFormatModulePath)) as typeof import("../../src/core/item/item-format.js");
        return {
          ...actualModule,
          splitFrontMatter: () => ({
            frontMatter: "[]",
            body: "mocked body",
          }),
        };
      });

      const mockedModule = await import("../../src/extensions/builtins/todos/import-export.js");
      const sourceFolder = path.join(context.tempRoot, "todos-mocked-frontmatter");
      await mkdir(sourceFolder, { recursive: true });
      await writeTodoMarkdown(sourceFolder, "non-object.md", { title: "Ignored by split mock" }, "ignored");

      const imported = await mockedModule.runTodosImport({ folder: sourceFolder }, { path: context.pmPath });
      expect(imported.imported).toBe(0);
      expect(imported.skipped).toBe(1);
      expect(imported.warnings).toContain("todos_import_invalid_front_matter:non-object.md");
    });
  });

  it("adds read_failed warning when source markdown cannot be read", async () => {
    await withTempPmPath(async (context) => {
      const itemFormatModulePath = "../../src/core/item/item-format.js";
      const fsModulePath = "node:fs/promises";
      vi.resetModules();
      vi.doMock(itemFormatModulePath, async () => {
        const actualModule = (await vi.importActual(itemFormatModulePath)) as typeof import("../../src/core/item/item-format.js");
        return actualModule;
      });
      vi.doMock(fsModulePath, async () => {
        const actualModule = (await vi.importActual(fsModulePath)) as typeof import("node:fs/promises");
        const mockedReadFile = async (
          targetPath: Parameters<typeof actualModule.readFile>[0],
          options?: Parameters<typeof actualModule.readFile>[1],
        ) => {
          if (String(targetPath).endsWith("unreadable.md")) {
            throw new Error("forced unreadable markdown");
          }
          return actualModule.readFile(targetPath, options as never);
        };
        return {
          ...actualModule,
          readFile: mockedReadFile,
          default: {
            ...actualModule,
            readFile: mockedReadFile,
          },
        };
      });

      const mockedModule = await import("../../src/extensions/builtins/todos/import-export.js");
      const sourceFolder = path.join(context.tempRoot, "todos-read-failure");
      await mkdir(sourceFolder, { recursive: true });
      await writeTodoMarkdown(sourceFolder, "unreadable.md", { title: "Unreadable file" }, "ignored");

      const imported = await mockedModule.runTodosImport({ folder: sourceFolder }, { path: context.pmPath });
      expect(imported.imported).toBe(0);
      expect(imported.skipped).toBe(1);
      expect(imported.warnings).toContain("todos_import_read_failed:unreadable.md");
    });
  });
});
