import { mkdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  acquireLock,
  canonicalDocument,
  generateItemId,
  getActiveExtensionRegistrations,
  getHistoryPath,
  getItemPath,
  locateItem,
  normalizeFrontMatter,
  pathExists,
  readSettings,
  resolveItemTypeRegistry,
} from "../../../src/sdk/runtime.js";
import {
  commitImportedItem,
  emptyImportedDocument,
  ensureTrackerInitialized,
  selectImportAuthor,
  toEstimatedMinutesValue,
  toImportLinkedTests,
  toImportLogEntries,
  toImportPriority,
  toImportStatus,
  toImportTags,
  toNonEmptyImportString,
} from "../../../src/sdk/package-import-adapters.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("package import adapter primitives", () => {
  describe("pure coercers", () => {
    it("toNonEmptyImportString returns trimmed value or undefined", () => {
      expect(toNonEmptyImportString("  hi  ")).toBe("hi");
      expect(toNonEmptyImportString("   ")).toBeUndefined();
      expect(toNonEmptyImportString(42)).toBeUndefined();
    });

    it("toEstimatedMinutesValue accepts non-negative numbers and numeric strings", () => {
      expect(toEstimatedMinutesValue(15)).toBe(15);
      expect(toEstimatedMinutesValue("30")).toBe(30);
      expect(toEstimatedMinutesValue(-1)).toBeUndefined();
      expect(toEstimatedMinutesValue("nope")).toBeUndefined();
      expect(toEstimatedMinutesValue(Infinity)).toBeUndefined();
      expect(toEstimatedMinutesValue(true)).toBeUndefined();
    });

    it("toImportPriority clamps to 0..4 with a default of 2", () => {
      expect(toImportPriority(0)).toBe(0);
      expect(toImportPriority(4)).toBe(4);
      expect(toImportPriority("3")).toBe(3);
      expect(toImportPriority(5)).toBe(2);
      expect(toImportPriority("x")).toBe(2);
      expect(toImportPriority(undefined)).toBe(2);
    });

    it("toImportTags normalizes arrays and comma strings", () => {
      expect(toImportTags(["B", "a", "a"])).toEqual(["a", "b"]);
      expect(toImportTags("x, y ,x")).toEqual(["x", "y"]);
      expect(toImportTags([1, "Ok"])).toEqual(["ok"]);
      expect(toImportTags(99)).toEqual([]);
    });

    it("toImportStatus maps to canonical status or defaults to open", () => {
      expect(toImportStatus("in_progress")).toBe("in_progress");
      expect(toImportStatus("unknown-status")).toBe("open");
      expect(toImportStatus(undefined)).toBe("open");
    });

    it("coerces log entries and linked tests through option branches", () => {
      expect(
        toImportLogEntries(
          [
            { text: " record text ", created_at: "raw-created-at", author: " " },
            { comment: "not selected by default" },
          ],
          {
            fallbackCreatedAt: "2026-01-01T00:00:00.000Z",
            fallbackAuthor: "agent",
          },
        ),
      ).toEqual([{ created_at: "raw-created-at", author: "agent", text: "record text" }]);
      expect(
        toImportLogEntries([{ text: "converted", created_at: "2026-01-02" }, { text: "fallback", created_at: "bad-date" }], {
          fallbackCreatedAt: "2026-01-01T00:00:00.000Z",
          fallbackAuthor: "agent",
          toIsoString: (value) => (value === "2026-01-02" ? "2026-01-02T00:00:00.000Z" : undefined),
        }),
      ).toEqual([
        { created_at: "2026-01-02T00:00:00.000Z", author: "agent", text: "converted" },
        { created_at: "2026-01-01T00:00:00.000Z", author: "agent", text: "fallback" },
      ]);
      expect(
        toImportLinkedTests(
          [
            { command: "pnpm test", timeout_seconds: "1.5" },
            { command: "pnpm lint", timeout_seconds: 0 },
            { command: "pnpm build", timeout_seconds: 0 },
          ],
          { timeoutMinimum: 1 },
        ),
      ).toEqual([
        { command: "pnpm test", path: undefined, scope: "project", timeout_seconds: 1.5, note: undefined },
        { command: "pnpm lint", path: undefined, scope: "project", timeout_seconds: undefined, note: undefined },
        { command: "pnpm build", path: undefined, scope: "project", timeout_seconds: undefined, note: undefined },
      ]);
      expect(
        toImportLinkedTests([{ command: "pnpm test", timeout_seconds: 1 }], {
          integerTimeout: true,
          timeoutMinimum: 1,
          timeoutExclusiveMinimum: true,
        }),
      ).toEqual([{ command: "pnpm test", path: undefined, scope: "project", timeout_seconds: undefined, note: undefined }]);
      expect(toImportLinkedTests([{ command: "pnpm test", timeout_seconds: 0 }])).toEqual([
        { command: "pnpm test", path: undefined, scope: "project", timeout_seconds: 0, note: undefined },
      ]);
      expect(toImportLinkedTests([{ path: "tests/unit/smoke.spec.ts" }])).toEqual([
        { path: "tests/unit/smoke.spec.ts", scope: "project", timeout_seconds: undefined, note: undefined },
      ]);
    });

    it("selectImportAuthor prefers explicit, then PM_AUTHOR, then settings", () => {
      const previous = process.env.PM_AUTHOR;
      try {
        delete process.env.PM_AUTHOR;
        expect(selectImportAuthor("alice", "settings-author")).toBe("alice");
        expect(selectImportAuthor(" alice ", "settings-author")).toBe("alice");
        expect(selectImportAuthor(undefined, "settings-author")).toBe("settings-author");
        process.env.PM_AUTHOR = "env-author";
        expect(selectImportAuthor(undefined, "settings-author")).toBe("env-author");
        expect(selectImportAuthor("   ", "settings-author")).toBe("env-author");
        process.env.PM_AUTHOR = "   ";
        expect(selectImportAuthor("   ", "settings-author")).toBe("settings-author");
        expect(selectImportAuthor("   ", "   ")).toBe("unknown");
      } finally {
        if (previous === undefined) {
          delete process.env.PM_AUTHOR;
        } else {
          process.env.PM_AUTHOR = previous;
        }
      }
    });

    it("emptyImportedDocument returns an empty document shape", () => {
      expect(emptyImportedDocument()).toEqual({ metadata: {}, body: "" });
    });
  });

  describe("ensureTrackerInitialized", () => {
    it("resolves when settings exist and throws when uninitialized", async () => {
      await withTempPmPath(async (context) => {
        await expect(ensureTrackerInitialized(context.pmPath)).resolves.toBeUndefined();
      });
      await expect(ensureTrackerInitialized("/nonexistent-pm-root-xyz")).rejects.toThrow(/not initialized/);
    });
  });

  describe("commitImportedItem", () => {
    it("writes the item, appends history, and returns write warnings", async () => {
      await withTempPmPath(async (context) => {
        const pmRoot = context.pmPath;
        const settings = await readSettings(pmRoot);
        const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
        const id = await generateItemId(pmRoot, settings.id_prefix);
        const document = canonicalDocument({
          metadata: normalizeFrontMatter({
            id,
            title: "Imported item",
            description: "",
            type: "Task",
            status: "open",
            priority: 2,
            tags: [],
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
          }),
          body: "body text",
        });
        const itemPath = getItemPath(pmRoot, "Task", id, "toon", typeRegistry.type_to_folder);

        const result = await commitImportedItem({
          pmRoot,
          id,
          itemPath,
          document,
          author: "import-agent",
          message: "Import test",
          settings,
          conflictWarningPrefix: "demo_import_lock_conflict",
        });

        expect(result.committed).toBe(true);
        if (result.committed) {
          expect(Array.isArray(result.writeWarnings)).toBe(true);
        }
        expect(await pathExists(itemPath)).toBe(true);
        const located = await locateItem(pmRoot, id, settings.id_prefix, settings.item_format, typeRegistry.type_to_folder);
        expect(located).not.toBeNull();
        const written = await readFile(itemPath, "utf8");
        expect(written).toContain(id);
      });
    });

    it("returns a prefixed conflict warning when the item lock is already held", async () => {
      await withTempPmPath(async (context) => {
        const pmRoot = context.pmPath;
        const settings = await readSettings(pmRoot);
        const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
        const id = await generateItemId(pmRoot, settings.id_prefix);
        const document = canonicalDocument({
          metadata: normalizeFrontMatter({
            id,
            title: "Locked item",
            description: "",
            type: "Task",
            status: "open",
            priority: 2,
            tags: [],
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
          }),
          body: "",
        });
        const itemPath = getItemPath(pmRoot, "Task", id, "toon", typeRegistry.type_to_folder);

        const releaseLock = await acquireLock(pmRoot, id, settings.locks.ttl_seconds, "other-owner");
        try {
          const result = await commitImportedItem({
            pmRoot,
            id,
            itemPath,
            document,
            author: "import-agent",
            message: "Import test",
            settings,
            conflictWarningPrefix: "demo_import_lock_conflict",
          });
          expect(result).toEqual({ committed: false, conflictWarning: `demo_import_lock_conflict:${id}` });
          expect(await pathExists(itemPath)).toBe(false);
        } finally {
          await releaseLock();
        }
      });
    });

    it("removes a partially written item when history append fails", async () => {
      await withTempPmPath(async (context) => {
        const pmRoot = context.pmPath;
        const settings = await readSettings(pmRoot);
        const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
        const id = await generateItemId(pmRoot, settings.id_prefix);
        const document = canonicalDocument({
          metadata: normalizeFrontMatter({
            id,
            title: "History failure item",
            description: "",
            type: "Task",
            status: "open",
            priority: 2,
            tags: [],
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
          }),
          body: "",
        });
        const itemPath = getItemPath(pmRoot, "Task", id, "toon", typeRegistry.type_to_folder);

        await mkdir(getHistoryPath(pmRoot, id));

        await expect(
          commitImportedItem({
            pmRoot,
            id,
            itemPath,
            document,
            author: "import-agent",
            message: "Import test",
            settings,
            conflictWarningPrefix: "demo_import_lock_conflict",
          }),
        ).rejects.toThrow();
        expect(await pathExists(itemPath)).toBe(false);
      });
    });
  });
});
