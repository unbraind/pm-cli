/**
 * @module sdk/merge/reconcile
 *
 * Provides the post-merge SDK workflow that previews or repairs every drifted
 * item-history stream, then verifies history and storage integrity in one call.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { GlobalOptions } from "../../core/shared/command-types.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import { compareTimestampStrings } from "../../core/shared/time.js";
import { resolvePmRoot } from "../../core/store/paths.js";
import { mapWithFixedConcurrency } from "../extension/concurrency.js";
import { runHealth, type HealthResult } from "../governance/health.js";
import {
  DURABLE_MERGE_RECEIPT_INTRODUCED_AT,
  extractHistoryMergeReceiptReferences,
  isPreDurableDispositionEligibleReference,
} from "../governance/merge-receipt-history.js";
import { runValidate, type ValidateResult } from "../governance/validate.js";
import {
  runHistoryRepair,
  runHistoryRepairAll,
  type HistoryRepairAllResult,
  type HistoryRepairCommandOptions,
  type HistoryRepairResult,
} from "../history-repair.js";
import { findGitWorkspaceRoot } from "./install.js";
import {
  inspectMergeReceiptEvidence,
  markMergeReceiptReconciled,
  summarizeMergeReceipt,
  type MergeDecisionReceiptSummary,
} from "./receipts.js";

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
    /** Missing durable references discovered before this reconciliation. */
    missing_history_references_before: number;
    /** Pre-durable references eligible for explicit audited disposition. */
    legacy_disposition_eligible: number;
    /** Eligible references dispositioned by this apply pass. */
    legacy_disposition_recorded: number;
    /** Missing durable references still blocking health after this pass. */
    missing_history_references_after: number;
  };
  /** Post-operation history-drift and storage-integrity validation. */
  validation: ValidateResult;
  /** Stable next-step guidance for Git hooks and interactive agents. */
  guidance: string[];
  /** ISO timestamp copied from the validation pass. */
  generated_at: string;
}

interface MissingReceiptHistoryCoordinate {
  item_id: string;
  history_line: number;
  receipt_id: string;
}

interface LegacyReceiptDispositionCandidate extends MissingReceiptHistoryCoordinate {
  original_event_ts: string;
}

/** Extract bounded item, line, and receipt coordinates from health evidence. */
function missingReceiptCoordinates(health: HealthResult): {
  count: number;
  truncated: boolean;
  coordinates: MissingReceiptHistoryCoordinate[];
} {
  const integrity = health.checks.find((check) => check.name === "integrity");
  const counts = integrity?.details.counts;
  const count =
    typeof counts === "object" &&
    counts !== null &&
    !Array.isArray(counts) &&
    typeof (counts as Record<string, unknown>)
      .missing_merge_receipt_history_references === "number"
      ? ((counts as Record<string, unknown>)
          .missing_merge_receipt_history_references as number)
      : 0;
  const details =
    integrity?.details.missing_merge_receipt_history_reference_details;
  const truncated =
    integrity?.details
      .missing_merge_receipt_history_reference_details_truncated === true;
  const coordinates = Array.isArray(details)
    ? details.flatMap((detail) => {
        if (
          typeof detail !== "object" ||
          detail === null ||
          Array.isArray(detail)
        ) {
          return [];
        }
        const record = detail as Record<string, unknown>;
        return typeof record.item_id === "string" &&
          typeof record.history_line === "number" &&
          Number.isSafeInteger(record.history_line) &&
          typeof record.receipt_id === "string"
          ? [
              {
                item_id: record.item_id,
                history_line: record.history_line,
                receipt_id: record.receipt_id,
              },
            ]
          : [];
      })
    : [];
  return { count, truncated, coordinates };
}

