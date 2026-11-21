/**
 * @module sdk/history/reseed
 *
 * Rebuild the history stream of a live item whose stream is absent or holds no
 * record (pm-3os5p6). `pm health` reports such a stream as
 * `history_drift_missing_stream` and names `pm history-repair` as its remedy,
 * so the repair records one sealed `history_repair` baseline from the empty
 * document to the on-disk item. Earlier versions were never recorded or were
 * lost: the receipt says so, and version 1 is the item as of the repair.
 */
import { createHistoryEntry, CURRENT_HISTORY_ITEM_HASH_VERSION } from "../../core/history/history.js";
import { writeHistoryRawWithRollback } from "../../core/history/history-rewrite.js";
import { EMPTY_CANONICAL_DOCUMENT } from "../../core/shared/constants.js";
import { nowIso } from "../../core/shared/time.js";
import type { HistoryEntry, ItemDocument } from "../../types/index.js";
import type { HistorySubject } from "./subject.js";
import type {
  HistoryMaintenancePlan,
  HistoryMaintenanceSnapshot,
} from "./maintenance.js";
import type {
  HistoryRepairCommandOptions,
  HistoryRepairResult,
} from "../history-repair.js";

/** Receipt for a stream that history-repair rebuilt from the on-disk item. */
export interface HistoryRepairReseedReceipt {
  /** `missing_stream` when the stream file was absent, `empty_stream` when it held no record. */
  reason: "missing_stream" | "empty_stream";
  /** Earlier versions were never recorded or were lost; version 1 is the item as of the repair. */
  prior_versions: "unrecorded";
}

/** Keep every existing byte and add the record as the stream's first line. */
function appendFirstRecord(raw: string | null, record: HistoryEntry): string {
  const kept = raw ?? "";
  const separator = kept === "" || kept.endsWith("\n") ? "" : "\n";
  return `${kept}${separator}${JSON.stringify(record)}\n`;
}

/**
 * Plan the baseline record for a live item's absent or record-less stream.
 * Both repair modes use it: the stream holds no recorded line to rewrite, so
 * appending the baseline keeps every existing byte.
 */
export function buildHistoryReseedPlan(
  subject: HistorySubject,
  options: HistoryRepairCommandOptions,
  snapshot: HistoryMaintenanceSnapshot,
  stream: { absent: boolean },
): HistoryMaintenancePlan<HistoryRepairResult> {
  const reseed: HistoryRepairReseedReceipt = {
    reason: stream.absent ? "missing_stream" : "empty_stream",
    prior_versions: "unrecorded",
  };
  // The maintenance pipeline only calls a reseed for a live item.
  const item = snapshot.loadedItem!;
  const itemPath = subject.located!.itemPath;
  const record = createHistoryEntry({
    nowIso: nowIso(),
    author: snapshot.author,
    op: "history_repair",
    before: EMPTY_CANONICAL_DOCUMENT as unknown as ItemDocument,
    after: item.document,
    message:
      options.message ??
      `history-repair rebuilt ${stream.absent ? "the missing" : "the empty"} history stream from the on-disk item; earlier versions are not recorded.`,
    context: { history_reseed: { contract_version: 1, ...reseed } },
  });
  const dryRun = options.dryRun === true;
  return {
    changed: true,
    rewrittenEntries: [record],
    /** Write the baseline after the bytes the shared under-lock check verified. */
    applyRewrite: async (verified) =>
      writeHistoryRawWithRollback({
        historyPath: subject.historyPath,
        historyRawUnderLock: verified.historyRawUnderLock,
        nextHistoryRaw: appendFirstRecord(verified.historyRawUnderLock, record),
      }),
    report: ({ verification, warnings }) => ({
      id: subject.id,
      dry_run: dryRun,
      changed: true,
      history: {
        path: subject.historyPath,
        entries_scanned: 0,
        chain_drift_before: true,
        entries_rehashed: 0,
        entries_patch_repaired: 0,
        converted_replace_to_add: 0,
        skipped_ops: 0,
        reconciled_with_item: true,
        audit_entry_added: !dryRun,
        verify_ok: verification.ok,
        verify_errors: verification.errors,
        item_hash_version_before: null,
        item_hash_version_after: CURRENT_HISTORY_ITEM_HASH_VERSION,
        version_disposition: "preserved",
      },
      item: {
        exists: true,
        path: itemPath,
        matched_chain_before: false,
      },
      provenance_normalization: {
        requested: false,
        changed: false,
        events_changed: 0,
        observations_removed: 0,
        invalid_values: [],
      },
      reseed,
      warnings: [...new Set(warnings)],
      generated_at: nowIso(),
    }),
  };
}
