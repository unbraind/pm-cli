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

/** Plan only backfills proven by the latest transition into a terminal status. */
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
    const entries = historyById.get(item.id) ?? [];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]!;
      const hasTerminalTransition = entry.patch.some((operation) => {
        if (
          operation.path === "/metadata/status" ||
          operation.path === "/front_matter/status"
        ) {
          return (
            typeof operation.value === "string" &&
            terminalStatuses.has(operation.value.trim().toLowerCase())
          );
        }
        if (operation.path !== "" || typeof operation.value !== "object") {
          return false;
        }
        const root = operation.value as Record<string, unknown>;
        const metadata =
          (root.metadata as Record<string, unknown> | undefined) ??
          (root.front_matter as Record<string, unknown> | undefined);
        return (
          typeof metadata?.status === "string" &&
          terminalStatuses.has(metadata.status.trim().toLowerCase())
        );
      });
      if (hasTerminalTransition && Number.isFinite(Date.parse(entry.ts))) {
        candidates.push({
          id: item.id,
          completed_at: entry.ts,
          history_op: entry.op,
        });
        break;
      }
    }
  }
  return candidates.sort((left, right) => left.id.localeCompare(right.id));
}
