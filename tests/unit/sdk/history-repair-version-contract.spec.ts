import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import jsonPatch from "fast-json-patch";
import { describe, expect, it } from "vitest";
import {
  cloneEmptyReplayDocument,
  reanchorHistoryEntries,
  replayHash,
  replayHashVerificationCandidates,
  resolveHistoryRepairItemHashVersion,
  tryApplyReplayPatch,
  verifyHistoryChainWithVersion,
  type ReplayDocument,
} from "../../../src/core/history/replay.js";
import type { HistoryEntry, HistoryPatchOp } from "../../../src/types.js";
import { CURRENT_HISTORY_ITEM_HASH_VERSION } from "../../../src/core/history/history.js";
import { runHistoryRepair } from "../../../src/sdk/history-repair.js";
import type { MergeDecisionReceipt } from "../../../src/sdk/merge/receipts.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

function historyEntry(version: 1 | 2, explicitVersion: boolean): HistoryEntry {
  const before = cloneEmptyReplayDocument();
  const after: ReplayDocument = {
    metadata: {
      id: "pm-epoch",
      title: "Stable repair epoch",
      type: "Task",
      status: "open",
      priority: 1,
      tags: [],
      tests: [
        { command: "z-command", scope: "project" },
        { command: "a-command", scope: "project" },
      ],
    },
    body: "",
  };
  return {
    ts: "2026-08-15T00:00:00.000Z",
    author: "epoch-test",
    op: "create",
    patch: jsonPatch.compare(before, after) as HistoryPatchOp[],
    before_hash: replayHash(before, version),
    after_hash: replayHash(after, version),
    ...(explicitVersion ? { item_hash_version: version } : {}),
  };
}

