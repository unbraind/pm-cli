/**
 * @module sdk/history/reanchor-refusal
 *
 * Re-anchoring a history stream cannot tell whether a record's content or
 * its seal is the authoritative part, so it refuses such a record. This turns
 * that refusal into a typed error with the recovery that works (pm-3os5p6).
 */
import { hasNewerRecordSealFormat } from "../../core/history/history.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import type { HistoryEntry } from "../../types/index.js";

/** Integrity failures re-anchoring refuses: a record whose seal or rewrite evidence no longer matches its content. */
const RECORD_INTEGRITY_FAILURE =
  /^(incomplete_record_hash_envelope|record_hash_mismatch|unsupported_record_hash_version|rewrite_evidence_[a-z_]+):entry_(\d+)$/u;

/** A newer pm wrote a seal this runtime cannot read; the fix is the upgrade, not a restore. */
function recordVersionRefusal(id: string, entry: string): PmCliError {
  return new PmCliError(
    `History entry ${entry} of ${id} is sealed in a record format this pm version cannot read, so it cannot repair the stream.`,
    EXIT_CODE.CONFLICT,
    {
      code: "history_record_version_unsupported",
      item_id: id,
      reason: "unsupported_record_hash_version",
      details: { entry: Number(entry) },
      required: "Upgrade pm to a version that reads the stream's record format; no bytes were changed.",
      nextSteps: ["Run npm install -g @unbrained/pm-cli@latest, then run pm health again."],
    },
  );
}

/**
 * Re-anchoring cannot tell whether a record's content or its seal is the
 * authoritative part, so it refuses such a record. Report that refusal typed,
 * with the recovery that works, instead of an unhandled error.
 */
export function reanchorOrRefuse<T>(
  id: string,
  entries: readonly HistoryEntry[],
  reanchor: () => T,
): T {
  try {
    return reanchor();
  } catch (error: unknown) {
    const failure = error instanceof TypeError ? RECORD_INTEGRITY_FAILURE.exec(error.message) : null;
    if (failure === null) throw error;
    // Only a complete seal in a newer numeric format needs an upgrade; any other unreadable seal is damage.
    const record = entries[Number(failure[2]) - 1];
    if (record !== undefined && hasNewerRecordSealFormat(record)) {
      throw recordVersionRefusal(id, failure[2]!);
    }
    throw new PmCliError(
      `History entry ${failure[2]} of ${id} no longer matches its seal (${failure[1]}), so a repair cannot tell which part of the record to keep.`,
      EXIT_CODE.CONFLICT,
      {
        code: "history_record_integrity_invalid",
        item_id: id,
        reason: failure[1],
        details: { entry: Number(failure[2]) },
        required:
          "Restore the item's history stream from version control or a backup; no bytes were changed.",
        nextSteps: [
          `Run pm history ${id} --verify --full to locate the record, restore the stream, then run pm history ${id} --verify --strict-exit.`,
        ],
      },
    );
  }
}

