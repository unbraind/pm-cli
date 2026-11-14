/**
 * @module sdk/governance/validate-deferred-fields
 *
 * Lists strict-required fields that were deferred at create and still have
 * no value as curation work in `pm validate --check-metadata` (GH-1713). Each
 * row names the item, the deferred fields and the recorded reasons, so an
 * agent can see what an importer could not know and record it.
 */
import { outstandingDeferredFields } from "../../core/item/deferred-fields.js";
import type { ItemMetadata } from "../../types/index.js";

/** Bounded number of item rows reported without `--verbose`. */
const DEFERRED_FIELD_ROW_LIMIT = 5;

/** One item that still carries deferred strict-required fields. */
export interface DeferredFieldCurationRow {
  /** Item id. */
  id: string;
  /** Deferred fields that still have no value. */
  fields: string[];
  /** Distinct reasons recorded for those fields. */
  reasons: string[];
}

/** The deferred-field curation summary attached to the metadata check. */
export interface DeferredFieldCuration {
  /** Details merged into the metadata check under `deferred_fields`. */
  details: {
    /** Number of items that still carry deferred fields. */
    items: number;
    /** Per-field count of items still deferring it. */
    by_field: Record<string, number>;
    /** Bounded rows, or every row with verbose diagnostics. */
    rows: DeferredFieldCurationRow[];
    /** True when rows were bounded. */
    truncated: boolean;
  };
  /** Warning token `validate_metadata_deferred_fields:<items>`. */
  warning: string;
}

/**
 * Summarize every item whose deferred fields still lack a value, or return
 * undefined when nothing is deferred, so a tracker without deferrals reports
 * exactly what it reported before.
 */
export function summarizeDeferredFieldCuration(
  items: readonly Pick<ItemMetadata, "id" | "deferred_fields">[],
  verboseDiagnostics: boolean,
): DeferredFieldCuration | undefined {
  const rows: DeferredFieldCurationRow[] = [];
  const byField: Record<string, number> = {};
  for (const item of items) {
    const outstanding = outstandingDeferredFields(item);
    if (outstanding.length === 0) continue;
    for (const entry of outstanding) byField[entry.field] = (byField[entry.field] ?? 0) + 1;
    rows.push({
      id: item.id,
      fields: outstanding.map((entry) => entry.field),
      reasons: [...new Set(outstanding.map((entry) => entry.reason))],
    });
  }
  if (rows.length === 0) return undefined;
  rows.sort((left, right) => left.id.localeCompare(right.id));
  const limit = verboseDiagnostics ? rows.length : DEFERRED_FIELD_ROW_LIMIT;
  return {
    details: {
      items: rows.length,
      by_field: Object.fromEntries(Object.entries(byField).sort(([left], [right]) => left.localeCompare(right))),
      rows: rows.slice(0, limit),
      truncated: rows.length > limit,
    },
    warning: `validate_metadata_deferred_fields:${rows.length}`,
  };
}
