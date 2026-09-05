/**
 * @module sdk/governance/linked-file-report
 *
 * Joins missing-file evidence with holder lifecycle before projecting a bounded
 * repair worklist. Counts always describe the complete supplied evidence.
 */
import { normalizeStatusInput } from "../../core/item/status.js";
import type { RuntimeStatusRegistry } from "../../core/schema/runtime-schema.js";
import {
  buildMissingLinkedPathRows,
  type MissingLinkedPathOwner,
  type MissingLinkedPathRow,
  type OwnerItemMetadata,
  type StaleLinkOwnerInput,
} from "../../core/validate/missing-link-owners.js";
import type { ClassifiedStaleLinkedPath } from "../../core/validate/stale-file-classification.js";

/** Repair evidence for one path; nested holders use the same ceiling as paths. */
export interface LinkedFileRepairRow extends MissingLinkedPathRow {
  /** Same-basename possibilities, not verified relocation instructions. */
  candidates: string[];
  /** Whether the classifier withheld additional possible destinations. */
  candidates_truncated: boolean;
  /** Unique holder and field pairs referencing this path before projection. */
  link_count: number;
  /** Whether the bounded holder list omits any link. */
  items_truncated: boolean;
  /** Number of links on nonterminal holders for this path. */
  active_link_count: number;
}

/** Full-population counters and a bounded, consistently structured worklist. */
export interface LinkedFileRepairReport {
  /** Distinct stale path count, also the unprojected worklist row count. */
  missing_linked_path_rows_count: number;
  /** Paths with owners and candidates joined before either is truncated. */
  missing_linked_path_rows: LinkedFileRepairRow[];
  /** Whether any complete path row is omitted. */
  missing_linked_path_rows_truncated: boolean;
  /** Unique path, holder and field triples across every lifecycle state. */
  missing_linked_links_count: number;
  /** Missing links whose holders are actionable under the workspace registry. */
  active_missing_linked_links_count: number;
  /** Missing links on holders with the configured close status. */
  legacy_closed_missing_linked_links_count: number;
  /** Missing links on all terminal holders, including the closed subset. */
  legacy_terminal_missing_linked_links_count: number;
  /** Distinct paths referenced by at least one active holder. */
  active_missing_linked_paths_count: number;
}

/**
 * Build an active-first repair worklist with deterministic path/holder sorting. Unknown
 * statuses and absent holder metadata remain actionable. Infinity explicitly
 * restores every path and holder; finite limits cap both dimensions equally.
 */
export function buildLinkedFileRepairReport(
  links: readonly StaleLinkOwnerInput[],
  classifications: readonly ClassifiedStaleLinkedPath[],
  lookup: (id: string) => OwnerItemMetadata | undefined,
  registry: RuntimeStatusRegistry,
  limit = 40,
): LinkedFileRepairReport {
  const ceiling =
    limit === Infinity
      ? Infinity
      : Number.isFinite(limit)
        ? Math.max(0, Math.floor(limit))
        : 40;
  const byPath = new Map(classifications.map((entry) => [entry.path, entry]));
  const report: LinkedFileRepairReport = {
    missing_linked_path_rows_count: 0,
    missing_linked_path_rows: [],
    missing_linked_path_rows_truncated: false,
    missing_linked_links_count: 0,
    active_missing_linked_links_count: 0,
    legacy_closed_missing_linked_links_count: 0,
    legacy_terminal_missing_linked_links_count: 0,
    active_missing_linked_paths_count: 0,
  };
  const rows = buildMissingLinkedPathRows(links, lookup).map((row) => {
    const active: MissingLinkedPathOwner[] = [];
    const terminal: MissingLinkedPathOwner[] = [];
    for (const owner of row.items) {
      const status =
        normalizeStatusInput(owner.status, registry) ?? owner.status;
      if (registry.terminal_statuses.has(status)) {
        terminal.push(owner);
        if (status === registry.close_status)
          report.legacy_closed_missing_linked_links_count += 1;
      } else {
        active.push(owner);
      }
    }
    report.missing_linked_links_count += row.items.length;
    report.active_missing_linked_links_count += active.length;
    report.legacy_terminal_missing_linked_links_count += terminal.length;
    if (active.length > 0) report.active_missing_linked_paths_count += 1;
    const classification = byPath.get(row.path);
    return {
      ...row,
      candidates: classification?.candidates ?? [],
      candidates_truncated: classification?.candidates_truncated ?? false,
      link_count: row.items.length,
      active_link_count: active.length,
      items: [...active, ...terminal].slice(0, ceiling),
      items_truncated: row.items.length > ceiling,
    };
  });
  rows.sort(
    (left, right) =>
      Number(right.active_link_count > 0) -
        Number(left.active_link_count > 0) ||
      left.path.localeCompare(right.path),
  );
  report.missing_linked_path_rows_count = rows.length;
  report.missing_linked_path_rows = rows.slice(0, ceiling);
  report.missing_linked_path_rows_truncated = rows.length > ceiling;
  return report;
}
