/**
 * Per-item-type grouping of missing-required-field counts for
 * `pm validate --check-metadata` (pm-pmyq / GH-172).
 *
 * Pure module: callers stream `(item_type, field)` pairs — one per missing
 * required field occurrence — and receive a compact, deterministically sorted
 * `missing_by_type` map of counts (never row dumps), e.g.
 * `{ Task: { close_reason: 3, reviewer: 1 } }`.
 */

/** One missing required metadata field observed on an item of a specific type. */
export interface MissingFieldOccurrence {
  /** Item type name as stored in front matter (e.g. "Task"). */
  item_type: string;
  /** Required metadata field that is missing on the item. */
  field: string;
}

/** Aggregate missing-field occurrences into `{ type: { field: count } }` with both levels sorted lexicographically for stable, diff-friendly output. Zero counts never appear (only observed occurrences are aggregated). */
export function buildMissingByTypeCounts(
  occurrences: Iterable<MissingFieldOccurrence>,
): Record<string, Record<string, number>> {
  const countsByType = new Map<string, Map<string, number>>();
  for (const occurrence of occurrences) {
    let fieldCounts = countsByType.get(occurrence.item_type);
    if (!fieldCounts) {
      fieldCounts = new Map<string, number>();
      countsByType.set(occurrence.item_type, fieldCounts);
    }
    fieldCounts.set(
      occurrence.field,
      (fieldCounts.get(occurrence.field) ?? 0) + 1,
    );
  }

  const result: Record<string, Record<string, number>> = {};
  for (const type of [...countsByType.keys()].sort((left, right) =>
    left.localeCompare(right),
  )) {
    const fieldCounts = countsByType.get(type)!;
    const fields: Record<string, number> = {};
    for (const field of [...fieldCounts.keys()].sort((left, right) =>
      left.localeCompare(right),
    )) {
      fields[field] = fieldCounts.get(field)!;
    }
    result[type] = fields;
  }
  return result;
}
