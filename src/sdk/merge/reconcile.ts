/**
 * @module sdk/merge/reconcile
 *
 * Provides the post-merge SDK workflow that previews or repairs every drifted
 * item-history stream, then verifies history and storage integrity in one call.
 */
import type { GlobalOptions } from "../../core/shared/command-types.js";
import {
  runHistoryRepair,
  runHistoryRepairAll,
  type HistoryRepairAllResult,
} from "../history-repair.js";
import {
  runValidate,
  type ValidateResult,
} from "../governance/validate.js";
import {
  listMergeReceipts,
  markMergeReceiptReconciled,
  summarizeMergeReceipt,
  type MergeDecisionReceiptSummary,
} from "./receipts.js";

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
  /**
   * Whether reconciliation completed without errors. In dry-run mode this
   * reports preview success, not workspace cleanliness; inspect `repair` and
   * `validation.checks` before deciding whether an apply pass is required.
   */
  ok: boolean;
  /** Whether this invocation only previewed repairs. */
  dry_run: boolean;
  /** Bulk history repair preview or apply result. */
  repair: HistoryRepairAllResult;
  /** Clone-local merge receipts represented by merge history events. */
  receipts: {
    pending_before: number;
    reconciled: number;
    summaries: MergeDecisionReceiptSummary[];
  };
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
  const pendingReceipts = await listMergeReceipts(process.cwd());
  const receiptsByItem = pendingReceipts.reduce<
    Record<string, typeof pendingReceipts>
  >((groups, receipt) => {
    (groups[receipt.item_id] ??= []).push(receipt);
    return groups;
  }, {});
  const auditContextById = Object.fromEntries(
    Object.entries(receiptsByItem).map(([id, receipts]) => [
      id,
      {
        merge: {
          receipts: receipts.map(summarizeMergeReceipt),
        },
      },
    ]),
  );
  const repair = await runHistoryRepairAll(
    {
      dryRun,
      author: options.author ?? global.author,
      message:
        options.message ??
        "post-merge reconciliation of field-aware tracker history",
      force: options.force,
      auditOperation: "merge_reconcile",
      auditContextById,
    },
    global,
  );
  const representedIds = new Set(repair.streams.map((stream) => stream.id));
  const receiptOnlyIds = Object.keys(receiptsByItem).filter(
    (id) => !representedIds.has(id),
  );
  const receiptOnlyResults = await Promise.allSettled(
    receiptOnlyIds.map((id) =>
      runHistoryRepair(
        id,
        {
          dryRun,
          author: options.author ?? global.author,
          message:
            options.message ?? "record field-aware branch merge provenance",
          force: options.force,
          auditOperation: "merge_reconcile",
          auditContext: auditContextById[id],
          forceAuditEntry: true,
        },
        global,
      ),
    ),
  );
  receiptOnlyResults.forEach((settled, index) => {
    const id = receiptOnlyIds[index];
    if (settled.status === "fulfilled") {
      repair.streams.push({
        id,
        outcome: dryRun ? "skipped_clean" : "repaired",
        entries_rehashed: settled.value.history.entries_rehashed,
        entries_patch_repaired: settled.value.history.entries_patch_repaired,
        reconciled_with_item:
          settled.value.history.reconciled_with_item,
        warnings: settled.value.warnings,
      });
      repair.totals[dryRun ? "skipped_clean" : "repaired"] += 1;
    } else {
      repair.streams.push({
        id,
        outcome: "failed",
        error:
          settled.reason instanceof Error
            ? settled.reason.message
            : String(settled.reason),
      });
      repair.totals.failed += 1;
    }
  });
  let reconciledReceiptCount = 0;
  if (!dryRun && repair.totals.failed === 0) {
    await Promise.all(
      pendingReceipts.map((receipt) =>
        markMergeReceiptReconciled(process.cwd(), receipt),
      ),
    );
    reconciledReceiptCount = pendingReceipts.length;
  }
  const validation = await runValidate(
    { checkHistoryDrift: true, checkStorageIntegrity: true },
    global,
  );
  const mergeChecksGreen = validation.checks.every(
    (check) => check.status === "ok",
  );
  const ok = repair.totals.failed === 0 && (dryRun || mergeChecksGreen);
  const guidance = dryRun
    ? [
        "Review repair.streams, then rerun pm merge reconcile without --dry-run to apply audited repairs.",
        "No Git hook is installed automatically; invoke this command from an explicit post-merge hook only when your repository policy opts in.",
      ]
    : ok
      ? [
          "Reconciliation is complete; commit changed history streams with the merge result.",
          "Rerun pm merge reconcile --dry-run after future tracker-data merges as a non-mutating integrity check.",
        ]
      : [
          "Reconciliation remains incomplete; inspect repair failures and non-green validation checks before retrying.",
          "Do not commit repaired history streams as reconciled until pm merge reconcile returns ok=true.",
        ];
  return {
    ok,
    dry_run: dryRun,
    repair,
    receipts: {
      pending_before: pendingReceipts.length,
      reconciled: reconciledReceiptCount,
      summaries: pendingReceipts.map(summarizeMergeReceipt),
    },
    validation,
    guidance,
    generated_at: validation.generated_at,
  };
}
