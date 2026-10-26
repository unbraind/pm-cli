/**
 * @module core/history/read
 *
 * Reads append-only item history streams with conflict-marker detection,
 * extension read hooks, and line-specific JSONL diagnostics. Keeping this
 * storage primitive below both the CLI and SDK prevents public history
 * maintenance APIs from depending on presentation-layer modules.
 */
import fs from "node:fs/promises";
import { isFileAbsentError } from "../fs/fs-utils.js";
import { runActiveOnReadHooks } from "../extensions/index.js";
import { EXIT_CODE } from "../shared/constants.js";
import { findFirstMergeConflictMarker } from "../shared/conflict-markers.js";
import { PmCliError } from "../shared/errors.js";
import type { HistoryEntry } from "../../types/index.js";

/** Exact bytes and decoded entries from one read, suitable for optimistic concurrency checks. */
export interface HistoryStreamSnapshot {
  /** Null means the stream did not exist; an empty string means it existed without entries. */
  raw: string | null;
  /** Original file bytes, before UTF-8 decoding; null means the stream did not exist. */
  raw_bytes: Uint8Array | null;
  /** Entries decoded from `raw_bytes`, after read hooks run. */
  entries: HistoryEntry[];
}

/** Read one history stream once so replay input and the concurrency snapshot cannot disagree. */
export async function readHistorySnapshot(
  historyPath: string,
  itemId: string,
): Promise<HistoryStreamSnapshot> {
  const rawBytes = await fs.readFile(historyPath).catch((error: unknown) => {
    if (isFileAbsentError(error)) return null;
    throw error;
  });
  const raw = rawBytes?.toString("utf8") ?? null;
  if (raw === null) {
    return { raw, raw_bytes: rawBytes, entries: [] };
  }
  await runActiveOnReadHooks({ path: historyPath, scope: "project" });
  if (raw.trim() === "") {
    return { raw, raw_bytes: rawBytes, entries: [] };
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
        {
          code: "history_json_invalid",
          nextSteps: [`Run pm history-repair ${itemId} --salvage-tail --dry-run to check whether only an invalid suffix is damaged.`],
        },
      );
    }
  }
  return { raw, raw_bytes: rawBytes, entries };
}

/** Read and validate one item's JSONL history stream without mutating it. */
export async function readHistoryEntries(
  historyPath: string,
  itemId: string,
): Promise<HistoryEntry[]> {
  return (await readHistorySnapshot(historyPath, itemId)).entries;
}
