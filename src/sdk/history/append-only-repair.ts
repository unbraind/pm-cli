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
import { describeHistoryBreak } from "../../core/history/bridge.js";
import { resolveHistoryHashAlgorithm } from "../../core/history/digest.js";
import { classifyHistoryEvent } from "../../core/history/event-classification.js";
import { sealHistoryRecord } from "../../core/history/history.js";
import { writeHistoryRawWithRollback } from "../../core/history/history-rewrite.js";
import {
  cloneEmptyReplayDocument,
  replayHashVerificationCandidates,
  resolveHistoryRepairItemHashVersion,
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

/** Build the sealed bridge or reconciliation record appended after the last entry. */
function buildAppendedRepairRecord(params: {
  entries: HistoryEntry[];
  finalReplay: ReplayDocument;
  itemReplay: ReplayDocument;
  author: string;
  message: string;
  bridge: HistoryBridge | null;
}): HistoryEntry {
  const { entries, finalReplay, itemReplay } = params;
  const algorithm = resolveHistoryHashAlgorithm(entries.at(-1)!.hash_algorithm);
  const itemHashVersion = resolveHistoryRepairItemHashVersion(entries);
  const explicitVersion =
    itemHashVersion !== 1 ||
    entries.some((entry) => entry.item_hash_version !== undefined);
  const record: HistoryEntry = {
    hash_algorithm: algorithm,
    ts: nowIso(),
    author: params.author,
    op: "history_repair",
    patch: jsonPatch.compare(finalReplay, itemReplay) as HistoryPatchOp[],
    before_hash: entries.at(-1)!.after_hash,
    after_hash: replayHashVerificationCandidates(
      itemReplay,
      itemHashVersion,
      algorithm,
    )[0],
    message: params.message,
    ...(explicitVersion ? { item_hash_version: itemHashVersion } : {}),
    ...(params.bridge === null ? {} : { bridge: params.bridge }),
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

/**
 * Plan an append-only repair: name every recorded break after the first
 * replay mismatch, append one record that reconciles replay with the on-disk
 * item, and require the extended stream to verify before anything is written.
 */
export function buildAppendOnlyRepairPlan(
  subject: HistorySubject,
  options: HistoryRepairCommandOptions,
  snapshot: HistoryMaintenanceSnapshot,
): HistoryMaintenancePlan<HistoryRepairResult> {
  const { entries } = snapshot;
  const id = subject.id;
  const before = verifyHistoryChainWithVersion(entries);
  const firstBreak = locateFirstBreak(id, before);
  const breaks =
    firstBreak === null
      ? []
      : entries
          .map((entry, index) => ({ entry, index }))
          .filter(
            ({ entry, index }) =>
              index === firstBreak ||
              (index > firstBreak &&
                entry.before_hash !== entries[index - 1]!.after_hash),
          )
          .map(({ index }) => describeHistoryBreak(entries[index - 1]!, entries[index]!));
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
  const reconcile =
    itemReplay !== null &&
    jsonPatch.compare(finalReplay, itemReplay).length > 0;
  const changed = breaks.length > 0 || reconcile;
  const message = describeAppendOnlyRepair(options.message, breaks.length, reconcile);
  const bridge: HistoryBridge | null =
    breaks.length === 0 ? null : { version: 1, breaks };
  const appended = changed
    ? buildAppendedRepairRecord({
        entries,
        finalReplay,
        itemReplay: itemReplay!,
        author: snapshot.author,
        message,
        bridge,
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
    bridge === null
      ? undefined
      : { ...bridge, first_break_entry: firstBreak! + 1 };
  return {
    changed,
    rewrittenEntries,
    /** Append the record to the exact bytes read under the lock. */
    applyRewrite: async (verified) => {
      const bytes = await readFile(subject.historyPath);
      if (!isUtf8(bytes)) {
        refuseAppendOnly(
          id,
          "stream_not_utf8",
          `History for ${id} is not valid UTF-8, so its bytes cannot be kept exactly.`,
        );
      }
      const raw = verified.historyRawUnderLock ?? "";
      const separator = raw === "" || raw.endsWith("\n") ? "" : "\n";
      await writeHistoryRawWithRollback({
        historyPath: subject.historyPath,
        historyRawUnderLock: verified.historyRawUnderLock,
        nextHistoryRaw: `${raw}${separator}${JSON.stringify(appended)}\n`,
      });
    },
    report: ({ verification, warnings }) => ({
      id,
      dry_run: options.dryRun === true,
      changed,
      history: {
        path: subject.historyPath,
        entries_scanned: entries.length,
        chain_drift_before: !before.ok,
        entries_rehashed: 0,
        entries_patch_repaired: 0,
        converted_replace_to_add: 0,
        skipped_ops: 0,
        reconciled_with_item: reconcile,
        audit_entry_added: changed && options.dryRun !== true,
        verify_ok: verification.ok,
        verify_errors: verification.errors,
        item_hash_version_before: before.item_hash_version ?? null,
        item_hash_version_after:
          after.item_hash_version ?? resolveHistoryRepairItemHashVersion(entries),
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
                resolveHistoryRepairItemHashVersion(entries),
                resolveHistoryHashAlgorithm(entries.at(-1)!.hash_algorithm),
              ).includes(entries.at(-1)!.after_hash),
      },
      provenance_normalization: {
        requested: false,
        changed: false,
        events_changed: 0,
        observations_removed: 0,
        invalid_values: [],
      },
      ...(receipt === undefined ? {} : { bridge: receipt }),
      warnings,
      generated_at: nowIso(),
    }),
  };
}
