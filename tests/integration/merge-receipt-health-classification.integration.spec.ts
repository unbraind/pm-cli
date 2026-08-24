/**
 * @module tests/integration/merge-receipt-health-classification
 *
 * Proves health and validation distinguish lossless merge provenance from a
 * scalar decision that discarded a competing value.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { writeMergeReceipt } from "../../src/sdk/merge/receipts.js";
import { withTempPmPath } from "../helpers/withTempPmPath.js";

interface DiagnosticEnvelope {
  ok: boolean;
  warnings: string[];
  checks: Array<{
    name: string;
    details: Record<string, unknown>;
  }>;
}

function checkDetails(
  result: DiagnosticEnvelope,
  name: string,
): Record<string, unknown> {
  return result.checks.find((check) => check.name === name)?.details ?? {};
}

describe("merge receipt health classification", () => {
  it("keeps lossless receipt settlement distinct from lossy review", async () => {
    await withTempPmPath(async (context) => {
      execFileSync("git", ["init", "--quiet"], { cwd: context.tempRoot });
      expect(
        context.runCli(["merge", "install", "--json"], {
          cwd: context.tempRoot,
        }).code,
      ).toBe(0);
      expect(
        context.runCli(
          [
            "create",
            "--json",
            "--id",
            "merge-lossless",
            "--title",
            "Lossless merge receipt",
            "--description",
            "Exercise pending receipt health classification",
            "--type",
            "Task",
          ],
          { cwd: context.tempRoot },
        ).code,
      ).toBe(0);

      await writeMergeReceipt({
        cwd: context.tempRoot,
        itemPath: ".agents/pm/tasks/merge-lossless.toon",
        preferred: "ours",
        fieldsFromTheirs: ["status"],
        unionFields: ["comments"],
        decisions: [],
      });

      const health = context.runCli(
        ["health", "--check-only", "--full", "--json"],
        { cwd: context.tempRoot, expectJson: true },
      );
      expect(health.code).toBe(0);
      const healthResult = health.json as DiagnosticEnvelope;
      expect(healthResult.ok).toBe(false);
      expect(healthResult.warnings).toContain("merge_receipts_pending:1");
      expect(checkDetails(healthResult, "integrity").counts).toMatchObject({
        pending_merge_decisions: 0,
        lossless_merge_receipts: 1,
      });
      expect(
        checkDetails(healthResult, "integrity").remediation_map,
      ).toMatchObject({
        merge_receipts_pending: "pm merge reconcile --dry-run",
      });

      const validation = context.runCli(
        ["validate", "--check-storage-integrity", "--json"],
        { cwd: context.tempRoot, expectJson: true },
      );
      expect(validation.code).toBe(0);
      expect(
        checkDetails(
          validation.json as DiagnosticEnvelope,
          "storage_integrity",
        ),
      ).toMatchObject({
        pending_merge_decision_count: 0,
        lossless_merge_receipt_count: 1,
      });

      expect(
        context.runCli(["history-repair", "merge-lossless", "--json"], {
          cwd: context.tempRoot,
        }).code,
      ).toBe(0);
      const healthAfterHistoryRepair = context.runCli(
        ["health", "--check-only", "--full", "--json"],
        { cwd: context.tempRoot, expectJson: true },
      );
      expect(
        (healthAfterHistoryRepair.json as DiagnosticEnvelope).warnings,
      ).toContain("merge_receipts_pending:1");

      const reconciled = context.runCli(["merge", "reconcile", "--json"], {
        cwd: context.tempRoot,
        expectJson: true,
      });
      expect(reconciled.code).toBe(0);
      expect(reconciled.json).toMatchObject({
        ok: true,
        receipts: { pending_before: 1, reconciled: 1 },
      });
      const healthAfterReconcile = context.runCli(
        ["health", "--check-only", "--full", "--json"],
        { cwd: context.tempRoot, expectJson: true },
      );
      expect(
        (healthAfterReconcile.json as DiagnosticEnvelope).warnings,
      ).not.toContain("merge_receipts_pending:1");

      await writeMergeReceipt({
        cwd: context.tempRoot,
        itemPath: ".agents/pm/tasks/pm-lossy.toon",
        preferred: "ours",
        fieldsFromTheirs: [],
        unionFields: [],
        decisions: [
          {
            field: "title",
            base: "base",
            ours: "alpha",
            theirs: "zeta",
            retained: "alpha",
            discarded: "zeta",
          },
        ],
      });

      const lossyHealth = context.runCli(
        ["health", "--check-only", "--full", "--json"],
        { cwd: context.tempRoot, expectJson: true },
      );
      expect(lossyHealth.code).toBe(0);
      const lossyHealthResult = lossyHealth.json as DiagnosticEnvelope;
      expect(lossyHealthResult.ok).toBe(false);
      expect(lossyHealthResult.warnings).toContain(
        "merge_decisions_unreviewed:1",
      );
      expect(lossyHealthResult.warnings).not.toContain(
        "merge_receipts_pending:1",
      );

      const lossyValidation = context.runCli(
        ["validate", "--check-storage-integrity", "--json"],
        { cwd: context.tempRoot, expectJson: true },
      );
      expect(lossyValidation.code).toBe(0);
      const lossyValidationResult = lossyValidation.json as DiagnosticEnvelope;
      expect(lossyValidationResult.warnings).toContain(
        "validate_merge_decisions_unreviewed:1",
      );
      expect(
        checkDetails(lossyValidationResult, "storage_integrity"),
      ).toMatchObject({
        pending_merge_decision_count: 1,
        lossless_merge_receipt_count: 0,
      });
    });
  });
});
