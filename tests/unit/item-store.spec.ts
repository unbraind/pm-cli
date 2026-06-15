import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearActiveExtensionHooks,
  setActiveExtensionHooks,
  setActiveExtensionServices,
} from "../../src/core/extensions/index.js";
import {
  itemStoreTestOnly,
  buildItemNotFoundError,
  deleteItem,
  listAllFrontMatter,
  listAllFrontMatterLight,
  listAllFrontMatterWithBody,
  locateItem,
  mutateItem,
  readLocatedItem,
} from "../../src/core/store/item-store.js";
import { listAllDocumentsCached } from "../../src/core/store/front-matter-cache.js";
import { getItemPath } from "../../src/core/store/paths.js";
import { readSettings } from "../../src/core/store/settings.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import { PmCliError } from "../../src/core/shared/errors.js";
import { parseItemDocument, serializeItemDocument } from "../../src/core/item/item-format.js";
import type { ItemDocument, ItemFormat, ItemMetadata } from "../../src/types/index.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

const FIXED_TS = "2026-02-20T00:00:00.000Z";

async function writeTaskItem(
  pmRoot: string,
  id: string,
  overrides: Partial<ItemMetadata> = {},
  format: ItemFormat = "toon",
): Promise<{ itemPath: string; document: ItemDocument }> {
  const metadata: ItemMetadata = {
    id,
    title: `Title ${id}`,
    description: "original description",
    type: "Task",
    status: "open",
    priority: 1,
    tags: ["unit"],
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
    ...overrides,
  };
  const document: ItemDocument = {
    metadata,
    body: "seed body",
  };
  const itemPath = getItemPath(pmRoot, "Task", id, format);
  await fs.mkdir(path.dirname(itemPath), { recursive: true });
  await fs.writeFile(itemPath, serializeItemDocument(document, { format }), "utf8");
  return { itemPath, document };
}

