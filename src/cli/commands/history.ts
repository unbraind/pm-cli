/**
 * @module cli/commands/history
 *
 * Implements the pm history command surface and its agent-facing runtime behavior.
 */
import {
  pathExists,
  computeHistoryDiff,
  patchPathToChangedField,
  type HistoryDiffValueEntry,
  normalizeReplayPatchOps,
  verifyHistoryChain,
  enforceHistoryStreamPolicyForItem,
  EXIT_CODE,
  type GlobalOptions,
  PmCliError,
  getActiveExtensionRegistrations,
  normalizeItemId,
  resolveItemTypeRegistry,
  locateItem,
  readLocatedItem,
  getHistoryPath,
  getWorkspaceHistoryPath,
  getSettingsPath,
  resolvePmRoot,
  readSettings,
  WORKSPACE_HISTORY_ID,
} from "../../sdk/runtime-primitives.js";
import {
  readHistoryEntries,
  verifyHistoryEntries,
  type HistoryVerificationResult,
} from "../../sdk/history-read.js";
export { readHistoryEntries } from "../../sdk/history-read.js";
import { parseLimit } from "../shared-parsers.js";
import type { HistoryEntry } from "../../types/index.js";

export { verifyHistoryChain };
/** Documents the history command options payload exchanged by command, SDK, and package integrations. */
export interface HistoryCommandOptions {
  /** Value that configures or reports limit for this contract. */
  limit?: string;
  /** Value that configures or reports diff for this contract. */
  diff?: boolean;
  /** Restrict --diff to a single field's before/after transitions (implies --diff). */
  field?: string;
  /** Value that configures or reports verify for this contract. */
  verify?: boolean;
  /** Value that configures or reports compact for this contract. */
  compact?: boolean;
}

/** Documents the history diff entry payload exchanged by command, SDK, and package integrations. */
export interface HistoryDiffEntry {
  /** Value that configures or reports index for this contract. */
  index: number;
  /** Value that configures or reports ts for this contract. */
  ts: string;
  /** Value that configures or reports op for this contract. */
  op: string;
  /** Value that configures or reports author for this contract. */
  author: string;
  /** Value that configures or reports patch ops for this contract. */
  patch_ops: number;
  /** Value that configures or reports changed fields for this contract. */
  changed_fields: string[];
}

/** Documents the history result payload exchanged by command, SDK, and package integrations. */
export interface HistoryResult {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports history for this contract. */
  history: HistoryEntry[];
  /** Value that configures or reports compact history for this contract. */
  compact_history?: HistoryDiffEntry[];
  /** Value that configures or reports compact for this contract. */
  compact: boolean;
  /** Value that configures or reports count for this contract. */
  count: number;
  /** Value that configures or reports limit for this contract. */
  limit: number | null;
  /** Value that configures or reports diff for this contract. */
  diff?: HistoryDiffValueEntry[];
  /** Value that configures or reports verification for this contract. */
  verification?: HistoryVerificationResult;
}

function limitEntries<T>(values: T[], limit: number | undefined): T[] {
  if (limit === undefined) return values;
  return values.slice(Math.max(0, values.length - limit));
}

function buildDiffEntries(
  entries: HistoryEntry[],
  startIndex: number,
): HistoryDiffEntry[] {
  return entries.map((entry, index) => {
    const changedFields = new Set<string>();
    const patch = normalizeReplayPatchOps(entry.patch);
    for (const op of patch) {
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
      patch_ops: patch.length,
      changed_fields: [...changedFields].sort((left, right) =>
        left.localeCompare(right),
      ),
    };
  });
}

/** Implements run history for the public runtime surface of this module. */
export async function runHistory(
  id: string,
  options: HistoryCommandOptions,
  global: GlobalOptions,
): Promise<HistoryResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(
      `Tracker is not initialized at ${pmRoot}. Run pm init first.`,
      EXIT_CODE.NOT_FOUND,
    );
  }

  const limit = parseLimit(options.limit);
  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(
    settings,
    getActiveExtensionRegistrations(),
  );
  const workspaceHistoryRequested = id.trim() === WORKSPACE_HISTORY_ID;
  const normalizedId = workspaceHistoryRequested
    ? WORKSPACE_HISTORY_ID
    : normalizeItemId(id, settings.id_prefix);
  const located = await locateItem(
    pmRoot,
    normalizedId,
    settings.id_prefix,
    settings.item_format,
    typeRegistry.type_to_folder,
  );
  const resolvedId = located?.id ?? normalizedId;
  const historyPath = workspaceHistoryRequested
    ? getWorkspaceHistoryPath(pmRoot)
    : getHistoryPath(pmRoot, resolvedId);
  if (!located && !(await pathExists(historyPath))) {
    throw new PmCliError(`Item ${id} not found`, EXIT_CODE.NOT_FOUND);
  }
  /* c8 ignore next -- resolved ids in command tests always map to located items. */
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
  const compactHistory = compact
    ? buildDiffEntries(
        history,
        Math.max(0, fullHistory.length - history.length),
      )
    : undefined;
  const result: HistoryResult = {
    id: resolvedId,
    history: compact ? [] : history,
    compact_history: compactHistory,
    compact,
    count: history.length,
    limit: limit ?? null,
  };

  if (options.diff || options.field !== undefined) {
    // --diff replays the full chain to surface per-field before/after values for
    // the displayed window (the latest --limit entries). --field narrows to a
    // single field's transitions ("when did status change?"). Unlike the compact
    // projection above, the value diff is independent of the compact/full toggle.
    result.diff = computeHistoryDiff(fullHistory, {
      windowStartIndex: Math.max(0, fullHistory.length - history.length),
      field: options.field,
    });
  }

  if (options.verify) {
    /* c8 ignore next -- verify command paths currently execute with located on-disk items. */
    const currentDocument = located
      ? (
          await readLocatedItem(located, {
            schema: settings.schema,
          })
        ).document
      : undefined;
    result.verification = verifyHistoryEntries(fullHistory, currentDocument);
  }

  return result;
}
