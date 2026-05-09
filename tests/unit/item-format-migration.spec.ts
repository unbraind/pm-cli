import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalDocument, parseItemDocument, serializeItemDocument } from "../../src/core/item/item-format.js";
import { migrateItemFilesToFormat } from "../../src/core/store/item-format-migration.js";
import { getItemPath } from "../../src/core/store/paths.js";
import type { ItemDocument, ItemFormat } from "../../src/types/index.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

function buildTaskDocument(id: string, description: string): ItemDocument {
  return canonicalDocument({
    metadata: {
      id,
      title: `Title ${id}`,
      description,
      type: "Task",
      status: "open",
      priority: 1,
      tags: ["migration"],
      created_at: "2026-03-31T00:00:00.000Z",
      updated_at: "2026-03-31T00:00:00.000Z",
    },
    body: `Body ${id}`,
  });
}

async function writeTaskWithFormat(pmPath: string, id: string, format: ItemFormat, description: string): Promise<void> {
  const taskPath = getItemPath(pmPath, "Task", id, format);
  await fs.mkdir(path.dirname(taskPath), { recursive: true });
  await fs.writeFile(taskPath, serializeItemDocument(buildTaskDocument(id, description), { format }), "utf8");
}

describe("migrateItemFilesToFormat", () => {
  it("migrates json markdown items with leading YAML wrappers into TOON", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await writeTaskWithFormat(pmPath, "pm-yaml-wrapper", "json_markdown", "yaml-wrapped-source");
      const markdownPath = getItemPath(pmPath, "Task", "pm-yaml-wrapper", "json_markdown");
      const original = await fs.readFile(markdownPath, "utf8");
      await fs.writeFile(
        markdownPath,
        `---\ntitle: "{legacy-yaml-wrapper}"\ntype: document\n---\n${original}`,
        "utf8",
      );
      const toonPath = getItemPath(pmPath, "Task", "pm-yaml-wrapper", "toon");

      const result = await migrateItemFilesToFormat(pmPath, "toon");
      expect(result.migrated).toContain("pm-yaml-wrapper");
      expect(result.removed).toEqual(["tasks/pm-yaml-wrapper.md"]);
      expect(result.warnings).toContain(
        "item_format_migration_parse_warning:pm-yaml-wrapper:json_markdown_leading_yaml_frontmatter_ignored",
      );
      await expect(fs.access(markdownPath)).rejects.toBeDefined();

      const parsed = parseItemDocument(await fs.readFile(toonPath, "utf8"), { format: "toon" });
      expect(parsed.metadata.description).toBe("yaml-wrapped-source");
      expect(parsed.body).toBe("Body pm-yaml-wrapper");
    });
  });

  it("continues migration when an item file is unreadable", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await writeTaskWithFormat(pmPath, "pm-good", "json_markdown", "good-source");
      const badPath = getItemPath(pmPath, "Task", "pm-bad", "json_markdown");
      await fs.mkdir(path.dirname(badPath), { recursive: true });
      await fs.writeFile(badPath, "not item front matter\n", "utf8");

      const result = await migrateItemFilesToFormat(pmPath, "toon");
      expect(result.scanned).toBe(2);
      expect(result.migrated).toEqual(["pm-good"]);
      expect(result.removed).toEqual(["tasks/pm-good.md"]);
      expect(result.warnings.some((warning) => warning.startsWith("item_format_migration_skipped:tasks/pm-bad.md:"))).toBe(true);
      await expect(fs.access(getItemPath(pmPath, "Task", "pm-good", "toon"))).resolves.toBeUndefined();
      await expect(fs.access(badPath)).resolves.toBeUndefined();
    });
  });

  it("migrates markdown-only task files into TOON and removes markdown variants", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await writeTaskWithFormat(pmPath, "pm-md-only", "json_markdown", "markdown-source");
      const markdownPath = getItemPath(pmPath, "Task", "pm-md-only", "json_markdown");
      const toonPath = getItemPath(pmPath, "Task", "pm-md-only", "toon");

      const result = await migrateItemFilesToFormat(pmPath, "toon");
      expect(result.target_format).toBe("toon");
      expect(result.migrated).toContain("pm-md-only");
      await expect(fs.access(toonPath)).resolves.toBeUndefined();
      await expect(fs.access(markdownPath)).rejects.toBeDefined();

      const parsed = parseItemDocument(await fs.readFile(toonPath, "utf8"), { format: "toon" });
      expect(parsed.metadata.description).toBe("markdown-source");
    });
  });

  it("prefers configured format content when markdown and toon variants both exist", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await writeTaskWithFormat(pmPath, "pm-dual", "json_markdown", "markdown-version");
      await writeTaskWithFormat(pmPath, "pm-dual", "toon", "toon-version");
      const markdownPath = getItemPath(pmPath, "Task", "pm-dual", "json_markdown");
      const toonPath = getItemPath(pmPath, "Task", "pm-dual", "toon");

      const result = await migrateItemFilesToFormat(pmPath, "toon");
      expect(result.migrated).toContain("pm-dual");
      await expect(fs.access(markdownPath)).rejects.toBeDefined();
      await expect(fs.access(toonPath)).resolves.toBeUndefined();

      const parsed = parseItemDocument(await fs.readFile(toonPath, "utf8"), { format: "toon" });
      expect(parsed.metadata.description).toBe("toon-version");
    });
  });

  it("rejects markdown migration targets because markdown writes are legacy read-only", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await writeTaskWithFormat(pmPath, "pm-toon-only", "toon", "toon-source");
      const toonPath = getItemPath(pmPath, "Task", "pm-toon-only", "toon");

      await expect(migrateItemFilesToFormat(pmPath, "json_markdown")).rejects.toThrow(
        "Only toon item-format migration targets are supported",
      );
      await expect(fs.access(toonPath)).resolves.toBeUndefined();
    });
  });

  it("returns migrated ids and removed paths in deterministic sorted order", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await writeTaskWithFormat(pmPath, "pm-sort-b", "json_markdown", "b");
      await writeTaskWithFormat(pmPath, "pm-sort-a", "json_markdown", "a");

      const result = await migrateItemFilesToFormat(pmPath, "toon");
      expect(result.migrated).toEqual(["pm-sort-a", "pm-sort-b"]);
      expect(result.removed).toEqual(["tasks/pm-sort-a.md", "tasks/pm-sort-b.md"]);
    });
  });

  it("ignores non-item files and empty-id extension stubs during migration scans", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      const tasksDir = path.join(pmPath, "tasks");
      await fs.mkdir(tasksDir, { recursive: true });
      await fs.writeFile(path.join(tasksDir, "notes.txt"), "not an item", "utf8");
      await fs.writeFile(path.join(tasksDir, " .md"), "{}", "utf8");

      const result = await migrateItemFilesToFormat(pmPath, "toon");
      expect(result.scanned).toBe(0);
      expect(result.migrated).toEqual([]);
      expect(result.removed).toEqual([]);
    });
  });

  it("skips missing type directories without failing migration", async () => {
    const emptyRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pm-migration-empty-root-"));
    try {
      const result = await migrateItemFilesToFormat(emptyRoot, "toon");
      expect(result.scanned).toBe(0);
      expect(result.migrated).toEqual([]);
      expect(result.removed).toEqual([]);
      expect(result.warnings).toEqual([]);
    } finally {
      await fs.rm(emptyRoot, { recursive: true, force: true });
    }
  });

  it("keeps target-format-only items without alternate removal", async () => {
    await withTempPmPath(async ({ pmPath }) => {
      await writeTaskWithFormat(pmPath, "pm-toon-target-only", "toon", "target-only");

      const result = await migrateItemFilesToFormat(pmPath, "toon");
      expect(result.scanned).toBe(1);
      expect(result.migrated).toEqual([]);
      expect(result.removed).toEqual([]);
    });
  });
});
