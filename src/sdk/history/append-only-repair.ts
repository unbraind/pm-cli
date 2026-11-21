/**
 * @module sdk/history/append-only-repair
 *
 * Append-only history repair (GH-1715, pm-gh1715). Instead of re-anchoring
 * every recorded entry after a chain break, the repair appends one sealed
 * `history_repair` bridge that names each break and reconciles replay with the
 * on-disk item. Every earlier line stays byte-identical, so append-only
 * consumers, other clones and later merges keep the bytes they already hold.
 */
import { isUtf8 } from "node:buffer";
import { readFile } from "node:fs/promises";
import jsonPatch from "fast-json-patch";
import {
  describeHistoryBreak,
  digestBridgedSegment,
} from "../../core/history/bridge.js";
import {
  resolveHistoryHashAlgorithm,
  type HistoryHashAlgorithm,
} from "../../core/history/digest.js";
import { classifyHistoryEvent } from "../../core/history/event-classification.js";
import {
  sealHistoryRecord,
  type HistoryItemHashVersion,
} from "../../core/history/history.js";
import { writeHistoryRawWithRollback } from "../../core/history/history-rewrite.js";
import {
  cloneEmptyReplayDocument,
  replayHashVerificationCandidates,
  toReplayDocument,
  tryApplyReplayPatch,
  verifyHistoryChainWithVersion,
  type ReplayDocument,
} from "../../core/history/replay.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import { nowIso } from "../../core/shared/time.js";
import type {
  HistoryBridge,
  HistoryEntry,
  HistoryPatchOp,
} from "../../types/index.js";
import type { HistorySubject } from "../history-redact.js";
import type {
  HistoryRepairCommandOptions,
  HistoryRepairReconciliationReport,
  HistoryRepairResult,
} from "../history-repair.js";
import type {
  HistoryMaintenancePlan,
  HistoryMaintenanceSnapshot,
} from "./maintenance.js";

/** Receipt for the bridge an append-only repair planned or wrote. */
export interface HistoryRepairBridgeReceipt extends HistoryBridge {
  /** One-based entry where the first named break begins. */
  first_break_entry: number;
}

const BEFORE_HASH_MISMATCH = /^verify_failed:before_hash_mismatch:entry_(\d+)$/u;
const PATCH_APPLY_FAILED = /^verify_failed:patch_apply_failed:entry_(\d+)$/u;

/** Refuse an append-only repair with the reason and the rewriting fallback. */
function refuseAppendOnly(
  id: string,
  reason: string,
  message: string,
  verificationErrors: string[] = [],
): never {
  throw new PmCliError(message, EXIT_CODE.CONFLICT, {
    code: "history_append_only_repair_unavailable",
    item_id: id,
    reason,
    ...(verificationErrors.length > 0
      ? { verification_errors: verificationErrors }
      : {}),
    required:
      "An append-only repair can only bridge chain breaks whose recorded links and patches still replay.",
    nextSteps: [
      `Run pm history-repair ${id} --dry-run to preview the rewriting repair, which re-anchors the recorded entries instead.`,
    ],
  });
}

/** Locate the first break the current verdict reports, or refuse a failure that is not one. */
function locateFirstBreak(
  id: string,
  verification: ReturnType<typeof verifyHistoryChainWithVersion>,
): number | null {
  if (verification.ok) return null;
  const only = verification.errors.length === 1 ? verification.errors[0]! : "";
  const unreplayable = PATCH_APPLY_FAILED.exec(only);
  if (unreplayable !== null) {
    refuseAppendOnly(
      id,
      "patch_does_not_replay",
      `History entry ${unreplayable[1]} of ${id} does not apply without the unrecorded change, so only a rewriting repair can keep its effect.`,
      verification.errors,
    );
  }
  const match = BEFORE_HASH_MISMATCH.exec(only);
  const index = match === null ? 0 : Number(match[1]) - 1;
  if (index < 1) {
    refuseAppendOnly(
      id,
      "chain_failure_not_a_break",
      `History for ${id} fails verification for a reason an append-only bridge cannot name (${verification.errors.join(", ")}).`,
      verification.errors,
    );
  }
  return index;
}

