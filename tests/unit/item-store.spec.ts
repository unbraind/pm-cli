import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listAllFrontMatter, locateItem, mutateItem, readLocatedItem } from "../../src/core/store/item-store.js";
import { getItemPath } from "../../src/core/store/paths.js";
import { readSettings } from "../../src/core/store/settings.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import { PmCliError } from "../../src/core/shared/errors.js";
import { parseItemDocument, serializeItemDocument } from "../../src/core/item/item-format.js";
import type { ItemDocument, ItemFormat, ItemFrontMatter } from "../../src/types/index.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

const FIXED_TS = "2026-02-20T00:00:00.000Z";

async function writeTaskItem(
  pmRoot: string,
  id: string,
  overrides: Partial<ItemFrontMatter> = {},
  format: ItemFormat = "json_markdown",
): Promise<{ itemPath: string; document: ItemDocument }> {
  const frontMatter: ItemFrontMatter = {
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
    front_matter: frontMatter,
    body: "seed body",
  };
  const itemPath = getItemPath(pmRoot, "Task", id, format);
  await fs.mkdir(path.dirname(itemPath), { recursive: true });
  await fs.writeFile(itemPath, serializeItemDocument(document, { format }), "utf8");
  return { itemPath, document };
}

describe("core/store/item-store", () => {
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
      expect(loadedToon.document.front_matter.description).toBe("toon-description");

      const locatedMarkdown = await locateItem(pmPath, id, "pm-", "json_markdown");
      expect(locatedMarkdown?.item_format).toBe("json_markdown");
      const loadedMarkdown = await readLocatedItem(locatedMarkdown as NonNullable<typeof locatedMarkdown>);
      expect(loadedMarkdown.document.front_matter.description).toBe("markdown-description");
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
            document.front_matter.description = "mutated description";
            return { changedFields: ["description"] };
          },
        }),
      ).rejects.toBeInstanceOf(Error);

      const rawAfterFailure = await fs.readFile(itemPath, "utf8");
      expect(rawAfterFailure).toBe(originalRaw);
      expect(parseItemDocument(rawAfterFailure).front_matter.description).toBe("original description");
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
            document.front_matter.description = "should not persist";
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
});
