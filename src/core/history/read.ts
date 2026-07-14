/**
 * @module core/history/read
 *
 * Reads append-only item history streams with conflict-marker detection,
 * extension read hooks, and line-specific JSONL diagnostics. Keeping this
 * storage primitive below both the CLI and SDK prevents public history
 * maintenance APIs from depending on presentation-layer modules.
 */
import { readFileIfExists } from "../fs/fs-utils.js";
import { runActiveOnReadHooks } from "../extensions/index.js";
import { EXIT_CODE } from "../shared/constants.js";
import { findFirstMergeConflictMarker } from "../shared/conflict-markers.js";
import { PmCliError } from "../shared/errors.js";
import type { HistoryEntry } from "../../types/index.js";

/** Read and validate one item's JSONL history stream without mutating it. */
export async function readHistoryEntries(
  historyPath: string,
  itemId: string,
): Promise<HistoryEntry[]> {
  const raw = await readFileIfExists(historyPath);
  if (raw === null) {
    return [];
  }
  await runActiveOnReadHooks({ path: historyPath, scope: "project" });
  if (raw.trim() === "") {
    return [];
  }
  const conflictMarker = findFirstMergeConflictMarker(raw);
  if (conflictMarker) {
    throw new PmCliError(
      `History for ${itemId} contains merge conflict markers at line ${conflictMarker.line} (${conflictMarker.marker}). Resolve <<<<<<< ======= >>>>>>> markers and retry.`,
      EXIT_CODE.GENERIC_FAILURE,
      {
        code: "history_merge_conflict_markers_detected",
        required: "Repair the history stream by resolving merge-conflict markers.",
        why: "Conflict markers break JSONL parsing and invalidate deterministic audit history.",
        examples: [
          `pm history ${itemId}`,
          `pm restore ${itemId} <timestamp-or-version>`,
        ],
        nextSteps: ["Resolve or restore the history file, then rerun the command."],
      },
    );
  }

  const entries: HistoryEntry[] = [];
  for (const [index, rawLine] of raw.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    try {
      entries.push(JSON.parse(line) as HistoryEntry);
    } catch {
      throw new PmCliError(
        `History for ${itemId} contains invalid JSON at line ${index + 1}. Repair or restore the history stream and retry.`,
        EXIT_CODE.GENERIC_FAILURE,
      );
    }
  }
  return entries;
}