describe("history repair hash epoch contract", () => {
  it("keeps an implicit legacy stream byte-stable", () => {
    const entries = [historyEntry(1, false)];
    expect(resolveHistoryRepairItemHashVersion(entries)).toBe(1);
    const repaired = reanchorHistoryEntries(entries);
    expect(repaired.entries).toEqual(entries);
    expect(repaired.entriesRehashed).toBe(0);
    expect(repaired.explicitItemHashVersion).toBe(false);
    expect(verifyHistoryChainWithVersion(repaired.entries)).toMatchObject({
      ok: true,
      item_hash_version: 1,
    });
  });

  it("keeps an explicit current stream on its declared epoch", () => {
    const entries = [historyEntry(2, true)];
    const repaired = reanchorHistoryEntries(entries);
    expect(repaired.entries).toEqual(entries);
    expect(repaired.itemHashVersion).toBe(2);
    expect(repaired.explicitItemHashVersion).toBe(true);
  });

  it("converges after repairing drift instead of alternating epochs", () => {
    const drifted = [
      {
        ...historyEntry(1, false),
        after_hash: "0".repeat(64),
      },
    ];
    const first = reanchorHistoryEntries(drifted);
    const second = reanchorHistoryEntries(first.entries);
    expect(first.itemHashVersion).toBe(1);
    expect(second.entries).toEqual(first.entries);
    expect(second.entriesRehashed).toBe(0);
  });

  it("falls forward only for an irreconcilably mixed explicit stream", () => {
    const mixed = [historyEntry(1, true), historyEntry(2, true)];
    expect(resolveHistoryRepairItemHashVersion(mixed)).toBe(
      CURRENT_HISTORY_ITEM_HASH_VERSION,
    );
  });

  it("keeps one consistent explicit epoch on a drifted stream", () => {
    const drifted = [{ ...historyEntry(1, true), after_hash: "0".repeat(64) }];
    expect(resolveHistoryRepairItemHashVersion(drifted)).toBe(1);
    const repaired = reanchorHistoryEntries(drifted);
    expect(repaired.itemHashVersion).toBe(1);
    expect(repaired.explicitItemHashVersion).toBe(true);
    expect(verifyHistoryChainWithVersion(repaired.entries)).toMatchObject({
      ok: true,
      item_hash_version: 1,
    });
  });

  it("does not reconcile an on-disk item that matches the legacy epoch-2 candidate", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        [
          "create",
          "--title",
          "Legacy candidate repair",
          "--description",
          "Candidate-aware reconciliation fixture",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--json",
        ],
        { expectJson: true },
      );
      const id = (created.json as { item: { id: string } }).item.id;
      expect(
        context.runCli([
          "test",
          id,
          "--add",
          "command=echo candidate,scope=project",
          "--json",
        ]).code,
      ).toBe(0);
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      const entries = (await readFile(historyPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as HistoryEntry);
      let replay = cloneEmptyReplayDocument();
      for (const entry of entries) {
        const applied = tryApplyReplayPatch(replay, entry.patch);
        expect(applied.ok).toBe(true);
        if (!applied.ok) {
          throw new Error("fixture history patch did not apply");
        }
        const beforeCandidates = replayHashVerificationCandidates(replay, 2);
        const afterCandidates = replayHashVerificationCandidates(
          applied.document,
          2,
        );
        entry.before_hash = beforeCandidates[1];
        entry.after_hash = afterCandidates[1];
        entry.item_hash_version = 2;
        delete entry.record_hash;
        delete entry.record_hash_version;
        replay = applied.document;
      }
      expect(replayHashVerificationCandidates(replay, 2)[0]).not.toBe(
        replayHashVerificationCandidates(replay, 2)[1],
      );
      await writeFile(
        historyPath,
        `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
        "utf8",
      );

      const repaired = await runHistoryRepair(
        id,
        { dryRun: true },
        { path: context.pmPath },
      );
      expect(repaired.changed).toBe(false);
      expect(repaired.history).toMatchObject({
        entries_rehashed: 0,
        reconciled_with_item: false,
      });
    });
  });

  it("labels only a mixed explicit repair receipt as ambiguous", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        [
          "create",
          "--title",
          "Mixed epoch receipt",
          "--description",
          "History repair receipt fixture",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--json",
        ],
        { expectJson: true },
      );
      const id = (created.json as { item: { id: string } }).item.id;
      context.runCli([
        "update",
        id,
        "--description",
        "Second history event",
        "--message",
        "Create mixed epoch fixture",
        "--json",
      ]);
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      const entries = (await readFile(historyPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as HistoryEntry);
      entries[0] = { ...entries[0], item_hash_version: 1 };
      entries[1] = { ...entries[1], item_hash_version: 2 };
      for (const entry of entries) {
        delete entry.record_hash;
        delete entry.record_hash_version;
      }
      await writeFile(
        historyPath,
        `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
        "utf8",
      );

      const repaired = await runHistoryRepair(
        id,
        { dryRun: true },
        { path: context.pmPath },
      );
      expect(repaired.history).toMatchObject({
        item_hash_version_before: 2,
        item_hash_version_after: 2,
        version_disposition: "selected_for_ambiguous_stream",
      });
    });
  });

  it("refuses caller-supplied durable receipt objects absent authoritative files", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        [
          "create",
          "--title",
          "Receipt authentication",
          "--description",
          "Reject forged SDK receipt input",
          "--type",
          "Task",
          "--status",
          "open",
          "--priority",
          "1",
          "--json",
        ],
        { expectJson: true },
      );
      const id = (created.json as { item: { id: string } }).item.id;
      const forgedReceipt: MergeDecisionReceipt = {
        version: 1,
        id: "forged-durable-receipt",
        item_path: `.agents/pm/issues/${id}.toon`,
        item_id: id,
        requested_preference: "ours",
        conflict_resolution: "preferred_side",
        fields_from_theirs: ["status"],
        union_fields: [],
        merged_field_hashes: { status: "0".repeat(64) },
        decisions: [],
        state: "pending",
        created_at: "2026-08-29T00:00:00.000Z",
        value_availability: "hash_only",
        evidence_source: "durable",
      };

      const result = await runHistoryRepair(
        id,
        {
          dryRun: true,
          mergeReceiptProof: {
            gitWorkspaceRoot: context.tempRoot,
            receipts: [forgedReceipt],
          },
        },
        { path: context.pmPath },
      );
      expect(result.merge_receipt_proof).toEqual({
        trusted: false,
        reason: "no_item_receipts",
        receipt_ids: [],
      });
      await expect(
        runHistoryRepair(
          id,
          {
            mergeReceiptProof: {
              gitWorkspaceRoot: context.tempRoot,
              receipts: [forgedReceipt],
            },
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject({
        context: {
          code: "merge_reconcile_receipt_evidence_untrusted",
          required: expect.stringContaining(
            "authoritative clone-local or durable receipt evidence",
          ),
        },
      });
    });
  });
});
