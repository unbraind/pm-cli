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
  inspectWorkspaceHistoryState,
  getSettingsPath,
  resolvePmRoot,
  readSettings,
  WORKSPACE_HISTORY_ID,
} from "../runtime-primitives.js";
import {
  readHistoryEntries,
  verifyHistoryEntries,
  type HistoryVerificationResult,
} from "../history-read.js";
export { readHistoryEntries } from "../history-read.js";
import { parseLimit } from "./parsers.js";
import type { HistoryEntry } from "../../types/index.js";
import {
  resolveModePairedOutputOmissionReceipt,
  type OutputOmissionReceipt,
} from "../output-projection.js";
import {
  compileHistoryProvenanceMatcher,
  projectHistoryProvenance,
  resolveHistoryProvenanceDimensions,
  summarizeHistoryProvenance,
  type HistoryProvenanceRow,
  type HistoryProvenanceSummary,
} from "../history-provenance.js";

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
  /** Return patch-free provenance rows. */
  provenance?: boolean;
  /** Include constant-size provenance completeness metrics. */
  provenanceSummary?: boolean;
  /** Filter by canonical recorded or vocabulary-resolved harness. */
  harness?: string | readonly string[];
  /** Filter by privacy-safe invocation fingerprint. */
  agentInstance?: string | readonly string[];
  /** Exact provenance dimension predicates (`dimension=value`). */
  provenanceFilter?: string | readonly string[];
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
  history?: HistoryEntry[];
  /** Value that configures or reports compact history for this contract. */
  compact_history?: HistoryDiffEntry[];
  /** Patch-free immutable provenance rows. */
  provenance_history?: HistoryProvenanceRow[];
  /** Value that configures or reports compact for this contract. */
  compact: boolean;
  /** Explicit active row projection. */
  projection: {
    /** Stable projection mode. */
    mode: "compact" | "provenance" | "full";
    /** Active row collection key. */
    row_key: "compact_history" | "provenance_history" | "history";
  };
  /** Constant-size disclosure of field groups withheld by the active mode. */
  omission_receipt: OutputOmissionReceipt;
  /** Value that configures or reports count for this contract. */
  count: number;
  /** Value that configures or reports limit for this contract. */
  limit: number | null;
  /** Value that configures or reports diff for this contract. */
  diff?: HistoryDiffValueEntry[];
  /** Value that configures or reports verification for this contract. */
  verification?: HistoryVerificationResult;
  /** Constant-size provenance completeness metrics. */
  provenance_summary?: HistoryProvenanceSummary;
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

async function resolveHistoryReadTarget(id: string, global: GlobalOptions) {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(
      `Tracker is not initialized at ${pmRoot}. Run pm init first.`,
      EXIT_CODE.NOT_FOUND,
    );
  }
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
  return { historyPath, located, resolvedId, settings };
}

/** Implements run history for the public runtime surface of this module. */
export async function runHistory(
  id: string,
  options: HistoryCommandOptions,
  global: GlobalOptions,
): Promise<HistoryResult> {
  const limit = parseLimit(options.limit);
  const { historyPath, located, resolvedId, settings } =
    await resolveHistoryReadTarget(id, global);

  const fullHistory = await readHistoryEntries(historyPath, resolvedId);
  const vocabulary = settings.agent_identity!.identity_vocabulary!;
  const provenanceDimensions = resolveHistoryProvenanceDimensions(
    settings.agent_identity!.harness_signals,
  );
  const matchesProvenance = compileHistoryProvenanceMatcher(
    {
      harness: options.harness,
      agentInstance: options.agentInstance,
      provenance: options.provenanceFilter,
    },
    vocabulary,
    provenanceDimensions,
  );
  const filteredHistory = fullHistory
    .map((entry, index) => ({ entry, version: index + 1 }))
    .filter(({ entry }) => matchesProvenance(entry));
  const selectedHistory = limitEntries(filteredHistory, limit);
  const history = selectedHistory.map(({ entry }) => entry);
  const compact = options.compact === true;
  const compactHistory = compact
    ? buildDiffEntries(
        history,
        Math.max(0, fullHistory.length - history.length),
      )
    : undefined;
  const provenanceHistory =
    options.provenance === true
      ? selectedHistory.map(({ entry, version }) =>
          projectHistoryProvenance(entry, vocabulary, {
            itemId: resolvedId,
            version,
          }),
        )
      : undefined;
  const projectionMode =
    options.provenance === true ? "provenance" : compact ? "compact" : "full";
  const rowProjection = {
    compact: { compact_history: compactHistory },
    provenance: { provenance_history: provenanceHistory },
    full: { history },
  }[projectionMode];
  const rowKey = {
    compact: "compact_history",
    provenance: "provenance_history",
    full: "history",
  } as const;
  const result: HistoryResult = {
    id: resolvedId,
    ...rowProjection,
    compact,
    projection: {
      mode: projectionMode,
      row_key: rowKey[projectionMode],
    },
    omission_receipt: resolveModePairedOutputOmissionReceipt(
      "history",
      projectionMode,
    ),
    count: history.length,
    limit: limit ?? null,
    ...(options.provenanceSummary === true
      ? {
          provenance_summary: summarizeHistoryProvenance(
            filteredHistory.map(({ entry }) => entry),
            vocabulary,
            provenanceDimensions,
          ),
        }
      : {}),
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
    if (resolvedId === WORKSPACE_HISTORY_ID && result.verification.ok) {
      const agreement = await inspectWorkspaceHistoryState(
        resolvePmRoot(process.cwd(), global.path),
      );
      result.verification = {
        ...result.verification,
        ok: agreement.ok,
        errors: agreement.ok
          ? result.verification.errors
          : [
              ...result.verification.errors,
              "verify_failed:workspace_state_mismatch",
            ],
        workspace_state_matches_latest: agreement.ok,
        workspace_state_mismatches: agreement.mismatched_documents,
        workspace_state_missing: agreement.missing_documents,
        workspace_state_unreadable: agreement.unreadable_documents,
      };
    }
  }

  return result;
}
