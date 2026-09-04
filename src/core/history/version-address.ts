/**
 * @module core/history/version-address
 * Stable ordinal addressing for streams whose retained prefix is a checkpoint.
 */
import type { HistoryEntry } from "../../types/index.js";
import { EXIT_CODE } from "../shared/constants.js";
import { PmCliError } from "../shared/errors.js";

/**
 * Return the number added to physical one-based positions to obtain durable
 * version addresses. Legacy checkpoints cannot prove their original ordinal;
 * refusing them prevents silently selecting a different historical state.
 */
export function historyVersionOffset(
  history: readonly HistoryEntry[],
  allowUnknown: true,
): number | null;
/** Resolve a required durable offset, refusing ambiguous legacy checkpoints. */
export function historyVersionOffset(
  history: readonly HistoryEntry[],
  allowUnknown?: false,
): number;
/** Resolve the checkpoint offset with an explicit opt-in for unknown legacy addresses. */
export function historyVersionOffset(
  history: readonly HistoryEntry[],
  allowUnknown = false,
): number | null {
  const first = history[0];
  if (first?.op !== "history_compact_baseline") return 0;
  const receipt = first.context?.history_compaction;
  const offset =
    typeof receipt === "object" &&
    receipt !== null &&
    "version_offset" in receipt
      ? receipt.version_offset
      : undefined;
  if (
    typeof offset === "number" &&
    Number.isSafeInteger(offset) &&
    offset >= 0 &&
    Number.isSafeInteger(offset + history.length)
  ) {
    return offset;
  }
  if (allowUnknown) return null;
  throw new PmCliError(
    "This compacted stream has no trustworthy version offset; numeric history addresses are unavailable.",
    EXIT_CODE.USAGE,
    {
      code: "history_version_mapping_unavailable",
      required:
        "Use a retained timestamp or recover the pre-compaction stream from version control.",
      nextSteps: [
        "Run pm history <id> --full to inspect the retained timestamps and checkpoint evidence.",
      ],
    },
  );
}