/** Replay every entry strictly; a bridged segment must replay without the unrecorded change. */
function replayStrictly(id: string, entries: HistoryEntry[]): ReplayDocument {
  let replay = cloneEmptyReplayDocument();
  for (const [index, entry] of entries.entries()) {
    const applied = tryApplyReplayPatch(replay, entry.patch);
    if (!applied.ok) {
      refuseAppendOnly(
        id,
        "patch_does_not_replay",
        `History entry ${index + 1} of ${id} does not apply without the unrecorded change, so only a rewriting repair can keep its effect.`,
      );
    }
    replay = applied.document;
  }
  return replay;
}

/** The hash epoch and algorithm the appended record must anchor with. */
interface AppendedRecordSurface {
  itemHashVersion: HistoryItemHashVersion;
  explicitVersion: boolean;
  algorithm: HistoryHashAlgorithm;
}

/**
 * Keep the epoch the verified part of the stream proves (the whole stream, or
 * the prefix before the first break), so a bridge never downgrades an
 * implicit epoch-2 stream to epoch 1 the way the rewrite resolver would.
 */
function resolveAppendedRecordSurface(
  entries: HistoryEntry[],
  firstBreak: number | null,
): AppendedRecordSurface {
  const verified = firstBreak === null ? entries : entries.slice(0, firstBreak);
  // A verified nonempty chain always proves its epoch; every other verdict was refused earlier.
  const itemHashVersion = verifyHistoryChainWithVersion(verified).item_hash_version!;
  return {
    itemHashVersion,
    explicitVersion:
      itemHashVersion !== 1 ||
      entries.some((entry) => entry.item_hash_version !== undefined),
    algorithm: resolveHistoryHashAlgorithm(entries.at(-1)!.hash_algorithm),
  };
}

/** Build the sealed bridge or reconciliation record appended after the last entry. */
function buildAppendedRepairRecord(params: {
  entries: HistoryEntry[];
  surface: AppendedRecordSurface;
  finalReplay: ReplayDocument;
  itemReplay: ReplayDocument;
  author: string;
  message: string;
  breaks: HistoryBridge["breaks"];
  segmentStart: number;
}): HistoryEntry {
  const { entries, surface, finalReplay, itemReplay } = params;
  const previousAfterHash = entries.at(-1)!.after_hash;
  // Epoch 2 has two semantic variants; reuse the tail's variant on both sides.
  const variant = Math.max(
    0,
    replayHashVerificationCandidates(
      finalReplay,
      surface.itemHashVersion,
      surface.algorithm,
    ).indexOf(previousAfterHash),
  );
  const record: HistoryEntry = {
    hash_algorithm: surface.algorithm,
    ts: nowIso(),
    author: params.author,
    op: "history_repair",
    patch: jsonPatch.compare(finalReplay, itemReplay) as HistoryPatchOp[],
    before_hash: previousAfterHash,
    after_hash: replayHashVerificationCandidates(
      itemReplay,
      surface.itemHashVersion,
      surface.algorithm,
    )[variant]!,
    message: params.message,
    ...(surface.explicitVersion
      ? { item_hash_version: surface.itemHashVersion }
      : {}),
    ...(params.breaks.length === 0
      ? {}
      : {
          bridge: {
            version: 1,
            breaks: params.breaks,
            segment_digest: digestBridgedSegment(
              entries.slice(params.segmentStart),
              { hash_algorithm: surface.algorithm },
            ),
          },
        }),
  };
  return sealHistoryRecord({
    ...record,
    event_class: classifyHistoryEvent(record),
  });
}

