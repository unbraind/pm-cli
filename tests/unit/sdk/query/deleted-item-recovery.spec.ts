import {
  formatPmCliErrorForJson,
  classifyPmCliError,
} from "../../../../src/cli/error-guidance.js";
import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { buildDeletedItemError } from "../../../../src/core/history/tombstone.js";
import {
  createHistoryEntry,
  sealHistoryRecord,
} from "../../../../src/core/history/history.js";
import { replayHash } from "../../../../src/core/history/replay.js";
import { getHistoryPath } from "../../../../src/core/store/paths.js";
import type { ItemDocument } from "../../../../src/types/index.js";
import { runGet } from "../../../../src/sdk/query/get.js";
import { withTempPmPath } from "../../../helpers/withTempPmPath.js";

describe("deleted-item recovery", () => {
  it("preserves compacted addresses and refuses ambiguous or corrupt recovery", async () => {
    await withTempPmPath(async (context) => {
      const empty = { metadata: {}, body: "" } as ItemDocument;
      const item: ItemDocument = {
        metadata: {
          id: "legacy",
          title: "Legacy",
          description: "Retained history",
          type: "Task",
          status: "open",
          priority: 2,
          tags: [],
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
        body: "",
      };
      const baseline = createHistoryEntry({
        nowIso: "2026-01-01T00:00:00.000Z",
        author: "fixture",
        op: "history_compact_baseline",
        before: empty,
        after: item,
      });
      const deletion = createHistoryEntry({
        nowIso: "2026-01-02T00:00:00.000Z",
        author: "fixture",
        op: "delete",
        before: item,
        after: empty,
      });
      const streamPath = getHistoryPath(context.pmPath, "legacy");
      await writeFile(streamPath, JSON.stringify(baseline));
      expect(
        await buildDeletedItemError(context.pmPath, "legacy", "pm-"),
      ).toBeUndefined();
      await writeFile(
        streamPath,
        [baseline, deletion].map((entry) => JSON.stringify(entry)).join("\n"),
      );
      expect(
        await buildDeletedItemError(context.pmPath, "legacy", "pm-"),
      ).toMatchObject({
        context: {
          tombstone: { recoverable: true, last_materialized_version: null },
          recovery: {
            suggested_retry_args: ["get", "legacy", "--at", baseline.ts],
          },
        },
      });
      const diagnostic = await buildDeletedItemError(
        context.pmPath,
        "legacy",
        "pm-",
      );
      expect(diagnostic).toBeDefined();
      expect(
        formatPmCliErrorForJson(
          diagnostic!.message,
          diagnostic!.exitCode,
          diagnostic!.context,
        ),
      ).toMatchObject({
        item_id: "legacy",
        tombstone: { deleted: true, recoverable: true },
      });
      expect(
        classifyPmCliError(diagnostic!.message, diagnostic!.context),
      ).toMatchObject({ item_id: "legacy", tombstone: { deleted: true } });
      await writeFile(
        getHistoryPath(context.pmPath, "pm-foreign"),
        [baseline, deletion].map((entry) => JSON.stringify(entry)).join("\n"),
      );
      await expect(
        buildDeletedItemError(context.pmPath, "pm-foreign", "pm-"),
      ).rejects.toMatchObject({ code: "history_replay_invalid" });
      const checkpoint = createHistoryEntry({
        nowIso: baseline.ts,
        author: "fixture",
        op: "history_compact_baseline",
        before: empty,
        after: item,
        context: { history_compaction: { version_offset: 40 } },
      });
      await writeFile(
        streamPath,
        [checkpoint, deletion].map((entry) => JSON.stringify(entry)).join("\n"),
      );
      expect(
        await buildDeletedItemError(context.pmPath, "legacy", "pm-"),
      ).toMatchObject({
        context: { tombstone: { last_materialized_version: 41 } },
      });
      const simultaneousDeletion = createHistoryEntry({
        nowIso: baseline.ts,
        author: "fixture",
        op: "delete",
        before: item,
        after: empty,
      });
      await writeFile(
        streamPath,
        [baseline, simultaneousDeletion]
          .map((entry) => JSON.stringify(entry))
          .join("\n"),
      );
      expect(
        await buildDeletedItemError(context.pmPath, "legacy", "pm-"),
      ).toMatchObject({
        context: {
          tombstone: { recoverable: false },
          recovery: { suggested_retry_args: ["history", "legacy", "--verify"] },
        },
      });
      const restored = createHistoryEntry({
        nowIso: deletion.ts,
        author: "fixture",
        op: "restore",
        before: empty,
        after: item,
      });
      await writeFile(
        streamPath,
        [baseline, deletion, restored]
          .map((entry) => JSON.stringify(entry))
          .join("\n"),
      );
      expect(
        await buildDeletedItemError(context.pmPath, "legacy", "pm-"),
      ).toBeUndefined();
      // Import a retained malformed baseline directly: new-record construction
      // canonicalizes tags, so it cannot reproduce this legacy boundary.
      const invalidItem = {
        metadata: { id: "legacy", tags: "invalid" },
        body: "",
      };
      const invalidBaseline = sealHistoryRecord({
        ts: baseline.ts,
        author: "fixture",
        op: "history_compact_baseline",
        item_hash_version: 3,
        before_hash: replayHash(empty),
        after_hash: replayHash(invalidItem),
        patch: [
          { op: "replace", path: "/metadata", value: invalidItem.metadata },
        ],
      });
      const invalidDeletion = sealHistoryRecord({
        ts: deletion.ts,
        author: "fixture",
        op: "delete",
        item_hash_version: 3,
        before_hash: replayHash(invalidItem),
        after_hash: replayHash(empty),
        patch: [{ op: "replace", path: "/metadata", value: {} }],
      });
      await writeFile(
        streamPath,
        [invalidBaseline, invalidDeletion]
          .map((entry) => JSON.stringify(entry))
          .join("\n"),
      );
      expect(
        await buildDeletedItemError(context.pmPath, "legacy", "pm-"),
      ).toMatchObject({ context: { tombstone: { recoverable: false } } });
      const deletedCheckpoint = createHistoryEntry({
        nowIso: baseline.ts,
        author: "fixture",
        op: "history_compact_baseline",
        before: empty,
        after: empty,
      });
      const noStateDelete = createHistoryEntry({
        nowIso: deletion.ts,
        author: "fixture",
        op: "delete",
        before: empty,
        after: empty,
      });
      await writeFile(
        streamPath,
        [deletedCheckpoint, noStateDelete]
          .map((entry) => JSON.stringify(entry))
          .join("\n"),
      );
      expect(
        await buildDeletedItemError(context.pmPath, "legacy", "pm-"),
      ).toMatchObject({
        context: {
          tombstone: { recoverable: false, last_materialized_version: null },
        },
      });
      await writeFile(
        streamPath,
        JSON.stringify({ ...deletion, record_hash: "corrupt" }),
      );
      await expect(
        buildDeletedItemError(context.pmPath, "legacy", "pm-"),
      ).rejects.toThrow();
    });
  });
  it("distinguishes retained deletion from an unknown id and executes its read recovery", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        [
          "create",
          "--create-mode",
          "progressive",
          "--title",
          "Recoverable work",
          "--type",
          "Task",
          "--json",
        ],
        { expectJson: true },
      );
      expect(created.code).toBe(0);
      const id = (created.json as { item: { id: string } }).item.id;
      expect(
        context.runCli(["delete", id, "--message", "Retain proof"]).code,
      ).toBe(0);
      await expect(runGet(id, { path: context.pmPath })).rejects.toMatchObject({
        code: "item_deleted",
        context: {
          item_id: id,
          tombstone: {
            deleted: true,
            deleted_at: expect.any(String),
            recoverable: true,
            last_materialized_version: 1,
          },
          recovery: { suggested_retry_args: ["get", id, "--at", "1"] },
        },
      });
      const historical = context.runCli(["get", id, "--at", "1", "--json"], {
        expectJson: true,
      });
      expect(historical.code).toBe(0);
      expect(historical.json).toMatchObject({
        item: { id, title: "Recoverable work" },
      });
      const missing = context.runCli(["get", id, "--json"], {
        expectJson: true,
      });
      expect(JSON.parse(missing.stderr)).toMatchObject({
        code: "item_deleted",
        tombstone: {
          deleted: true,
          recoverable: true,
          last_materialized_version: 1,
        },
      });
      const human = context.runCli(["get", id]);
      expect(human.stderr).toContain(`pm get ${id} --at 1`);
      expect(human.stderr).toContain(`pm restore ${id} 1`);
      await expect(
        runGet("pm-doesnotexist", { path: context.pmPath }),
      ).rejects.not.toMatchObject({ code: "item_deleted" });
      expect(context.runCli(["restore", id, "1"]).code).toBe(0);
      expect(await runGet(id, { path: context.pmPath })).toMatchObject({
        item: { id },
      });
    });
  });
});
