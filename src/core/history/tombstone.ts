/**
 * @module core/history/tombstone
 * Diagnoses retained deletions without confusing missing files with proven deletes.
 */
import { statSync } from "node:fs";
import type { HistoryEntry } from "../../types/index.js";
import { normalizeItemId, normalizeRawItemId } from "../item/id.js";
import { getHistoryPath } from "../store/paths.js";
import { EXIT_CODE } from "../shared/constants.js";
import { renderPmCommand } from "../shared/command-line.js";
import { PmCliError } from "../shared/errors.js";
import { readHistoryEntries } from "./read.js";
import {
  applyHistoryPatch,
  replayHistoryToTarget,
  resolveHistoryTarget,
} from "./projection.js";
import { EMPTY_REPLAY_DOCUMENT } from "./replay.js";
import { historyVersionOffset } from "./version-address.js";

/** Find the latest materialized address, refusing ambiguous legacy checkpoint timestamps. */
function resolveDeletedRecoveryTarget(
  entries: HistoryEntry[],
  id: string,
): { version: number | null; target: string | undefined } {
  let materializedIndex = -1;
  let document = structuredClone(EMPTY_REPLAY_DOCUMENT);
  for (const [index, entry] of entries.entries()) {
    document = applyHistoryPatch(document, entry.patch, index + 1, entry.op);
    if (document.metadata.id !== undefined && document.metadata.id !== id) {
      throw new PmCliError(
        `History belongs to item ${String(document.metadata.id)}, expected ${id}.`,
        EXIT_CODE.GENERIC_FAILURE,
        {
          code: "history_replay_invalid",
          required:
            "Recover the correct history stream for this item before attempting restoration.",
        },
      );
    }
    if (document.metadata.id === id && Array.isArray(document.metadata.tags))
      materializedIndex = index;
  }
  const offset = historyVersionOffset(entries, true);
  const version =
    materializedIndex < 0 || offset === null
      ? null
      : offset + materializedIndex + 1;
  let target = version === null ? undefined : String(version);
  if (materializedIndex >= 0 && target === undefined) {
    const timestamp = entries[materializedIndex]!.ts;
    if (
      resolveHistoryTarget(timestamp, entries).historyIndex ===
      materializedIndex
    )
      target = timestamp;
  }
  return { version, target };
}

/** Return a bounded recovery error only when verified history proves deletion. */
export async function buildDeletedItemError(
  pmRoot: string,
  rawId: string,
  idPrefix: string,
): Promise<PmCliError | undefined> {
  const candidates = new Set([
    normalizeItemId(rawId, idPrefix),
    normalizeRawItemId(rawId),
  ]);
  for (const id of candidates) {
    const historyPath = getHistoryPath(pmRoot, id);
    if (!statSync(historyPath, { throwIfNoEntry: false })?.isFile()) continue;
    const entries = await readHistoryEntries(historyPath, id);
    let deletionIndex = -1;
    entries.forEach((entry, index) => {
      if (entry.op === "delete") deletionIndex = index;
    });
    if (deletionIndex < 0) continue;
    const final = replayHistoryToTarget(entries, entries.length - 1);
    if (Object.keys(final.metadata).length !== 0) continue;
    const { version, target } = resolveDeletedRecoveryTarget(entries, id);
    const readArgs =
      target === undefined
        ? ["history", id, "--verify"]
        : ["get", id, "--at", target];
    const readCommand = renderPmCommand(readArgs);
    return new PmCliError(
      `Item ${id} was deleted at ${entries[deletionIndex]!.ts}; its history is retained.`,
      EXIT_CODE.NOT_FOUND,
      {
        code: "item_deleted",
        required:
          "Read a retained materialized version, then restore it if the item should exist again.",
        item_id: id,
        tombstone: {
          deleted: true,
          deleted_at: entries[deletionIndex]!.ts,
          recoverable: target !== undefined,
          last_materialized_version: version,
        },
        nextSteps: [
          readCommand,
          ...(target === undefined
            ? ["Recover the pre-compaction history from version control."]
            : [renderPmCommand(["restore", id, target])]),
        ],
        recovery: {
          suggested_retry: readCommand,
          suggested_retry_args: readArgs,
        },
      },
    );
  }
  return undefined;
}
