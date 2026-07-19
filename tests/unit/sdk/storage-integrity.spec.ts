import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeRuntimeSchemaSettings } from "../../../src/core/schema/runtime-schema.js";
import { scanStorageIntegrity } from "../../../src/sdk/governance/storage-integrity.js";

function itemDocument(
  id: string,
  extraFields: Record<string, unknown> = {},
): string {
  return `${JSON.stringify({
    id,
    title: "Storage integrity fixture",
    description: "",
    type: "Task",
    status: "open",
    priority: 2,
    tags: [],
    created_at: "2026-07-19T00:00:00.000Z",
    updated_at: "2026-07-19T00:00:00.000Z",
    ...extraFields,
  })}\n`;
}

describe("post-merge storage integrity", () => {
  it("returns an empty report for a tracker without storage directories", async () => {
    const pmRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-storage-integrity-empty-"),
    );
    try {
      expect(
        await scanStorageIntegrity(pmRoot, new Set(), { Task: "tasks" }),
      ).toMatchObject({
        item_files_on_disk: 0,
        history_streams_scanned: 0,
        config_files_scanned: 0,
        unreadable_item_files: [],
        unparseable_config_files: [],
      });
    } finally {
      await rm(pmRoot, { recursive: true, force: true });
    }
  });

  it("surfaces unreadable items, conflict markers, resurrection, and invalid config", async () => {
    const pmRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-storage-integrity-"),
    );
    try {
      await Promise.all([
        mkdir(path.join(pmRoot, "tasks"), { recursive: true }),
        mkdir(path.join(pmRoot, "features"), { recursive: true }),
        mkdir(path.join(pmRoot, "history"), { recursive: true }),
        mkdir(path.join(pmRoot, "schema"), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          path.join(pmRoot, "tasks", "pm-broken.toon"),
          "notes[2]:\n  - only-one\n",
          "utf8",
        ),
        writeFile(
          path.join(pmRoot, "tasks", "pm-duplicate.md"),
          itemDocument("pm-duplicate"),
          "utf8",
        ),
        writeFile(
          path.join(pmRoot, "features", "pm-duplicate.toon"),
          "notes[2]:\n  - only-one\n",
          "utf8",
        ),
        writeFile(
          path.join(pmRoot, "tasks", "pm-deleted.md"),
          itemDocument("pm-deleted"),
          "utf8",
        ),
        writeFile(
          path.join(pmRoot, "tasks", "pm-schema-duplicate.md"),
          itemDocument("pm-schema-duplicate"),
          "utf8",
        ),
        writeFile(
          path.join(pmRoot, "features", "pm-schema-duplicate.md"),
          itemDocument("pm-schema-duplicate", { undeclared_field: true }),
          "utf8",
        ),
        writeFile(
          path.join(pmRoot, "tasks", "pm-extension-duplicate.md"),
          itemDocument("pm-extension-duplicate"),
          "utf8",
        ),
        writeFile(
          path.join(pmRoot, "features", "pm-extension-duplicate.md"),
          itemDocument("pm-extension-duplicate", { extension_owned: true }),
          "utf8",
        ),
        writeFile(
          path.join(pmRoot, "history", "pm-conflict.jsonl"),
          "<<<<<<< ours\n{}\n=======\n{}\n>>>>>>> theirs\n",
          "utf8",
        ),
        writeFile(
          path.join(pmRoot, "history", "pm-deleted.jsonl"),
          `${JSON.stringify({ ts: "2026-07-19T00:00:00.000Z", author: "agent-a", op: "delete", patch: [] })}\n`,
          "utf8",
        ),
        writeFile(
          path.join(pmRoot, "settings.json"),
          "{\n<<<<<<< ours\n",
          "utf8",
        ),
        writeFile(path.join(pmRoot, "schema", "types.json"), "{", "utf8"),
      ]);

      const result = await scanStorageIntegrity(
        pmRoot,
        new Set([
          "pm-deleted",
          "pm-duplicate",
          "pm-schema-duplicate",
          "pm-extension-duplicate",
        ]),
        { Feature: "features", Task: "tasks" },
      );

      expect(result.item_files_on_disk).toBe(8);
      expect(result.unreadable_item_files).toEqual([
        { id: "pm-duplicate", path: "features/pm-duplicate.toon" },
        { id: "pm-broken", path: "tasks/pm-broken.toon" },
      ]);
      expect(result.history_conflict_marker_streams).toMatchObject([
        { id: "pm-conflict", line: 1 },
      ]);
      expect(result.resurrected_items).toEqual([
        {
          id: "pm-deleted",
          deleted_at: "2026-07-19T00:00:00.000Z",
          deleted_by: "agent-a",
        },
      ]);
      expect(result.unparseable_config_files.map((row) => row.path)).toEqual([
        "settings.json",
        "schema/types.json",
      ]);

      const schemaAware = await scanStorageIntegrity(
        pmRoot,
        new Set([
          "pm-deleted",
          "pm-duplicate",
          "pm-schema-duplicate",
          "pm-extension-duplicate",
        ]),
        { Feature: "features", Task: "tasks" },
        {
          schema: normalizeRuntimeSchemaSettings({
            unknown_field_policy: "reject",
            fields: [],
          }),
          extensionFieldNames: ["extension_owned"],
        },
      );
      expect(schemaAware.unreadable_item_files).toContainEqual({
        id: "pm-schema-duplicate",
        path: "features/pm-schema-duplicate.md",
      });
      expect(schemaAware.unreadable_item_files).not.toContainEqual({
        id: "pm-extension-duplicate",
        path: "features/pm-extension-duplicate.md",
      });

      await Promise.all([
        writeFile(path.join(pmRoot, "history", "pm-empty.jsonl"), "\n", "utf8"),
        writeFile(
          path.join(pmRoot, "history", "pm-invalid.jsonl"),
          "not-json\n",
          "utf8",
        ),
        writeFile(
          path.join(pmRoot, "history", "pm-invalid-middle.jsonl"),
          `${JSON.stringify({ op: "create", patch: [] })}\nnot-json\n${JSON.stringify({ op: "update", patch: [] })}\n`,
          "utf8",
        ),
        writeFile(
          path.join(pmRoot, "history", "pm-primitive.jsonl"),
          "null\n",
          "utf8",
        ),
        writeFile(
          path.join(pmRoot, "history", "pm-repair.jsonl"),
          `${JSON.stringify({ ts: "2026-07-19T01:00:00.000Z", author: "repair", op: "history_repair", patch: [{ op: "replace", path: "/title", value: "fixed" }] })}\n`,
          "utf8",
        ),
        writeFile(
          path.join(pmRoot, "history", "pm-missing-author.jsonl"),
          `${JSON.stringify({ op: "delete", patch: [] })}\n`,
          "utf8",
        ),
        writeFile(
          path.join(pmRoot, "tasks", "pm-missing-author.md"),
          itemDocument("pm-missing-author"),
          "utf8",
        ),
        writeFile(
          path.join(pmRoot, "history", "README.txt"),
          "ignored",
          "utf8",
        ),
        writeFile(path.join(pmRoot, "settings.json"), "{}\n", "utf8"),
        writeFile(path.join(pmRoot, "schema", "types.json"), "{}\n", "utf8"),
        writeFile(path.join(pmRoot, "schema", "README.txt"), "ignored", "utf8"),
      ]);
      const expanded = await scanStorageIntegrity(
        pmRoot,
        new Set([
          "pm-deleted",
          "pm-duplicate",
          "pm-schema-duplicate",
          "pm-extension-duplicate",
        ]),
        { Feature: "features", Task: "tasks" },
      );
      expect(expanded.history_unparseable_streams).toEqual([
        {
          id: "pm-invalid-middle",
          path: "history/pm-invalid-middle.jsonl",
          line: 2,
          detail: "history line is not a valid JSON object",
        },
        {
          id: "pm-invalid",
          path: "history/pm-invalid.jsonl",
          line: 1,
          detail: "history line is not a valid JSON object",
        },
        {
          id: "pm-primitive",
          path: "history/pm-primitive.jsonl",
          line: 1,
          detail: "history line is not a valid JSON object",
        },
      ]);
      expect(expanded.history_repair_reconciliations).toBe(1);
      expect(expanded.resurrected_items).toContainEqual({
        id: "pm-missing-author",
        deleted_at: "",
        deleted_by: "",
      });
      expect(expanded.unparseable_config_files).toEqual([]);
    } finally {
      await rm(pmRoot, { recursive: true, force: true });
    }
  });
});
