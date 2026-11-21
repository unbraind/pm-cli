/**
 * @module core/history/read
 *
 * Reads append-only item history streams with conflict-marker detection,
 * extension read hooks, and line-specific JSONL diagnostics. Keeping this
 * storage primitive below both the CLI and SDK prevents public history
 * maintenance APIs from depending on presentation-layer modules.
 */
import fs from "node:fs/promises";
import type { BigIntStats } from "node:fs";
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
  return decodeHistorySnapshot(historyPath, itemId, rawBytes);
}

/** A snapshot plus the identity of the open file that supplied its bytes. */
export interface IdentifiedHistoryStreamSnapshot extends HistoryStreamSnapshot {
  /** Stat of the open handle the bytes were read from; null when the stream was absent. */
  source: BigIntStats | null;
}

/**
 * Read one history stream through a single open handle and report that
 * handle's stat, so derived state can be bound to the exact file revision
 * that supplied the bytes, whatever happens to the path meanwhile.
 */
export async function readIdentifiedHistorySnapshot(
  historyPath: string,
  itemId: string,
): Promise<IdentifiedHistoryStreamSnapshot> {
  const handle = await fs.open(historyPath, "r").catch((error: unknown) => {
    if (isFileAbsentError(error)) return null;
    throw error;
  });
  if (handle === null) {
    return { ...(await decodeHistorySnapshot(historyPath, itemId, null)), source: null };
  }
  try {
    const source = await handle.stat({ bigint: true });
    const rawBytes = await handle.readFile();
    return { ...(await decodeHistorySnapshot(historyPath, itemId, rawBytes)), source };
  } finally {
    await handle.close();
  }
}

async function decodeHistorySnapshot(
  historyPath: string,
  itemId: string,
  rawBytes: Buffer | null,
): Promise<HistoryStreamSnapshot> {
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
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
    const defect = describeHistoryRecordDefect(parsed);
    if (defect !== null) {
      throw new PmCliError(
        `History for ${itemId} holds ${defect} at line ${index + 1}, which is not a history record. Remove or restore the line and retry.`,
        EXIT_CODE.GENERIC_FAILURE,
        {
          code: "history_record_invalid",
          item_id: itemId,
          reason: defect,
          details: { line: index + 1 },
          required: "Every history line must be one JSON object record.",
          nextSteps: [
            `Run pm history-repair ${itemId} --salvage-tail --dry-run: it removes a line that cannot hold a record (a JSON null, boolean or number) and keeps every record.`,
            "Otherwise recover the line from version control or a backup.",
          ],
        },
      );
    }
    entries.push(parsed as HistoryEntry);
  }
  return { raw, raw_bytes: rawBytes, entries };
}

/**
 * Describe why one decoded JSONL value cannot be a history record, or return
 * null for an object. Readers dereference every line as an object, so a JSON
 * null, boolean, number, string or array refuses here with a typed error
 * instead of crashing a reader; objects keep each reader's legacy tolerance.
 */
export function describeHistoryRecordDefect(value: unknown): string | null {
  if (value === null) return "a JSON null";
  if (Array.isArray(value)) return "a JSON array";
  return typeof value === "object" ? null : `a JSON ${typeof value}`;
}

/** Whether one decoded JSON value is a scalar that cannot encode or hide a record. */
export function isNonRecordScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  );
}

/** Read and validate one item's JSONL history stream without mutating it. */
export async function readHistoryEntries(
  historyPath: string,
  itemId: string,
): Promise<HistoryEntry[]> {
  return (await readHistorySnapshot(historyPath, itemId)).entries;
}
