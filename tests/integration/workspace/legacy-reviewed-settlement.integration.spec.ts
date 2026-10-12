/** @module tests/integration/workspace/legacy-reviewed-settlement */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import capture from "../../fixtures/merge/legacy-reviewed-receipts.json" with { type: "json" };
import { sealHistoryRecord } from "../../../src/core/history/history.js";
import { runCreate } from "../../../src/sdk/lifecycle/create.js";
import { runMergeReconcile } from "../../../src/sdk/merge/reconcile.js";
import { inspectMergeReceiptEvidence } from "../../../src/sdk/merge/receipts.js";
import type { HistoryEntry } from "../../../src/types/index.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("legacy reviewed receipt settlement", () => {
  it.each(capture.samples)("preserves captured reviewed receipt $receipt.id without rewriting legacy history", async (sample) => {
    await withTempPmPath(async (context) => {
      await runCreate({ id: sample.receipt.item_id, title: "Legacy receipt", type: "Task", createMode: "progressive" }, { path: context.pmPath });
      const historyPath = path.join(context.pmPath, "history", `${sample.receipt.item_id}.jsonl`);
      const genesis = JSON.parse((await readFile(historyPath, "utf8")).trim()) as HistoryEntry;
      const { record_hash: _hash, record_hash_version: _version, ...legacy } = genesis;
      const audit: HistoryEntry = { ...legacy, op: "merge_reconcile", ts: sample.audit_timestamp,
        context: { merge: { receipts: [sample.summary] } },
      };
      const history = `${JSON.stringify(audit)}\n`;
      await writeFile(historyPath, history);
      const directory = path.join(context.pmPath, "merge-receipts");
      await mkdir(directory, { recursive: true });
      const receiptPath = path.join(directory, `${sample.receipt.id}.json`);
      const receiptBytes = `${JSON.stringify(sample.receipt)}\n`;
      await writeFile(receiptPath, receiptBytes);
      const scan = () => inspectMergeReceiptEvidence(context.tempRoot, { pmRoot: context.pmPath });
      expect((await scan()).invalid_evidence_count).toBe(0);
      expect((await scan()).receipts).toEqual([]);
      expect(await readFile(historyPath, "utf8")).toBe(history);
      expect(await readFile(receiptPath, "utf8")).toBe(receiptBytes);

      for (const changed of [
        { ...audit, op: "update" },
        { ...audit, ts: "2026-10-12T00:00:00.000Z" },
        { ...audit, ts: "2026-08-01T00:00:00.000Z" },
        ...[null, [], "invalid"].map((summary) => ({ ...audit, context: { merge: { receipts: [summary] } } })),
        ...["requested_preference_applied", "requested_preference", "conflict_resolution"].map(
          (field) => ({ ...audit, context: { merge: { receipts: [{ ...sample.summary, [field]: null }] } } }),
        ),
        { ...audit, context: { merge: { receipts: [{ ...sample.summary, preferred: "theirs" }] } } },
        { ...audit, context: { merge: { receipts: [{ ...sample.summary, item_id: "pm-wrong" }] } } },
        { ...audit, context: { merge: { receipts: [{ ...sample.summary, union_fields: ["tags"] }] } } },
        sealHistoryRecord({ ...audit, context: { merge: { receipts: [{ ...sample.summary, decisions: [] }] } } }),
      ]) {
        await writeFile(historyPath, `${JSON.stringify(changed)}\n`);
        expect((await scan()).receipts).toMatchObject([{ id: sample.receipt.id, state: "pending" }]);
      }
      await writeFile(historyPath, history);
      for (const modernEvidence of [
        { value_policy: "bounded_non_sensitive_scalars_v1" },
        { merged_field_hashes: { title: "a".repeat(64) } },
        { operation: { kind: "merge", original_head: "a".repeat(40), original_blob: "b".repeat(40) } },
        { created_at: "2026-10-12T00:00:00.000Z", reconciled_at: "2026-10-12T00:00:01.000Z" },
      ]) {
        await writeFile(receiptPath, `${JSON.stringify({ ...sample.receipt, ...modernEvidence })}\n`);
        expect((await scan()).receipts).toMatchObject([{ id: sample.receipt.id, state: "pending" }]);
      }
      const { requested_preference, conflict_resolution: _policy, ...preferredSummary } = sample.summary;
      await writeFile(historyPath, `${JSON.stringify({ ...audit, context: { merge: { receipts: [{ ...preferredSummary, preferred: requested_preference }] } } })}\n`);
      await writeFile(receiptPath, `${JSON.stringify({ ...sample.receipt, conflict_resolution: "preferred_side" })}\n`);
      expect((await scan()).receipts).toEqual([]);
      await writeFile(receiptPath, receiptBytes);
      await writeFile(historyPath, `${JSON.stringify({ ...audit, context: undefined })}\n`);
      const preview = await runMergeReconcile({ dryRun: true }, { path: context.pmPath });
      expect(preview.ok).toBe(false);
      expect(preview.guidance).toContainEqual(expect.stringContaining('pm merge reconcile --force --message'));
      expect(await readFile(receiptPath, "utf8")).toBe(receiptBytes);
    });
  });
});
