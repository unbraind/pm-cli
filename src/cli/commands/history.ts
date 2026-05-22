import { pathExists, readFileIfExists } from "../../core/fs/fs-utils.js";
import { hashDocument, hashEmptyDocument } from "../../core/history/history.js";
import { verifyHistoryChain } from "../../core/history/replay.js";
import { enforceHistoryStreamPolicyForItem } from "../../core/history/history-stream-policy.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { findFirstMergeConflictMarker } from "../../core/shared/conflict-markers.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { getActiveExtensionRegistrations, runActiveOnReadHooks } from "../../core/extensions/index.js";
import { normalizeItemId } from "../../core/item/id.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { locateItem, readLocatedItem } from "../../core/store/item-store.js";
import { getHistoryPath, getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import { parseLimit } from "../shared-parsers.js";
import type { HistoryEntry } from "../../types/index.js";

export { verifyHistoryChain } from "../../core/history/replay.js";

export interface HistoryCommandOptions {
  limit?: string;
  diff?: boolean;
  verify?: boolean;
  compact?: boolean;
}

export interface HistoryDiffEntry {
  index: number;
  ts: string;
  op: string;
  author: string;
  patch_ops: number;
  changed_fields: string[];
}

export interface HistoryVerificationResult {
  ok: boolean;
  entries: number;
  errors: string[];
  latest_after_hash?: string;
  current_item_hash?: string;
  current_matches_latest?: boolean;
}

export interface HistoryResult {
  id: string;
  history: HistoryEntry[];
  compact_history?: HistoryDiffEntry[];
  compact: boolean;
  count: number;
  limit: number | null;
  diff?: HistoryDiffEntry[];
  verification?: HistoryVerificationResult;
}

function limitEntries<T>(values: T[], limit: number | undefined): T[] {
  if (limit === undefined) return values;
  return values.slice(Math.max(0, values.length - limit));
}

function decodeJsonPointerSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function patchPathToChangedField(path: string): string {
  if (path === "/body" || path.startsWith("/body/")) {
    return "body";
  }
  if (
    path === "/metadata" ||
    path.startsWith("/metadata/") ||
    path === "/front_matter" ||
    path.startsWith("/front_matter/")
  ) {
    const segment = path.replace(/^\/(?:metadata|front_matter)\/?/, "").split("/")[0];
    if (!segment) {
      return "metadata";
    }
    return decodeJsonPointerSegment(segment);
  }
  const segment = path.replace(/^\//, "").split("/")[0];
  return segment ? decodeJsonPointerSegment(segment) : "root";
}

function buildDiffEntries(entries: HistoryEntry[], startIndex: number): HistoryDiffEntry[] {
  return entries.map((entry, index) => {
    const changedFields = new Set<string>();
    for (const op of entry.patch) {
      changedFields.add(patchPathToChangedField(op.path));
      if (op.from) {
        changedFields.add(patchPathToChangedField(op.from));
      }
    }
    return {
      index: startIndex + index + 1,
      ts: entry.ts,
      op: entry.op,
      author: entry.author,
      patch_ops: entry.patch.length,
      changed_fields: [...changedFields].sort((left, right) => left.localeCompare(right)),
    };
  });
}

export async function readHistoryEntries(historyPath: string, itemId: string): Promise<HistoryEntry[]> {
  const raw = await readFileIfExists(historyPath);
  if (raw === null) {
    return [];
  }
  await runActiveOnReadHooks({
    path: historyPath,
    scope: "project",
  });
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
        examples: [`pm history ${itemId}`, `pm restore ${itemId} <timestamp-or-version>`],
        nextSteps: ["Resolve or restore the history file, then rerun the command."],
      },
    );
  }

  const entries: HistoryEntry[] = [];
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
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

export async function runHistory(id: string, options: HistoryCommandOptions, global: GlobalOptions): Promise<HistoryResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }

  const limit = parseLimit(options.limit);
  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const normalizedId = normalizeItemId(id, settings.id_prefix);
  const located = await locateItem(
    pmRoot,
    normalizedId,
    settings.id_prefix,
    settings.item_format,
    typeRegistry.type_to_folder,
  );
  const resolvedId = located?.id ?? normalizedId;
  const historyPath = getHistoryPath(pmRoot, resolvedId);
  if (!located && !(await pathExists(historyPath))) {
    throw new PmCliError(`Item ${id} not found`, EXIT_CODE.NOT_FOUND);
  }
  if (located) {
    await enforceHistoryStreamPolicyForItem({
      pmRoot,
      settings,
      itemId: located.id,
      commandLabel: "history",
    });
  }

  const fullHistory = await readHistoryEntries(historyPath, resolvedId);
  const history = limitEntries(fullHistory, limit);
  const compact = options.compact === true;
  const compactHistory = compact ? buildDiffEntries(history, Math.max(0, fullHistory.length - history.length)) : undefined;
  const result: HistoryResult = {
    id: resolvedId,
    history: compact ? [] : history,
    compact_history: compactHistory,
    compact,
    count: history.length,
    limit: limit ?? null,
  };

  if (options.diff) {
    result.diff = compact ? [] : buildDiffEntries(history, Math.max(0, fullHistory.length - history.length));
  }

  if (options.verify) {
    const verification = verifyHistoryChain(fullHistory);
    const latestAfterHash = fullHistory.length > 0 ? fullHistory[fullHistory.length - 1].after_hash : hashEmptyDocument();
    let currentItemHash: string | undefined;
    let currentMatchesLatest: boolean | undefined;
    const errors = [...verification.errors];

    if (located) {
      const loaded = await readLocatedItem(located, { schema: settings.schema });
      currentItemHash = hashDocument(loaded.document);
      currentMatchesLatest = currentItemHash === latestAfterHash;
      if (!currentMatchesLatest) {
        errors.push("verify_failed:current_item_hash_mismatch");
      }
    }

    result.verification = {
      ok: errors.length === 0,
      entries: fullHistory.length,
      errors,
      latest_after_hash: fullHistory.length > 0 ? fullHistory[fullHistory.length - 1].after_hash : undefined,
      current_item_hash: currentItemHash,
      current_matches_latest: currentMatchesLatest,
    };
  }

  return result;
}
