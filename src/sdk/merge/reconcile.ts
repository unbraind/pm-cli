/**
 * @module sdk/merge/reconcile
 *
 * Provides the post-merge SDK workflow that previews or repairs every drifted
 * item-history stream, then verifies history and storage integrity in one call.
 */
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import { resolvePmRoot } from "../../core/store/paths.js";
import {
  runHistoryRepair,
  runHistoryRepairAll,
  type HistoryRepairAllResult,
  type HistoryRepairCommandOptions,
  type HistoryRepairResult,
} from "../history-repair.js";
import { runValidate, type ValidateResult } from "../governance/validate.js";
import {
  inspectMergeReceiptEvidence,
  markMergeReceiptReconciled,
  summarizeMergeReceipt,
  type MergeDecisionReceiptSummary,
} from "./receipts.js";
import { findGitWorkspaceRoot } from "./install.js";
import { mapWithFixedConcurrency } from "../extension/concurrency.js";

const RECEIPT_ONLY_REPAIR_CONCURRENCY = 4;

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
   * Whether reconciliation completed without repair failures or non-green
   * merge-critical validation. Dry-run previews therefore fail closed while
   * drift or pending merge decisions still require an apply pass.
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

async function runReceiptOnlyRepair(params: {
  id: string;
  dryRun: boolean;
  options: MergeReconcileOptions;
  global: GlobalOptions;
  auditContext: Record<string, unknown> | undefined;
  mergeReceiptProof: HistoryRepairCommandOptions["mergeReceiptProof"];
}): Promise<PromiseSettledResult<HistoryRepairResult>> {
  try {
    return {
      status: "fulfilled",
      value: await runHistoryRepair(
        params.id,
        {
          dryRun: params.dryRun,
          author: params.options.author ?? params.global.author,
          message:
            params.options.message ??
            "record field-aware branch merge provenance",
          force: params.options.force,
          auditOperation: "merge_reconcile",
          auditContext: params.auditContext,
          forceAuditEntry: true,
          mergeReceiptProof: params.mergeReceiptProof,
        },
        params.global,
      ),
    };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

function appendReceiptOnlyResults(params: {
  receiptOnlyIds: string[];
  results: Array<PromiseSettledResult<HistoryRepairResult>>;
  repair: HistoryRepairAllResult;
}): void {
  params.results.forEach((settled, index) => {
    const id = params.receiptOnlyIds[index];
    if (settled.status === "fulfilled") {
      const outcome = settled.value.changed ? "repaired" : "skipped_clean";
      params.repair.streams.push({
        id,
        outcome,
        entries_rehashed: settled.value.history.entries_rehashed,
        entries_patch_repaired: settled.value.history.entries_patch_repaired,
        reconciled_with_item: settled.value.history.reconciled_with_item,
        ...(settled.value.merge_receipt_proof
          ? { merge_receipt_proof: settled.value.merge_receipt_proof }
          : {}),
        warnings: settled.value.warnings,
      });
      params.repair.totals[outcome] += 1;
      return;
    }
    params.repair.streams.push({
      id,
      outcome: "failed",
      error:
        settled.reason instanceof Error
          ? settled.reason.message
          : String(settled.reason),
    });
    params.repair.totals.failed += 1;
  });
}

async function settleProvenReceipts(params: {
  dryRun: boolean;
  force: boolean;
  pendingReceipts: Awaited<
    ReturnType<typeof inspectMergeReceiptEvidence>
  >["receipts"];
  repair: HistoryRepairAllResult;
  gitWorkspaceRoot: string | null;
}): Promise<number> {
  if (params.dryRun || params.repair.totals.failed > 0) return 0;
  const trustedReceiptIds = new Set(
    params.repair.streams.flatMap((stream) =>
      stream.merge_receipt_proof?.trusted
        ? stream.merge_receipt_proof.receipt_ids
        : [],
    ),
  );
  const receiptsToSettle = params.force
    ? params.pendingReceipts
    : params.pendingReceipts.filter((receipt) =>
        trustedReceiptIds.has(receipt.id),
      );
  await Promise.all(
    receiptsToSettle.map((receipt) =>
      markMergeReceiptReconciled(
        params.gitWorkspaceRoot ?? process.cwd(),
        receipt,
        { requireExisting: true },
      ),
    ),
  );
  return receiptsToSettle.length;
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
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  const gitWorkspaceRoot = await findGitWorkspaceRoot(pmRoot);
  const receiptEvidence = await inspectMergeReceiptEvidence(
    gitWorkspaceRoot ?? process.cwd(),
    {
      includeLossless: true,
      pmRoot,
    },
  );
  if (receiptEvidence.invalid_evidence_count > 0) {
    throw new PmCliError(
      `Merge reconciliation refused ${receiptEvidence.invalid_evidence_count} invalid receipt evidence file(s).`,
      EXIT_CODE.CONFLICT,
      {
        code: "merge_receipt_evidence_invalid",
        required:
          "Every clone-local and durable receipt candidate must pass bounded-file, schema, and identity validation.",
        recovery: {
          suggested_retry: "pm health --check-only --full",
        },
      },
    );
  }
  const pendingReceipts = receiptEvidence.receipts;
  const receiptsByItem = new Map<string, typeof pendingReceipts>();
  for (const receipt of pendingReceipts) {
    const receipts = receiptsByItem.get(receipt.item_id) ?? [];
    receipts.push(receipt);
    receiptsByItem.set(receipt.item_id, receipts);
  }
  const auditContextById = Object.fromEntries(
    [...receiptsByItem].map(([id, receipts]) => [
      id,
      {
        merge: {
          receipts: receipts.map(summarizeMergeReceipt),
        },
      },
    ]),
  );
  const mergeReceiptProofById = Object.fromEntries(
    [...receiptsByItem].map(([id, receipts]) => [
      id,
      { gitWorkspaceRoot, receipts },
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
      ...(pendingReceipts.length > 0 ? { mergeReceiptProofById } : {}),
    },
    global,
  );
  const representedIds = new Set(repair.streams.map((stream) => stream.id));
  const receiptOnlyIds = [...receiptsByItem.keys()].filter(
    (id) => !representedIds.has(id),
  );
  const receiptOnlyResults = await mapWithFixedConcurrency(
    receiptOnlyIds,
    RECEIPT_ONLY_REPAIR_CONCURRENCY,
    (id) =>
      runReceiptOnlyRepair({
        id,
        dryRun,
        options,
        global,
        auditContext: auditContextById[id],
        mergeReceiptProof: mergeReceiptProofById[id],
      }),
  );
  appendReceiptOnlyResults({
    receiptOnlyIds,
    results: receiptOnlyResults,
    repair,
  });
  const reconciledReceiptCount = await settleProvenReceipts({
    dryRun,
    force: options.force === true,
    pendingReceipts,
    repair,
    gitWorkspaceRoot,
  });
  const validation = await runValidate(
    { checkHistoryDrift: true, checkStorageIntegrity: true },
    global,
  );
  const mergeChecksGreen = validation.checks.every(
    (check) => check.status === "ok",
  );
  const receiptSettlementComplete = dryRun
    ? pendingReceipts.length === 0
    : reconciledReceiptCount === pendingReceipts.length;
  const ok =
    repair.totals.failed === 0 && mergeChecksGreen && receiptSettlementComplete;
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