/** Describe the repair in the record and the report. */
function describeAppendOnlyRepair(
  message: string | undefined,
  breaks: number,
  reconciled: boolean,
): string {
  if (message !== undefined) return message;
  const parts = [
    ...(breaks > 0
      ? [`history-repair bridged ${breaks} chain break${breaks === 1 ? "" : "s"} without rewriting recorded entries`]
      : []),
    ...(reconciled ? ["reconciled replay with the on-disk item"] : []),
  ];
  return `${parts.join("; ")}.`;
}

/** Name the first replay mismatch and every later recorded link the stream breaks. */
function collectBreaks(
  entries: HistoryEntry[],
  firstBreak: number | null,
): HistoryBridge["breaks"] {
  if (firstBreak === null) return [];
  const breaks = [describeHistoryBreak(entries[firstBreak - 1]!, entries[firstBreak]!)];
  for (let index = firstBreak + 1; index < entries.length; index += 1) {
    if (entries[index]!.before_hash !== entries[index - 1]!.after_hash) {
      breaks.push(describeHistoryBreak(entries[index - 1]!, entries[index]!));
    }
  }
  return breaks;
}

/** Reconciliation-loss analysis and warnings shared with the rewriting repair. */
export interface AppendOnlyRepairHelpers {
  /** Name the recorded effects the reconciliation patch overwrites. */
  analyzeDiscard: (
    entries: HistoryEntry[],
    finalReplay: ReplayDocument,
    itemReplay: ReplayDocument,
  ) => HistoryRepairReconciliationReport | undefined;
  /** Derive the repair warnings from the change and its losses. */
  collectWarnings: (
    changed: boolean,
    skippedOps: number,
    reconciliation: HistoryRepairReconciliationReport | undefined,
  ) => string[];
}

/** Append the planned record to the exact bytes the shared under-lock check verified. */
async function appendRepairRecord(
  id: string,
  historyPath: string,
  verifiedRaw: string | null,
  record: HistoryEntry,
): Promise<void> {
  const bytes = await readFile(historyPath);
  if (!isUtf8(bytes)) {
    refuseAppendOnly(
      id,
      "stream_not_utf8",
      `History for ${id} is not valid UTF-8, so its bytes cannot be kept exactly.`,
    );
  }
  const raw = bytes.toString("utf8");
  if (raw !== verifiedRaw) {
    refuseAppendOnly(
      id,
      "stream_changed",
      `History for ${id} changed after the repair verified it; retry.`,
    );
  }
  const separator = raw === "" || raw.endsWith("\n") ? "" : "\n";
  await writeHistoryRawWithRollback({
    historyPath,
    historyRawUnderLock: verifiedRaw,
    nextHistoryRaw: `${raw}${separator}${JSON.stringify(record)}\n`,
  });
}

/**
 * Plan an append-only repair: name every recorded break after the first
 * replay mismatch, append one record that reconciles replay with the on-disk
 * item, and require the extended stream to verify before anything is written.
 */
