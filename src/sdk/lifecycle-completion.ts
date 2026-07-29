/**
 * @module sdk/lifecycle-completion
 *
 * Resolves actual-completion timestamps and plans evidence-only legacy backfills.
 */
import type { HistoryEntry, ItemMetadata } from "../types/index.js";

/** Provenance of the timestamp selected for completion-aware reporting. */
export type CompletionTimestampSource =
  | "completed_at"
  | "closed_at"
  | "updated_at";

/** A completion timestamp together with its explicit compatibility source. */
export interface ResolvedCompletionTimestamp {
  /** ISO timestamp selected for reporting. */
  timestamp: string;
  /** Metadata field that supplied the timestamp. */
  source: CompletionTimestampSource;
  /** Whether a legacy fallback was required. */
  fallback: boolean;
}

/** One lossless backfill supported by terminal-transition history evidence. */
export interface CompletedAtBackfillCandidate {
  /** Item whose missing completed_at can be corrected. */
  id: string;
  /** Evidence-backed timestamp proposed for completed_at. */
  completed_at: string;
  /** History operation that recorded the terminal transition. */
  history_op: string;
}

/** Read the normalized status written by one history entry, if present. */
function patchedStatus(entry: HistoryEntry): string | undefined {
  for (const operation of entry.patch) {
    if (
      operation.path === "/metadata/status" ||
      operation.path === "/front_matter/status"
    ) {
      if (typeof operation.value === "string") {
        return operation.value.trim().toLowerCase();
      }
      continue;
    }
    if (operation.path !== "" || typeof operation.value !== "object") {
      continue;
    }
    const root = operation.value as Record<string, unknown>;
    const metadata =
      (root.metadata as Record<string, unknown> | undefined) ??
      (root.front_matter as Record<string, unknown> | undefined);
    if (typeof metadata?.status === "string") {
      return metadata.status.trim().toLowerCase();
    }
  }
  return undefined;
}

/** Select the latest timestamp backed by a genuine terminal transition. */
function findEvidenceBackfill(
  id: string,
  entries: readonly HistoryEntry[],
  terminalStatuses: ReadonlySet<string>,
): CompletedAtBackfillCandidate | undefined {
  let previousStatus: string | undefined;
  let candidate: CompletedAtBackfillCandidate | undefined;
  for (const entry of entries) {
    const nextStatus = patchedStatus(entry);
    if (nextStatus === undefined) {
      continue;
    }
    const hasTransitionEvidence =
      terminalStatuses.has(nextStatus) &&
      ((previousStatus !== undefined &&
        !terminalStatuses.has(previousStatus)) ||
        (previousStatus === undefined && entry.op === "create"));
    previousStatus = nextStatus;
    if (hasTransitionEvidence && Number.isFinite(Date.parse(entry.ts))) {
      candidate = {
        id,
        completed_at: entry.ts,
        history_op: entry.op,
      };
    }
  }
  return candidate;
}

/** Resolve reporting time while disclosing every legacy fallback. */
export function resolveCompletionTimestamp(
  item: Pick<ItemMetadata, "completed_at" | "closed_at" | "updated_at">,
): ResolvedCompletionTimestamp {
  if (item.completed_at !== undefined) {
    return {
      timestamp: item.completed_at,
      source: "completed_at",
      fallback: false,
    };
  }
  if (item.closed_at !== undefined) {
    return {
      timestamp: item.closed_at,
      source: "closed_at",
      fallback: true,
    };
  }
  return {
    timestamp: item.updated_at,
    source: "updated_at",
    fallback: true,
  };
}

/** Plan only backfills proven by a transition into a terminal status. */
export function planCompletedAtBackfill(
  items: readonly ItemMetadata[],
  historyById: ReadonlyMap<string, readonly HistoryEntry[]>,
  terminalStatuses: ReadonlySet<string>,
): CompletedAtBackfillCandidate[] {
  const candidates: CompletedAtBackfillCandidate[] = [];
  for (const item of items) {
    if (
      item.completed_at !== undefined ||
      !terminalStatuses.has(item.status.trim().toLowerCase())
    ) {
      continue;
    }
    const candidate = findEvidenceBackfill(
      item.id,
      historyById.get(item.id) ?? [],
      terminalStatuses,
    );
    if (candidate !== undefined) {
      candidates.push(candidate);
    }
  }
  return candidates.sort((left, right) => left.id.localeCompare(right.id));
}
