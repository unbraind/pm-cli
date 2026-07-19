import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanStorageIntegrity } from "../../../src/sdk/governance/storage-integrity.js";

describe("post-merge storage integrity", () => {
  it("returns an empty report for a tracker without storage directories", async () => {
    const pmRoot = await mkdtemp(path.join(os.tmpdir(), "pm-storage-integrity-empty-"));
    try {
      expect(await scanStorageIntegrity(pmRoot, new Set(), { Task: "tasks" })).toMatchObject({
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
    const pmRoot = await mkdtemp(path.join(os.tmpdir(), "pm-storage-integrity-"));
    try {
      await Promise.all([
        mkdir(path.join(pmRoot, "tasks"), { recursive: true }),
        mkdir(path.join(pmRoot, "history"), { recursive: true }),
        mkdir(path.join(pmRoot, "schema"), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(path.join(pmRoot, "tasks", "pm-broken.toon"), "notes[2]:\n  - only-one\n", "utf8"),
        writeFile(path.join(pmRoot, "tasks", "pm-deleted.toon"), "id: pm-deleted\n", "utf8"),
        writeFile(path.join(pmRoot, "history", "pm-conflict.jsonl"), "<<<<<<< ours\n{}\n=======\n{}\n>>>>>>> theirs\n", "utf8"),
        writeFile(path.join(pmRoot, "history", "pm-deleted.jsonl"), `${JSON.stringify({ ts: "2026-07-19T00:00:00.000Z", author: "agent-a", op: "delete", patch: [] })}\n`, "utf8"),
        writeFile(path.join(pmRoot, "settings.json"), "{\n<<<<<<< ours\n", "utf8"),
        writeFile(path.join(pmRoot, "schema", "types.json"), "{", "utf8"),
      ]);

      const result = await scanStorageIntegrity(
        pmRoot,
        new Set(["pm-deleted"]),
        { Task: "tasks" },
      );

      expect(result.item_files_on_disk).toBe(2);
      expect(result.unreadable_item_files).toEqual([
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

      await Promise.all([
        writeFile(path.join(pmRoot, "history", "pm-empty.jsonl"), "\n", "utf8"),
        writeFile(path.join(pmRoot, "history", "pm-invalid.jsonl"), "not-json\n", "utf8"),
        writeFile(path.join(pmRoot, "history", "pm-primitive.jsonl"), "null\n", "utf8"),
        writeFile(path.join(pmRoot, "history", "pm-repair.jsonl"), `${JSON.stringify({ ts: "2026-07-19T01:00:00.000Z", author: "repair", op: "history_repair", patch: [{ op: "replace", path: "/title", value: "fixed" }] })}\n`, "utf8"),
        writeFile(path.join(pmRoot, "history", "pm-missing-author.jsonl"), `${JSON.stringify({ op: "delete", patch: [] })}\n`, "utf8"),
        writeFile(path.join(pmRoot, "tasks", "pm-missing-author.toon"), "id: pm-missing-author\n", "utf8"),
        writeFile(path.join(pmRoot, "history", "README.txt"), "ignored", "utf8"),
        writeFile(path.join(pmRoot, "settings.json"), "{}\n", "utf8"),
        writeFile(path.join(pmRoot, "schema", "types.json"), "{}\n", "utf8"),
        writeFile(path.join(pmRoot, "schema", "README.txt"), "ignored", "utf8"),
      ]);
      const expanded = await scanStorageIntegrity(pmRoot, new Set(["pm-deleted"]), { Task: "tasks" });
      expect(expanded.history_unparseable_streams).toEqual([
        { id: "pm-invalid", path: "history/pm-invalid.jsonl", detail: "newest history line is not valid JSON" },
        { id: "pm-primitive", path: "history/pm-primitive.jsonl", detail: "newest history line is not valid JSON" },
      ]);
      expect(expanded.history_repair_reconciliations).toBe(1);
      expect(expanded.resurrected_items).toContainEqual({ id: "pm-missing-author", deleted_at: "", deleted_by: "" });
      expect(expanded.unparseable_config_files).toEqual([]);
    } finally {
      await rm(pmRoot, { recursive: true, force: true });
    }
  });
});