export function buildAppendOnlyRepairPlan(
  subject: HistorySubject,
  options: HistoryRepairCommandOptions,
  snapshot: HistoryMaintenanceSnapshot,
  helpers: AppendOnlyRepairHelpers,
): HistoryMaintenancePlan<HistoryRepairResult> {
  const { entries } = snapshot;
  const id = subject.id;
  const before = verifyHistoryChainWithVersion(entries);
  const firstBreak = locateFirstBreak(id, before);
  const breaks = collectBreaks(entries, firstBreak);
  if (breaks.length > 0 && snapshot.loadedItem === null) {
    refuseAppendOnly(
      id,
      "item_missing",
      `History for ${id} has a chain break, but no on-disk item exists to anchor an append-only bridge.`,
    );
  }
  const finalReplay = replayStrictly(id, entries);
  const itemReplay =
    snapshot.loadedItem === null
      ? null
      : toReplayDocument(snapshot.loadedItem.document);
  const reconciliation =
    itemReplay === null
      ? undefined
      : helpers.analyzeDiscard(entries, finalReplay, itemReplay);
  const reconcile = reconciliation !== undefined;
  const changed = breaks.length > 0 || reconcile;
  const surface = resolveAppendedRecordSurface(entries, firstBreak);
  const appended = changed
    ? buildAppendedRepairRecord({
        entries,
        surface,
        finalReplay,
        itemReplay: itemReplay!,
        author: snapshot.author,
        message: describeAppendOnlyRepair(options.message, breaks.length, reconcile),
        breaks,
        segmentStart: firstBreak ?? entries.length,
      })
    : null;
  const rewrittenEntries = appended === null ? entries : [...entries, appended];
  const after = verifyHistoryChainWithVersion(rewrittenEntries);
  if (!after.ok) {
    refuseAppendOnly(
      id,
      "bridge_does_not_verify",
      `An append-only bridge for ${id} would not verify (${after.errors.join(", ")}).`,
      after.errors,
    );
  }
  const receipt: HistoryRepairBridgeReceipt | undefined =
    appended?.bridge === undefined
      ? undefined
      : { ...appended.bridge, first_break_entry: firstBreak! + 1 };
  const planWarnings = helpers.collectWarnings(changed, 0, reconciliation);
  return {
    changed,
    rewrittenEntries,
    /** Append the record to the exact bytes read under the lock. */
    applyRewrite: async (verified) =>
      appendRepairRecord(id, subject.historyPath, verified.historyRawUnderLock, appended!),
    report: ({ verification, warnings }) =>
      reportAppendOnlyRepair({
        subject,
        options,
        entries,
        before,
        surface,
        changed,
        itemReplay,
        reconciliation,
        receipt,
        verification,
        warnings: [...planWarnings, ...warnings],
      }),
  };
}

/** Render the public repair result for an append-only plan. */
function reportAppendOnlyRepair(params: {
  subject: HistorySubject;
  options: HistoryRepairCommandOptions;
  entries: HistoryEntry[];
  before: ReturnType<typeof verifyHistoryChainWithVersion>;
  surface: AppendedRecordSurface;
  changed: boolean;
  itemReplay: ReplayDocument | null;
  reconciliation: HistoryRepairReconciliationReport | undefined;
  receipt: HistoryRepairBridgeReceipt | undefined;
  verification: { ok: boolean; errors: string[] };
  warnings: string[];
}): HistoryRepairResult {
  const { subject, entries, surface, itemReplay } = params;
  return {
    id: subject.id,
    dry_run: params.options.dryRun === true,
    changed: params.changed,
    history: {
      path: subject.historyPath,
      entries_scanned: entries.length,
      chain_drift_before: !params.before.ok,
      entries_rehashed: 0,
      entries_patch_repaired: 0,
      converted_replace_to_add: 0,
      skipped_ops: 0,
      reconciled_with_item: params.reconciliation !== undefined,
      audit_entry_added: params.changed && params.options.dryRun !== true,
      verify_ok: params.verification.ok,
      verify_errors: params.verification.errors,
      item_hash_version_before: params.before.item_hash_version ?? null,
      item_hash_version_after: surface.itemHashVersion,
      version_disposition: "preserved",
    },
    item: {
      exists: subject.located !== null,
      path: subject.located?.itemPath ?? null,
      matched_chain_before:
        itemReplay === null
          ? null
          : replayHashVerificationCandidates(
              itemReplay,
              surface.itemHashVersion,
              surface.algorithm,
            ).includes(entries.at(-1)!.after_hash),
    },
    provenance_normalization: {
      requested: false,
      changed: false,
      events_changed: 0,
      observations_removed: 0,
      invalid_values: [],
    },
    ...(params.receipt === undefined ? {} : { bridge: params.receipt }),
    ...(params.reconciliation === undefined
      ? {}
      : { reconciliation: params.reconciliation }),
    warnings: [...new Set(params.warnings)].sort((left, right) =>
      left.localeCompare(right),
    ),
    generated_at: nowIso(),
  };
}

/** Internal helpers exported only for focused tests. */
export const _testOnly = { appendRepairRecord };
