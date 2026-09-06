import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  sha256Hex,
  stableStringify,
} from "../../src/core/shared/serialization.js";
import { runMergeReconcile } from "../../src/sdk/merge/reconcile.js";
import {
  inspectMergeReceiptEvidence,
  markMergeReceiptReconciled,
  writeMergeReceipt,
  type MergeDecisionReceipt,
} from "../../src/sdk/merge/receipts.js";
import { hashItemScalarDecisionValue } from "../../src/sdk/merge/three-way.js";
import { createTestItemId } from "../helpers/itemFactory.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("merge recovery parity", () => {
  it("refuses stale receipt proof equally in preview and apply without changing evidence", async () => {
    await withTempPmPath(async (context) => {
      execFileSync("git", ["init", "-q"], { cwd: context.tempRoot });
      const id = createTestItemId(context, {
        title: "Receipt followed by legitimate comments",
      });
      const receipt = await writeMergeReceipt({
        cwd: context.tempRoot,
        itemPath: `.agents/pm/tasks/${id}.toon`,
        preferred: "ours",
        fieldsFromTheirs: [],
        unionFields: ["comments"],
        mergedFieldHashes: { comments: hashItemScalarDecisionValue([]) },
        decisions: [],
      });
      expect(
        context.runCli(["comments", id, "A later legitimate observation"]).code,
      ).toBe(0);
      const historyPath = path.join(context.pmPath, "history", `${id}.jsonl`);
      const before = await readFile(historyPath, "utf8");
      const preview = await runMergeReconcile(
        { dryRun: true },
        { path: context.pmPath },
      );
      const applied = await runMergeReconcile({}, { path: context.pmPath });
      expect(preview.repair.streams).toEqual(applied.repair.streams);
      expect(preview.repair.totals).toEqual({
        repaired: 0,
        skipped_clean: 0,
        failed: 1,
      });
      expect(preview.repair.streams[0]?.error).toContain(
        "no_receipt_set_proves_snapshot",
      );
      expect(await readFile(historyPath, "utf8")).toBe(before);
      expect(
        (await inspectMergeReceiptEvidence(context.tempRoot)).receipts,
      ).toMatchObject([{ id: receipt?.id, state: "pending" }]);
    });
  });

  it("verifies legacy scalar redactions through settlement and refuses tampered copies", async () => {
    await withTempPmPath(async (context) => {
      execFileSync("git", ["init", "-q"], { cwd: context.tempRoot });
      const id = createTestItemId(context, { title: "Legacy hash redaction" });
      const receipt = await writeMergeReceipt({
        cwd: context.tempRoot,
        itemPath: `.agents/pm/tasks/${id}.toon`,
        preferred: "ours",
        fieldsFromTheirs: [],
        unionFields: [],
        decisions: [
          {
            field: "status",
            base: "open",
            ours: "closed",
            theirs: "open",
            retained: "closed",
            discarded: "open",
          },
        ],
      });
      expect(receipt).not.toBeNull();
      const durablePath = path.join(
        context.pmPath,
        "merge-receipts",
        `${receipt!.id}.json`,
      );
      const durable = JSON.parse(
        await readFile(durablePath, "utf8"),
      ) as MergeDecisionReceipt;
      delete durable.value_policy;
      durable.value_availability = "hash_only";
      durable.decisions[0]!.retained = {
        pm_value_hash: sha256Hex(stableStringify("closed")),
      };
      durable.decisions[0]!.discarded = {
        pm_value_hash: sha256Hex(stableStringify("open")),
      };
      await writeFile(durablePath, JSON.stringify(durable));
      expect(
        (await inspectMergeReceiptEvidence(context.tempRoot))
          .invalid_evidence_count,
      ).toBe(0);
      await markMergeReceiptReconciled(context.tempRoot, receipt!);
      expect(
        (
          await inspectMergeReceiptEvidence(context.tempRoot, {
            includeReconciled: true,
          })
        ).receipts,
      ).toMatchObject([{ state: "reconciled" }]);
      durable.decisions[0]!.retained = {
        pm_value_hash: sha256Hex(stableStringify("canceled")),
      };
      await writeFile(durablePath, JSON.stringify(durable));
      expect(
        (await inspectMergeReceiptEvidence(context.tempRoot)).invalid_evidence,
      ).toMatchObject([{ reason: "copy_provenance_mismatch" }]);
      await expect(
        markMergeReceiptReconciled(context.tempRoot, receipt!),
      ).rejects.toThrow("disagree");
    });
  });
});