describe("core/store/item-store", () => {
  afterEach(() => {
    clearActiveExtensionHooks();
    setActiveExtensionServices(null);
  });

  it("continues listing when one item-type directory is missing", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-item-store-list";
      await writeTaskItem(pmPath, id);
      await fs.rm(path.join(pmPath, "issues"), { recursive: true, force: true });

      const items = await listAllFrontMatter(pmPath);
      expect(items.some((entry) => entry.id === id)).toBe(true);
    });
  });

  it("returns not-found when mutating an unknown item id", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const settings = await readSettings(pmPath);
      await expect(
        mutateItem({
          pmRoot: pmPath,
          settings,
          id: "pm-missing-item",
          op: "update",
          author: "unit-author",
          mutate: () => ({ changedFields: [] }),
        }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    });
  });

  it("covers item-store helper branches for warnings and assignee bypasses", async () => {
    const warnings: string[] = [];
    itemStoreTestOnly.appendWarning(warnings, "first");
    itemStoreTestOnly.appendWarning(undefined, "ignored");
    expect(warnings).toEqual(["first"]);
    expect(itemStoreTestOnly.isErrno(Object.assign(new Error("busy"), { code: "EBUSY" }), "EBUSY")).toBe(true);
    expect(itemStoreTestOnly.isErrno(new Error("plain"), "EBUSY")).toBe(false);
    expect(itemStoreTestOnly.bypassesAssigneeConflict("claim")).toBe(true);
    expect(itemStoreTestOnly.bypassesAssigneeConflict("update", true)).toBe(true);
    expect(itemStoreTestOnly.bypassesAssigneeConflict("delete", true)).toBe(false);
    await withTempPmPath(async ({ pmPath }) => {
      await expect(itemStoreTestOnly.buildDidYouMeanSuggestions(pmPath, "pm-nothing", "pm-", {})).resolves.toEqual([]);
    });
  });

  it("surfaces parse warnings through readLocatedItem onWarning callback", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-readlocated-warning";
      const { document } = await writeTaskItem(pmPath, id, { description: "warned" }, "json_markdown");
      const itemPath = getItemPath(pmPath, "Task", id, "json_markdown");
      // Prepend a leading YAML front-matter document so json_markdown parsing
      // strips it and emits the leading-yaml warning through onWarning -> appendWarning.
      const serialized = serializeItemDocument(document, { format: "json_markdown" });
      await fs.writeFile(itemPath, `---\ntitle: legacy\n---\n${serialized}`, "utf8");

      const located = await locateItem(pmPath, id, "pm-", "json_markdown");
      const warnings: string[] = [];
      const loaded = await readLocatedItem(located as NonNullable<typeof located>, { warnings });
      expect(loaded.document.metadata.id).toBe(id);
      expect(warnings).toContain("json_markdown_leading_yaml_frontmatter_ignored");
    });
  });

  it("rolls back an in-place update when history append fails without relocation", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-item-store-inplace-rollback";
      const { itemPath } = await writeTaskItem(pmPath, id);
      const originalRaw = await fs.readFile(itemPath, "utf8");
      const settings = await readSettings(pmPath);

      // The history stream exists but the .jsonl path is a directory, so the
      // (non-type-change) update's appendHistoryEntry throws AFTER the in-place
      // item write — exercising the `else if (!skipItemWrite)` rollback branch
      // where effectiveTargetItemPath === located.itemPath.
      const historyPath = path.join(pmPath, "history", `${id}.jsonl`);
      await fs.mkdir(path.dirname(historyPath), { recursive: true });
      await fs.mkdir(historyPath, { recursive: true });

      await expect(
        mutateItem({
          pmRoot: pmPath,
          settings,
          id,
          op: "update",
          author: "unit-author",
          mutate: (document) => {
            document.metadata.description = "mutated then rolled back";
            return { changedFields: ["description"] };
          },
        }),
      ).rejects.toBeInstanceOf(Error);

      const rawAfterFailure = await fs.readFile(itemPath, "utf8");
      expect(rawAfterFailure).toBe(originalRaw);
    });
  });

  it("locates preserved source ids when the current tracker prefix differs", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await writeTaskItem(pmPath, "clawd-01c8");
      const located = await locateItem(pmPath, "clawd-01c8", "pm-");
      expect(located?.id).toBe("clawd-01c8");
      expect(located?.type).toBe("Task");
    });
  });

  it("prefers configured format when both markdown and toon files exist", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-format-preference";
      await writeTaskItem(pmPath, id, { description: "markdown-description" }, "json_markdown");
      await writeTaskItem(pmPath, id, { description: "toon-description" }, "toon");

      const locatedToon = await locateItem(pmPath, id, "pm-", "toon");
      expect(locatedToon?.item_format).toBe("toon");
      const loadedToon = await readLocatedItem(locatedToon as NonNullable<typeof locatedToon>);
      expect(loadedToon.document.metadata.description).toBe("toon-description");

      const locatedMarkdown = await locateItem(pmPath, id, "pm-", "json_markdown");
      expect(locatedMarkdown?.item_format).toBe("json_markdown");
      const loadedMarkdown = await readLocatedItem(locatedMarkdown as NonNullable<typeof locatedMarkdown>);
      expect(loadedMarkdown.document.metadata.description).toBe("markdown-description");
    });
  });

  it("deduplicates listAllFrontMatter results by preferred item format", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-list-format-preference";
      await writeTaskItem(pmPath, id, { description: "markdown-only" }, "json_markdown");
      await writeTaskItem(pmPath, id, { description: "toon-only" }, "toon");

      const defaultPreferred = await listAllFrontMatter(pmPath);
      expect(defaultPreferred.filter((entry) => entry.id === id)).toHaveLength(1);
      expect(defaultPreferred.find((entry) => entry.id === id)?.description).toBe("toon-only");

      const preferredToon = await listAllFrontMatter(pmPath, "toon");
      expect(preferredToon.filter((entry) => entry.id === id)).toHaveLength(1);
      expect(preferredToon.find((entry) => entry.id === id)?.description).toBe("toon-only");

      const preferredMarkdown = await listAllFrontMatter(pmPath, "json_markdown");
      expect(preferredMarkdown.filter((entry) => entry.id === id)).toHaveLength(1);
      expect(preferredMarkdown.find((entry) => entry.id === id)?.description).toBe("markdown-only");
    });
  });

  it("lists light front matter and body-bearing front matter variants", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-list-variants";
      await writeTaskItem(pmPath, id, { description: "variant target" }, "toon");

      const light = await listAllFrontMatterLight(pmPath, "toon");
      const lightEntry = light.find((entry) => entry.id === id);
      expect(lightEntry).toMatchObject({ id, description: "variant target" });
      expect(lightEntry).not.toHaveProperty("comments");

      const withBody = await listAllFrontMatterWithBody(pmPath, "toon");
      expect(withBody.find((entry) => entry.id === id)).toMatchObject({
        id,
        description: "variant target",
        body: "seed body",
      });
    });
  });

  it("builds item-not-found errors with close id suggestions and ignores missing type folders", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await writeTaskItem(pmPath, "pm-suggested-target");
      await fs.rm(path.join(pmPath, "issues"), { recursive: true, force: true });

      const error = await buildItemNotFoundError(pmPath, "pm-suggested-targot", "pm-", {
        Task: "tasks",
        Issue: "issues",
      });

      expect(error).toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
      expect(error.context.nextSteps?.[0]).toContain("pm-suggested-target");
    });
  });

  it("emits deterministic warnings when unreadable items are skipped during listing", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const validId = "pm-list-warning-valid";
      await writeTaskItem(pmPath, validId, { description: "valid item" }, "toon");
      const unreadablePath = path.join(pmPath, "tasks", "pm-list-warning-bad.toon");
      await fs.writeFile(unreadablePath, "{ invalid-toon", "utf8");

      const warnings: string[] = [];
      const items = await listAllFrontMatter(pmPath, "toon", undefined, warnings);
      expect(items.some((entry) => entry.id === validId)).toBe(true);
      expect(warnings).toContain("item_list_item_read_failed:tasks/pm-list-warning-bad.toon");
    });
  });

  it("rolls back the item file when history append fails", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-item-store-rollback";
      const { itemPath } = await writeTaskItem(pmPath, id);
      const originalRaw = await fs.readFile(itemPath, "utf8");
      const settings = await readSettings(pmPath);

      // Force appendHistoryEntry to fail by replacing the history directory with a file.
      const historyDir = path.join(pmPath, "history");
      await fs.rm(historyDir, { recursive: true, force: true });
      await fs.writeFile(historyDir, "not-a-directory", "utf8");

      await expect(
        mutateItem({
          pmRoot: pmPath,
          settings,
          id,
          op: "update",
          author: "unit-author",
          mutate: (document) => {
            document.metadata.description = "mutated description";
            return { changedFields: ["description"] };
          },
        }),
      ).rejects.toBeInstanceOf(Error);

      const rawAfterFailure = await fs.readFile(itemPath, "utf8");
      expect(rawAfterFailure).toBe(originalRaw);
      expect(parseItemDocument(rawAfterFailure).metadata.description).toBe("original description");
    });
  });

  it("restores the original file and removes the relocated file when a type-change history append fails", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-item-store-rollback-relocate";
      const { itemPath } = await writeTaskItem(pmPath, id);
      const originalRaw = await fs.readFile(itemPath, "utf8");
      const settings = await readSettings(pmPath);

      // The relocated path lives under the features/ folder once the type changes.
      const relocatedPath = getItemPath(pmPath, "Feature", id, "toon");

      // The history stream EXISTS (so the stream policy passes), but the .jsonl
      // path is a directory so appendHistoryEntry throws after the item write —
      // exercising the relocate-and-rollback catch branch.
      const historyPath = path.join(pmPath, "history", `${id}.jsonl`);
      await fs.mkdir(path.dirname(historyPath), { recursive: true });
      await fs.mkdir(historyPath, { recursive: true });

      await expect(
        mutateItem({
          pmRoot: pmPath,
          settings,
          id,
          op: "update",
          author: "unit-author",
          mutate: (document) => {
            document.metadata.type = "Feature";
            return { changedFields: ["type"] };
          },
        }),
      ).rejects.toBeInstanceOf(Error);

      // Original file is restored verbatim and the relocated copy is cleaned up.
      const rawAfterFailure = await fs.readFile(itemPath, "utf8");
      expect(rawAfterFailure).toBe(originalRaw);
      await expect(fs.access(relocatedPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("rolls back the item file when a delete history append fails", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-item-store-delete-rollback";
      const { itemPath } = await writeTaskItem(pmPath, id);
      const originalRaw = await fs.readFile(itemPath, "utf8");
      const settings = await readSettings(pmPath);

      // History stream exists but the .jsonl path is a directory, so the delete's
      // appendHistoryEntry throws after the item file is removed — exercising the
      // delete rollback catch branch that rewrites the captured original content.
      const historyPath = path.join(pmPath, "history", `${id}.jsonl`);
      await fs.mkdir(path.dirname(historyPath), { recursive: true });
      await fs.mkdir(historyPath, { recursive: true });

      await expect(
        deleteItem({
          pmRoot: pmPath,
          settings,
          id,
          author: "unit-author",
        }),
      ).rejects.toBeInstanceOf(Error);

      // The deleted file is rewritten from the captured original content.
      const rawAfterFailure = await fs.readFile(itemPath, "utf8");
      expect(rawAfterFailure).toBe(originalRaw);
    });
  });

  it("fails in strict mode when an existing item stream is missing", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-item-store-strict-missing-history";
      const { itemPath } = await writeTaskItem(pmPath, id);
      const originalRaw = await fs.readFile(itemPath, "utf8");
      const settings = await readSettings(pmPath);
      settings.history.missing_stream = "strict_error";

      await expect(
        mutateItem({
          pmRoot: pmPath,
          settings,
          id,
          op: "update",
          author: "unit-author",
          mutate: (document) => {
            document.metadata.description = "should not persist";
            return { changedFields: ["description"] };
          },
        }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });

      const rawAfterFailure = await fs.readFile(itemPath, "utf8");
      expect(rawAfterFailure).toBe(originalRaw);
    });
  });

  it("warns on assignee conflicts when ownership enforcement is warn", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-item-store-assignee-warning";
      await writeTaskItem(pmPath, id, { assignee: "other-agent" });
      const settings = await readSettings(pmPath);
      settings.governance.preset = "custom";
      settings.governance.ownership_enforcement = "warn";

      const result = await mutateItem({
        pmRoot: pmPath,
        settings,
        id,
        op: "update",
        author: "unit-author",
        mutate: (document) => {
          document.metadata.description = "updated despite warning";
          return { changedFields: ["description"] };
        },
      });

      expect(result.item.description).toBe("updated despite warning");
      expect(result.warnings).toEqual(
        expect.arrayContaining([`ownership_warning:assignee_conflict:${id}:other-agent`]),
      );
    });
  });

  it("blocks strict assignee conflicts but allows explicit bypass operations", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-item-store-strict-assignee";
      await writeTaskItem(pmPath, id, { assignee: "other-agent" });
      const settings = await readSettings(pmPath);
      settings.governance.preset = "custom";
      settings.governance.ownership_enforcement = "strict";

      await expect(
        mutateItem({
          pmRoot: pmPath,
          settings,
          id,
          op: "update",
          author: "unit-author",
          mutate: (document) => {
            document.metadata.description = "blocked";
            return { changedFields: ["description"] };
          },
        }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.CONFLICT,
      });

      const bypassed = await mutateItem({
        pmRoot: pmPath,
        settings,
        id,
        op: "comment_add",
        author: "unit-author",
        bypassAssigneeConflict: true,
        mutate: (document) => {
          document.metadata.description = "bypassed";
          return {
            changedFields: ["description"],
            warnings: ["mutation_warning:kept_for_coverage"],
          };
        },
      });

      expect(bypassed.item.description).toBe("bypassed");
      expect(bypassed.warnings).toContain("mutation_warning:kept_for_coverage");
    });
  });

  it("populates front-matter cache on first run and reuses it on second run", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-cache-test-item";
      await writeTaskItem(pmPath, id, { description: "cache-target" }, "toon");

      const cachePath = path.join(pmPath, "runtime", "metadata-cache.json");
      expect(await fs.access(cachePath).then(() => true, () => false)).toBe(false);

      const firstRun = await listAllFrontMatter(pmPath, "toon");
      expect(firstRun.some((entry) => entry.id === id)).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await fs.access(cachePath).then(() => true, () => false)).toBe(true);

      const cached = JSON.parse(await fs.readFile(cachePath, "utf8")) as { entries: Record<string, unknown> };
      expect(Object.keys(cached.entries).length).toBeGreaterThan(0);

      const secondRun = await listAllFrontMatter(pmPath, "toon");
      expect(secondRun.some((entry) => entry.id === id)).toBe(true);
      expect(secondRun.find((entry) => entry.id === id)?.description).toBe("cache-target");
    });
  });

  it("invalidates cache when file changes", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-cache-invalidation";
      await writeTaskItem(pmPath, id, { description: "before-change" }, "toon");

      const firstRun = await listAllFrontMatter(pmPath, "toon");
      expect(firstRun.find((entry) => entry.id === id)?.description).toBe("before-change");

      await new Promise((resolve) => setTimeout(resolve, 50));

      await writeTaskItem(pmPath, id, { description: "after-change" }, "toon");

      const secondRun = await listAllFrontMatter(pmPath, "toon");
      expect(secondRun.find((entry) => entry.id === id)?.description).toBe("after-change");
    });
  });

  it("detects context fingerprint change and rebuilds cache", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-cache-fingerprint";
      await writeTaskItem(pmPath, id, {}, "toon");
      await writeTaskItem(pmPath, id, {}, "json_markdown");

      const toonRun = await listAllDocumentsCached(pmPath, "toon", { Task: "tasks", Issue: "issues", Chore: "chores" }, undefined, undefined);
      expect(toonRun.length).toBeGreaterThan(0);

      const mdRun = await listAllDocumentsCached(pmPath, "json_markdown", { Task: "tasks", Issue: "issues", Chore: "chores" }, undefined, undefined);
      expect(mdRun.length).toBeGreaterThan(0);
    });
  });

  it("prunes deleted files from cache", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const keepId = "pm-cache-keep";
      const removeId = "pm-cache-remove";
      await writeTaskItem(pmPath, keepId, {}, "toon");
      await writeTaskItem(pmPath, removeId, {}, "toon");

      const firstRun = await listAllFrontMatter(pmPath, "toon");
      expect(firstRun.some((entry) => entry.id === keepId)).toBe(true);
      expect(firstRun.some((entry) => entry.id === removeId)).toBe(true);

      const removePath = getItemPath(pmPath, "Task", removeId, "toon");
      await fs.rm(removePath);

      const secondRun = await listAllFrontMatter(pmPath, "toon");
      expect(secondRun.some((entry) => entry.id === keepId)).toBe(true);
      expect(secondRun.some((entry) => entry.id === removeId)).toBe(false);
    });
  });

  it("dispatches onRead hooks on cached front-matter reads", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-cache-read-hook";
      await writeTaskItem(pmPath, id, {}, "toon");
      const basename = `${id}.toon`;
      const seenReads: string[] = [];
      setActiveExtensionHooks({
        beforeCommand: [],
        afterCommand: [],
        onWrite: [],
        onRead: [
          {
            layer: "project",
            name: "capture-read-paths",
            run: (context) => {
              seenReads.push(path.basename(context.path));
            },
          },
        ],
        onIndex: [],
      });

      try {
        await listAllFrontMatter(pmPath, "toon");
        const firstRunReadCount = seenReads.filter((entry) => entry === basename).length;
        expect(firstRunReadCount).toBeGreaterThan(0);

        await listAllFrontMatter(pmPath, "toon");
        const secondRunReadCount = seenReads.filter((entry) => entry === basename).length;
        expect(secondRunReadCount).toBeGreaterThan(firstRunReadCount);
      } finally {
        clearActiveExtensionHooks();
      }
    });
  });

  it("dispatches item identity and snapshots on item onWrite hooks", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-write-context";
      await writeTaskItem(pmPath, id, { description: "before description" }, "toon");
      const settings = await readSettings(pmPath);
      const seenWrites: Array<{
        op: string;
        itemId?: string;
        itemType?: string;
        beforeDescription?: string;
        afterDescription?: string;
        changedFields?: string[];
      }> = [];
      setActiveExtensionHooks({
        beforeCommand: [],
        afterCommand: [],
        onWrite: [
          {
            layer: "project",
            name: "capture-write-context",
            run: (context) => {
              seenWrites.push({
                op: context.op,
                itemId: context.item_id,
                itemType: context.item_type,
                beforeDescription: context.before?.metadata.description,
                afterDescription: context.after?.metadata.description,
                changedFields: context.changed_fields,
              });
            },
          },
        ],
        onRead: [],
        onIndex: [],
      });

      try {
        await mutateItem({
          pmRoot: pmPath,
          settings,
          id,
          op: "update",
          author: "unit-author",
          mutate: (document) => {
            document.metadata.description = "after description";
            return { changedFields: ["description"] };
          },
        });
        await deleteItem({
          pmRoot: pmPath,
          settings,
          id,
          author: "unit-author",
          message: "delete after context capture",
        });
      } finally {
        clearActiveExtensionHooks();
      }

      expect(seenWrites).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            op: "update",
            itemId: id,
            itemType: "Task",
            beforeDescription: "before description",
            afterDescription: "after description",
            changedFields: ["description"],
          }),
          expect.objectContaining({
            op: "delete",
            itemId: id,
            itemType: "Task",
            beforeDescription: "after description",
            afterDescription: undefined,
            changedFields: ["deleted"],
          }),
        ]),
      );
    });
  });

  it("applies item write service overrides for target path and contents", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-write-override";
      const { itemPath } = await writeTaskItem(pmPath, id, { description: "before" }, "toon");
      const alternatePath = path.join(pmPath, "tasks", "pm-write-override-shadow.toon");
      const settings = await readSettings(pmPath);
      setActiveExtensionServices({
        overrides: [
          {
            layer: "project",
            name: "write-path-override",
            service: "item_store_write",
            run: (context) => ({
              target_item_path: alternatePath,
              contents: String((context.payload as { contents?: unknown }).contents).replace(
                "after override",
                "after service override",
              ),
              skip_write: false,
            }),
          },
        ],
      });

      const result = await mutateItem({
        pmRoot: pmPath,
        settings,
        id,
        op: "update",
        author: "unit-author",
        mutate: (document) => {
          document.metadata.description = "after override";
          return { changedFields: ["description"] };
        },
      });

      expect(result.item.description).toBe("after override");
      await expect(fs.access(itemPath)).rejects.toMatchObject({ code: "ENOENT" });
      const relocatedRaw = await fs.readFile(alternatePath, "utf8");
      expect(relocatedRaw).toContain("after service override");
    });
  });

  it("restores original item when overridden item writes fail history append", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-write-override-rollback";
      const { itemPath } = await writeTaskItem(pmPath, id, { description: "before rollback" }, "toon");
      const originalRaw = await fs.readFile(itemPath, "utf8");
      const alternatePath = path.join(pmPath, "tasks", "pm-write-override-rollback-shadow.toon");
      const settings = await readSettings(pmPath);
      setActiveExtensionServices({
        overrides: [
          {
            layer: "project",
            name: "write-path-rollback",
            service: "item_store_write",
            run: () => ({ target_item_path: alternatePath }),
          },
        ],
      });
      const historyDir = path.join(pmPath, "history");
      await fs.rm(historyDir, { recursive: true, force: true });
      await fs.writeFile(historyDir, "not-a-directory", "utf8");

      await expect(
        mutateItem({
          pmRoot: pmPath,
          settings,
          id,
          op: "update",
          author: "unit-author",
          mutate: (document) => {
            document.metadata.description = "should rollback";
            return { changedFields: ["description"] };
          },
        }),
      ).rejects.toBeInstanceOf(Error);

      await expect(fs.readFile(itemPath, "utf8")).resolves.toBe(originalRaw);
      await expect(fs.access(alternatePath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("restores the original item when same-path history append fails", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-write-rollback-same-path";
      const { itemPath } = await writeTaskItem(pmPath, id, { description: "before same-path rollback" }, "toon");
      const originalRaw = await fs.readFile(itemPath, "utf8");
      const settings = await readSettings(pmPath);
      const historyDir = path.join(pmPath, "history");
      await fs.rm(historyDir, { recursive: true, force: true });
      await fs.writeFile(historyDir, "not-a-directory", "utf8");

      await expect(
        mutateItem({
          pmRoot: pmPath,
          settings,
          id,
          op: "update",
          author: "unit-author",
          mutate: (document) => {
            document.metadata.description = "should rollback same path";
            return { changedFields: ["description"] };
          },
        }),
      ).rejects.toBeInstanceOf(Error);

      await expect(fs.readFile(itemPath, "utf8")).resolves.toBe(originalRaw);
    });
  });

  it("honors skip write and skip delete service overrides", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-skip-overrides";
      const { itemPath } = await writeTaskItem(pmPath, id, { description: "before skip" }, "toon");
      const originalRaw = await fs.readFile(itemPath, "utf8");
      const settings = await readSettings(pmPath);
      setActiveExtensionServices({
        overrides: [
          {
            layer: "project",
            name: "skip-write-delete",
            service: "item_store_write",
            run: () => ({ skip_write: true }),
          },
          {
            layer: "project",
            name: "skip-delete",
            service: "item_store_delete",
            run: () => ({ skip_delete: true }),
          },
        ],
      });

      await mutateItem({
        pmRoot: pmPath,
        settings,
        id,
        op: "update",
        author: "unit-author",
        mutate: (document) => {
          document.metadata.description = "not written";
          return { changedFields: ["description"] };
        },
      });
      await expect(fs.readFile(itemPath, "utf8")).resolves.toBe(originalRaw);

      const deleted = await deleteItem({
        pmRoot: pmPath,
        settings,
        id,
        author: "unit-author",
      });
      expect(deleted.changedFields).toEqual(["deleted"]);
      await expect(fs.readFile(itemPath, "utf8")).resolves.toBe(originalRaw);
    });
  });

  it("returns delete dry-run target and applies delete service overrides", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-delete-override";
      const { itemPath } = await writeTaskItem(pmPath, id, { description: "delete target" }, "toon");
      const settings = await readSettings(pmPath);
      const alternatePath = path.join(pmPath, "tasks", "pm-delete-override-shadow.toon");
      await fs.copyFile(itemPath, alternatePath);

      setActiveExtensionServices({
        overrides: [
          {
            layer: "project",
            name: "delete-path-override",
            service: "item_store_delete",
            run: () => ({
              item_path: alternatePath,
              skip_delete: false,
            }),
          },
        ],
      });

      const dryRun = await deleteItem({
        pmRoot: pmPath,
        settings,
        id,
        author: "unit-author",
        dryRun: true,
      });
      expect(dryRun).toMatchObject({
        changedFields: ["deleted"],
        targetPath: alternatePath,
      });
      await expect(fs.access(itemPath)).resolves.toBeUndefined();
      await expect(fs.access(alternatePath)).resolves.toBeUndefined();

      const deleted = await deleteItem({
        pmRoot: pmPath,
        settings,
        id,
        author: "unit-author",
      });
      expect(deleted.changedFields).toEqual(["deleted"]);
      await expect(fs.access(itemPath)).resolves.toBeUndefined();
      await expect(fs.access(alternatePath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("restores overridden delete targets when history append fails", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-delete-rollback";
      const { itemPath } = await writeTaskItem(pmPath, id, { description: "rollback target" }, "toon");
      const originalRaw = await fs.readFile(itemPath, "utf8");
      const alternatePath = path.join(pmPath, "tasks", "pm-delete-rollback-shadow.toon");
      await fs.copyFile(itemPath, alternatePath);
      const settings = await readSettings(pmPath);
      setActiveExtensionServices({
        overrides: [
          {
            layer: "project",
            name: "delete-path-rollback",
            service: "item_store_delete",
            run: () => ({ item_path: alternatePath }),
          },
        ],
      });
      const historyDir = path.join(pmPath, "history");
      await fs.rm(historyDir, { recursive: true, force: true });
      await fs.writeFile(historyDir, "not-a-directory", "utf8");

      await expect(
        deleteItem({
          pmRoot: pmPath,
          settings,
          id,
          author: "unit-author",
        }),
      ).rejects.toBeInstanceOf(Error);

      await expect(fs.readFile(alternatePath, "utf8")).resolves.toBe(originalRaw);
    });
  });

  it("restores same-path delete targets when history append fails", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const id = "pm-delete-rollback-same-path";
      const { itemPath } = await writeTaskItem(pmPath, id, { description: "rollback same path" }, "toon");
      const originalRaw = await fs.readFile(itemPath, "utf8");
      const settings = await readSettings(pmPath);
      const historyDir = path.join(pmPath, "history");
      await fs.rm(historyDir, { recursive: true, force: true });
      await fs.writeFile(historyDir, "not-a-directory", "utf8");

      await expect(
        deleteItem({
          pmRoot: pmPath,
          settings,
          id,
          author: "unit-author",
        }),
      ).rejects.toBeInstanceOf(Error);

      await expect(fs.readFile(itemPath, "utf8")).resolves.toBe(originalRaw);
    });
  });

  it("covers item-store warning and suggestion helper edges", async () => {
    expect(itemStoreTestOnly.isErrno({ code: "ENOENT" }, "ENOENT")).toBe(true);
    expect(itemStoreTestOnly.isErrno(null, "ENOENT")).toBe(false);

    const warnings = ["existing"];
    itemStoreTestOnly.appendWarning(warnings, "existing");
    itemStoreTestOnly.appendWarning(warnings, "new");
    expect(warnings).toEqual(["existing", "new"]);
    itemStoreTestOnly.appendWarning(undefined, "ignored");

    await withTempPmPath(async ({ pmPath }) => {
      await writeTaskItem(pmPath, "pm-close-alpha");
      await writeTaskItem(pmPath, "pm-close-beta");
      const suggestions = await itemStoreTestOnly.buildDidYouMeanSuggestions(pmPath, "pm-close-alphx", "pm-", {
        Task: "tasks",
        Issue: "issues",
      });
      expect(suggestions).toContain("pm-close-alpha");
    });
  });
});
