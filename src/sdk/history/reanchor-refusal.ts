/**
 * @module sdk/history/reanchor-refusal
 *
 * Re-anchoring a history stream cannot tell whether a record's content or
 * its seal is the authoritative part, so it refuses such a record. This turns
 * that refusal into a typed error with the recovery that works (pm-3os5p6).
 */
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";

/** Integrity failures re-anchoring refuses: a record whose seal or rewrite evidence no longer matches its content. */
const RECORD_INTEGRITY_FAILURE =
  /^(incomplete_record_hash_envelope|record_hash_mismatch|unsupported_record_hash_version|rewrite_evidence_[a-z_]+):entry_(\d+)$/u;

/**
 * Re-anchoring cannot tell whether a record's content or its seal is the
 * authoritative part, so it refuses such a record. Report that refusal typed,
 * with the recovery that works, instead of an unhandled error.
 */
export function reanchorOrRefuse<T>(id: string, reanchor: () => T): T {
  try {
    return reanchor();
  } catch (error: unknown) {
    const failure = error instanceof TypeError ? RECORD_INTEGRITY_FAILURE.exec(error.message) : null;
    if (failure === null) throw error;
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

