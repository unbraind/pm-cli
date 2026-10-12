/** @module tests/integration/workspace/legacy-reviewed-settlement */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import capture from "../../fixtures/merge/legacy-reviewed-receipts.json" with { type: "json" };
import { verifyHistoryChainWithVersion } from "../../../src/core/history/replay.js";
import { runCreate } from "../../../src/sdk/lifecycle/create.js";
import { runMergeReconcile } from "../../../src/sdk/merge/reconcile.js";
import { inspectMergeReceiptEvidence } from "../../../src/sdk/merge/receipts.js";
import type { HistoryEntry } from "../../../src/types/index.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

describe("legacy reviewed receipt migration", () => {
  it.each(capture.samples)("requires authenticated migration for captured receipt $receipt.id", async (sample) => {
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
      expect(verifyHistoryChainWithVersion([audit]).ok).toBe(true);
      const inspected = await scan();
      expect(inspected.invalid_evidence_count).toBe(0);
      expect(inspected.receipts).toMatchObject([{ id: sample.receipt.id, state: "pending" }]);
      expect(await readFile(historyPath, "utf8")).toBe(history);
      expect(await readFile(receiptPath, "utf8")).toBe(receiptBytes);
      const forged = { ...audit, context: { merge: { receipts: [{ ...sample.summary, requested_preference_applied: true }] } } };
      expect(verifyHistoryChainWithVersion([forged]).ok).toBe(true);
      await writeFile(historyPath, `${JSON.stringify(forged)}\n`);
      expect((await scan()).receipts).toMatchObject([{ id: sample.receipt.id, state: "pending" }]);
      await writeFile(historyPath, history);
      const preview = await runMergeReconcile({ dryRun: true }, { path: context.pmPath });
      expect(preview.ok).toBe(false);
      expect(preview.guidance).toContainEqual(expect.stringContaining("pm merge reconcile --force --message"));
      expect(await readFile(historyPath, "utf8")).toBe(history);
      expect(await readFile(receiptPath, "utf8")).toBe(receiptBytes);
      await runMergeReconcile({ force: true, message: "Explicit fixture review accepts current values for this historical receipt" }, { path: context.pmPath });
      expect((await scan()).receipts).toEqual([]);
      const migrated = (await readFile(historyPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as HistoryEntry);
      expect(migrated[0].context).toEqual(audit.context);
      expect(migrated[0].ts).toBe(audit.ts);
      expect(migrated.at(-1)).toMatchObject({ op: "merge_reconcile", record_hash_version: 1, message: "Explicit fixture review accepts current values for this historical receipt" });
      expect(verifyHistoryChainWithVersion(migrated).ok).toBe(true);
    });
  });
});
