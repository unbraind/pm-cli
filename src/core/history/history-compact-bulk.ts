/**
 * @module core/history/history-compact-bulk
 *
 * Pure selection logic for bulk history-stream compaction. Given a set of
 * history-stream candidates (id, entry count, and lifecycle bucket of the
 * owning item) plus the requested selection criteria, this module decides which
 * streams should be compacted and which are skipped (and why).
 *
 * The module performs no filesystem access and imports no heavy runtime
 * dependencies — the command layer reads streams and item statuses, hands the
 * resolved candidates here, then executes per-item compaction on the selection
 * this module returns. Keeping selection pure makes the matrix of scope /
 * threshold / explicit-id rules trivially testable without touching disk.
 */

import type { LifecycleBucket } from "../governance/metadata-coverage.js";

/** Bulk-compaction scope: only closed items, or every history stream. */
export type HistoryCompactScope = "closed" | "all-streams";

/** Why a candidate stream was not selected for compaction. */
export type HistoryCompactBulkSkipReason =
  | "no_stream"
  | "already_compact"
  | "scope_mismatch"
  | "below_threshold";

/**
 * One history stream considered for bulk compaction.
 *
 * `bucket` is the lifecycle bucket of the owning item, or `null` when no item
 * matches the stream (an orphan history file). Orphan streams never satisfy a
 * `closed` scope filter but are eligible under `all-streams`.
 */
export interface HistoryCompactBulkCandidate {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports entries for this contract. */
  entries: number;
  /** Value that configures or reports bucket for this contract. */
  bucket: LifecycleBucket | null;
}

/** Selection criteria resolved from the command flags + policy defaults. */
export interface HistoryCompactBulkCriteria {
  /** Explicit, ordered list of item ids to compact. When non-empty the selection runs in "ids" mode: scope/allOver are ignored and only the `minEntries` floor applies. Duplicates are collapsed, preserving first-seen order. */
  ids?: string[];
  /** Lifecycle scope filter for scan mode (ignored in ids mode). */
  scope?: HistoryCompactScope;
  /** Streams with at most this many entries are skipped as `already_compact` (compaction collapses a stream to a 2-entry baseline+audit pair, so smaller streams gain nothing). Applies in both modes. */
  minEntries: number;
  /** Scan mode only: when set, only streams with strictly more entries than this are selected. Streams above `minEntries` but at/below `allOver` are skipped as `below_threshold`. */
  allOver?: number;
}

/** Per-candidate selection outcome. */
export interface HistoryCompactBulkSelectionRow {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports entries for this contract. */
  entries: number;
  /** Value that configures or reports selected for this contract. */
  selected: boolean;
  /** Value that configures or reports skip reason for this contract. */
  skip_reason: HistoryCompactBulkSkipReason | null;
}

function selectIdsMode(
  ids: string[],
  byId: ReadonlyMap<string, HistoryCompactBulkCandidate>,
  minEntries: number,
): HistoryCompactBulkSelectionRow[] {
  const seen = new Set<string>();
  const rows: HistoryCompactBulkSelectionRow[] = [];
  for (const rawId of ids) {
    const id = rawId.trim();
    if (id.length === 0 || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const candidate = byId.get(id);
    if (candidate === undefined) {
      rows.push({ id, entries: 0, selected: false, skip_reason: "no_stream" });
      continue;
    }
    if (candidate.entries <= minEntries) {
      rows.push({
        id,
        entries: candidate.entries,
        selected: false,
        skip_reason: "already_compact",
      });
      continue;
    }
    rows.push({
      id,
      entries: candidate.entries,
      selected: true,
      skip_reason: null,
    });
  }
  return rows;
}

function selectScanMode(
  candidates: HistoryCompactBulkCandidate[],
  criteria: HistoryCompactBulkCriteria,
): HistoryCompactBulkSelectionRow[] {
  const ordered = [...candidates].sort(
    (a, b) => b.entries - a.entries || a.id.localeCompare(b.id),
  );
  const rows: HistoryCompactBulkSelectionRow[] = [];
  for (const candidate of ordered) {
    if (criteria.scope === "closed" && candidate.bucket !== "closed") {
      rows.push({
        id: candidate.id,
        entries: candidate.entries,
        selected: false,
        skip_reason: "scope_mismatch",
      });
      continue;
    }
    if (candidate.entries <= criteria.minEntries) {
      rows.push({
        id: candidate.id,
        entries: candidate.entries,
        selected: false,
        skip_reason: "already_compact",
      });
      continue;
    }
    if (
      criteria.allOver !== undefined &&
      candidate.entries <= criteria.allOver
    ) {
      rows.push({
        id: candidate.id,
        entries: candidate.entries,
        selected: false,
        skip_reason: "below_threshold",
      });
      continue;
    }
    rows.push({
      id: candidate.id,
      entries: candidate.entries,
      selected: true,
      skip_reason: null,
    });
  }
  return rows;
}

/**
 * Decide which history streams to compact.
 *
 * Runs in "ids" mode when `criteria.ids` is non-empty (exact, ordered set,
 * honouring only the `minEntries` floor) and "scan" mode otherwise (every
 * candidate, filtered by scope and entry thresholds, ordered deepest-first).
 */
export function selectHistoryCompactBulkTargets(
  candidates: HistoryCompactBulkCandidate[],
  criteria: HistoryCompactBulkCriteria,
): HistoryCompactBulkSelectionRow[] {
  if (criteria.ids !== undefined && criteria.ids.length > 0) {
    const byId = new Map(
      candidates.map((candidate) => [candidate.id, candidate]),
    );
    return selectIdsMode(criteria.ids, byId, criteria.minEntries);
  }
  return selectScanMode(candidates, criteria);
}