/** Re-read history and retain only exact pre-durable clone-local references. */
async function identifyLegacyDispositionCandidates(
  pmRoot: string,
  coordinates: readonly MissingReceiptHistoryCoordinate[],
): Promise<LegacyReceiptDispositionCandidate[]> {
  const candidates: LegacyReceiptDispositionCandidate[] = [];
  for (const coordinate of coordinates) {
    let raw: string;
    try {
      raw = await readFile(
        path.join(pmRoot, "history", `${coordinate.item_id}.jsonl`),
        "utf8",
      );
    } catch {
      continue;
    }
    const line = raw.split(/\r?\n/)[coordinate.history_line - 1];
    if (line === undefined || line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    const reference = extractHistoryMergeReceiptReferences(
      parsed,
      coordinate.item_id,
    ).find((entry) => entry.receiptId === coordinate.receipt_id);
    if (
      reference === undefined ||
      !isPreDurableDispositionEligibleReference(reference) ||
      reference.eventTimestamp === undefined ||
      compareTimestampStrings(
        reference.eventTimestamp,
        DURABLE_MERGE_RECEIPT_INTRODUCED_AT,
      ) >= 0
    ) {
      continue;
    }
    candidates.push({
      ...coordinate,
      original_event_ts: reference.eventTimestamp,
    });
  }
  return candidates;
}

/** Append auditable dispositions for eligible receipts that cannot be restored. */
async function recordLegacyReceiptDispositions(params: {
  candidates: readonly LegacyReceiptDispositionCandidate[];
  options: MergeReconcileOptions;
  global: GlobalOptions;
}): Promise<number> {
  if (
    params.options.dryRun === true ||
    params.options.force !== true ||
    params.candidates.length === 0
  ) {
    return 0;
  }
  const byItem = new Map<string, LegacyReceiptDispositionCandidate[]>();
  for (const candidate of params.candidates) {
    const itemCandidates = byItem.get(candidate.item_id) ?? [];
    itemCandidates.push(candidate);
    byItem.set(candidate.item_id, itemCandidates);
  }
  for (const [itemId, itemCandidates] of byItem) {
    await runHistoryRepair(
      itemId,
      {
        author: params.options.author ?? params.global.author,
        message:
          params.options.message ??
          "accept unrecoverable pre-durable merge receipt references",
        force: true,
        auditOperation: "merge_reconcile",
        forceAuditEntry: true,
        auditContext: {
          merge: {
            missing_receipt_dispositions: itemCandidates.map((candidate) => ({
              receipt_id: candidate.receipt_id,
              original_history_line: candidate.history_line,
              original_event_ts: candidate.original_event_ts,
              reason: "legacy_clone_local_only",
            })),
          },
        },
      },
      params.global,
    );
  }
  return params.candidates.length;
}

/** Execute one receipt-backed repair while preserving its settled result. */
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

/** Fold settled receipt repairs into the aggregate reconciliation result. */
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

/** Settle only receipts named by successful trusted repair evidence. */
async function settleProvenReceipts(params: {
  dryRun: boolean;
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
  const receiptsToSettle = params.pendingReceipts.filter((receipt) =>
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
  const preflightHealth = await runHealth(global, {
    checkOnly: true,
    full: true,
    skipVectors: true,
    skipDrift: true,
  });
  const missingBefore = missingReceiptCoordinates(preflightHealth);
  const legacyDispositionCandidates = await identifyLegacyDispositionCandidates(
    pmRoot,
    missingBefore.coordinates,
  );
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
  const recordedLegacyDispositionCount = await recordLegacyReceiptDispositions({
    candidates: legacyDispositionCandidates,
    options,
    global,
  });
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
    pendingReceipts,
    repair,
    gitWorkspaceRoot,
  });
  const validation = await runValidate(
    { checkHistoryDrift: true, checkStorageIntegrity: true },
    global,
  );
  const postflightHealth =
    recordedLegacyDispositionCount === 0
      ? preflightHealth
      : await runHealth(global, {
          checkOnly: true,
          full: true,
          skipVectors: true,
          skipDrift: true,
        });
  const missingAfter = missingReceiptCoordinates(postflightHealth);
  const mergeChecksGreen = validation.checks.every(
    (check) => check.status === "ok",
  );
  const receiptSettlementComplete = dryRun
    ? pendingReceipts.length === 0
    : reconciledReceiptCount === pendingReceipts.length;
  const ok = [
    repair.totals.failed === 0,
    mergeChecksGreen,
    receiptSettlementComplete,
    missingAfter.count === 0,
    !missingAfter.truncated,
  ].every(Boolean);
  const boundedBatchGuidance =
    missingBefore.truncated || missingAfter.truncated
      ? "Missing receipt coordinates exceed the bounded detail response; each reviewed --force pass can disposition only the reported eligible batch. Repeat dry-run and --force passes until receipts.missing_history_references_after=0 and pm merge reconcile returns ok=true."
      : undefined;
  const guidance = (
    dryRun
      ? [
          "Review repair.streams, then rerun pm merge reconcile without --dry-run to apply audited repairs.",
          boundedBatchGuidance,
          "No Git hook is installed automatically; invoke this command from an explicit post-merge hook only when your repository policy opts in.",
        ]
      : ok
        ? [
            "Reconciliation is complete; commit changed history streams with the merge result.",
            "Rerun pm merge reconcile --dry-run after future tracker-data merges as a non-mutating integrity check.",
          ]
        : [
            "Reconciliation remains incomplete; inspect repair failures and non-green validation checks before retrying.",
            boundedBatchGuidance,
            ...(legacyDispositionCandidates.length > 0 &&
            recordedLegacyDispositionCount === 0
              ? [
                  "Pre-durable clone-local-only receipt references are eligible for an audited disposition; rerun with --force after reviewing receipts.legacy_disposition_eligible.",
                ]
              : []),
            "Do not commit repaired history streams as reconciled until pm merge reconcile returns ok=true.",
          ]
  ).filter((message): message is string => message !== undefined);
  return {
    ok,
    dry_run: dryRun,
    repair,
    receipts: {
      pending_before: pendingReceipts.length,
      reconciled: reconciledReceiptCount,
      summaries: pendingReceipts.map(summarizeMergeReceipt),
      missing_history_references_before: missingBefore.count,
      legacy_disposition_eligible: legacyDispositionCandidates.length,
      legacy_disposition_recorded: recordedLegacyDispositionCount,
      missing_history_references_after: missingAfter.count,
    },
    validation,
    guidance,
    generated_at: validation.generated_at,
  };
}
