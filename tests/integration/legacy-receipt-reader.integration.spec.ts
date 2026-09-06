import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  inspectMergeReceiptEvidence,
  markMergeReceiptReconciled,
  writeMergeReceipt,
} from "../../src/sdk/merge/receipts.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

describe("legacy receipt reader", () => {
  it("preserves undefined writer inputs and reads the prior requested-preference encoding", async () => {
    await withTempPmPath(async (context) => {
      execFileSync("git", ["init", "-q"], { cwd: context.tempRoot });
      const receipt = await writeMergeReceipt({
        cwd: context.tempRoot,
        itemPath: ".agents/pm/tasks/pm-roundtrip.toon",
        preferred: "ours",
        fieldsFromTheirs: [],
        unionFields: [],
        decisions: [
          {
            field: "description",
            base: undefined,
            ours: undefined,
            theirs: "discarded",
            retained: undefined,
            discarded: "discarded",
          },
        ],
      });
      expect(receipt).not.toBeNull();
      const file = path.join(
        context.tempRoot,
        ".git",
        "pm-merge-receipts",
        `${receipt!.id}.json`,
      );
      const persisted = JSON.parse(await readFile(file, "utf8")) as Record<
        string,
        unknown
      >;
      expect(persisted.decisions).toMatchObject([
        {
          base: { pm_item_scalar_missing: true },
          ours: { pm_item_scalar_missing: true },
          retained: { pm_item_scalar_missing: true },
        },
      ]);
      expect(
        (await inspectMergeReceiptEvidence(context.tempRoot))
          .invalid_evidence_count,
      ).toBe(0);
      // The 2026.9.4 writer cloned SDK decisions without encoding undefined slots.
      const { base: _base, ...historicalDecision } = (
        persisted.decisions as Record<string, unknown>[]
      )[0]!;
      persisted.decisions = [historicalDecision];
      const historicalBytes = JSON.stringify(persisted);
      await writeFile(file, historicalBytes);
      const historical = await inspectMergeReceiptEvidence(context.tempRoot);
      expect(historical.invalid_evidence_count).toBe(0);
      expect(historical.receipts[0]?.decisions[0]?.base).toEqual({
        pm_item_scalar_missing: true,
      });
      expect(await readFile(file, "utf8")).toBe(historicalBytes);
      await markMergeReceiptReconciled(
        context.tempRoot,
        historical.receipts[0]!,
      );
      expect(
        (
          await inspectMergeReceiptEvidence(context.tempRoot, {
            includeReconciled: true,
          })
        ).receipts[0]?.state,
      ).toBe("reconciled");
    });
  });

  it("normalizes omitted legacy undefined scalars without modifying source bytes on reads", async () => {
    await withTempPmPath(async (context) => {
      execFileSync("git", ["init", "-q"], { cwd: context.tempRoot });
      const directory = path.join(
        context.tempRoot,
        ".git",
        "pm-merge-receipts",
      );
      await mkdir(directory);
      const file = path.join(directory, "legacy-missing-base.json");
      const raw = JSON.stringify({
        version: 1,
        id: "legacy-missing-base",
        item_id: "pm-legacy",
        item_path: ".agents/pm/tasks/pm-legacy.toon",
        preferred: "ours",
        fields_from_theirs: [],
        union_fields: [],
        decisions: [
          {
            field: "description",
            ours: "ours",
            theirs: "theirs",
            retained: "ours",
            discarded: "theirs",
          },
        ],
        state: "pending",
        created_at: "2026-08-01T00:00:00.000Z",
      });
      await writeFile(file, raw);
      const read = await inspectMergeReceiptEvidence(context.tempRoot);
      expect(read.invalid_evidence_count).toBe(0);
      expect(read.receipts[0]?.decisions[0]?.base).toEqual({
        pm_item_scalar_missing: true,
      });
      expect(await readFile(file, "utf8")).toBe(raw);
      await markMergeReceiptReconciled(context.tempRoot, read.receipts[0]!);
      expect(
        (
          await inspectMergeReceiptEvidence(context.tempRoot, {
            includeReconciled: true,
          })
        ).receipts[0]?.state,
      ).toBe("reconciled");
      await writeFile(
        file,
        raw.replace('"union_fields":[]', '"union_fields":null'),
      );
      expect(
        (await inspectMergeReceiptEvidence(context.tempRoot)).invalid_evidence,
      ).toMatchObject([
        { validation_error: "collections", validation_path: "union_fields" },
      ]);
    });
  });
});
