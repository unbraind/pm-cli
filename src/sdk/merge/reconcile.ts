/**
 * @module sdk/merge/reconcile
 *
 * Provides the post-merge SDK workflow that previews or repairs every drifted
 * item-history stream, then verifies history and storage integrity in one call.
 */
import type { GlobalOptions } from "../../core/shared/command-types.js";
import {
  runHistoryRepairAll,
  type HistoryRepairAllResult,
} from "../history-repair.js";
import {
  runValidate,
  type ValidateResult,
} from "../governance/validate.js";

/** Options for the audited post-merge reconciliation workflow. */
export interface MergeReconcileOptions {
  /** Preview drifted streams without mutating history. */
  dryRun?: boolean;
  /** Attribution recorded on repair audit entries. */
  author?: string;
  /** Human-readable reason recorded on repair audit entries. */
  message?: string;
  /** Permit ownership overrides already supported by history repair. */
  force?: boolean;
}

/** Structured post-merge reconciliation and verification result. */
export interface MergeReconcileResult {
  /** Whether reconciliation completed without repair or verification failures. */
  ok: boolean;
  /** Whether this invocation only previewed repairs. */
  dry_run: boolean;
  /** Bulk history repair preview or apply result. */
  repair: HistoryRepairAllResult;
  /** Post-operation history-drift and storage-integrity validation. */
  validation: ValidateResult;
  /** Stable next-step guidance for Git hooks and interactive agents. */
  guidance: string[];
  /** ISO timestamp copied from the validation pass. */
  generated_at: string;
}

/**
 * Preview or apply post-merge history reconciliation and immediately validate
 * the two merge-critical invariants. The default remains explicit and safe:
 * callers opt into this command after Git finishes; installing merge drivers
 * does not silently install or mutate repository hooks.
 */
export async function runMergeReconcile(
  options: MergeReconcileOptions,
  global: GlobalOptions,
): Promise<MergeReconcileResult> {
  const dryRun = options.dryRun === true;
  const repair = await runHistoryRepairAll(
    {
      dryRun,
      author: options.author ?? global.author,
      message:
        options.message ??
        "post-merge reconciliation of field-aware tracker history",
      force: options.force,
    },
    global,
  );
  const validation = await runValidate(
    { checkHistoryDrift: true, checkStorageIntegrity: true },
    global,
  );
  const mergeChecksGreen = validation.checks.every(
    (check) => check.status === "ok",
  );
  return {
    ok: repair.totals.failed === 0 && (dryRun || mergeChecksGreen),
    dry_run: dryRun,
    repair,
    validation,
    guidance: dryRun
      ? [
          "Review repair.streams, then rerun pm merge reconcile without --dry-run to apply audited repairs.",
          "No Git hook is installed automatically; invoke this command from an explicit post-merge hook only when your repository policy opts in.",
        ]
      : [
          "Reconciliation is complete; commit changed history streams with the merge result.",
          "Rerun pm merge reconcile --dry-run after future tracker-data merges as a non-mutating integrity check.",
        ],
    generated_at: validation.generated_at,
  };
}
