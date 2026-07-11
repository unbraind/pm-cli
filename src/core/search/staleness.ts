/**
 * Vectorization-ledger staleness helpers.
 *
 * The vectorization status ledger at `search/vectorization-status.json`
 * records the `updated_at` of every item that has been embedded into the
 * vector store. When an item's current `updated_at` differs from the
 * ledger's recorded value (or the item is missing from the ledger
 * entirely), the vector store is stale for that item and a `pm reindex`
 * is needed.
 *
 * This module exposes the comparison helper as a tiny pure function so it
 * can be reused by `pm health` (gates), `pm reindex`, and `pm search`
 * (query-time staleness warning) without re-importing each other.
 */

/** Minimal item shape required to compare vectorization freshness. */
export interface ItemWithUpdatedAt {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** ISO 8601 timestamp recording when updated occurred. */
  updated_at: string;
}

/** Return the sorted list of item IDs whose current `updated_at` does not match the ledger entry. Missing ledger entries count as stale. */
export function collectStaleVectorizationIds<T extends ItemWithUpdatedAt>(
  items: readonly T[],
  ledgerEntries: Readonly<Record<string, string>> | null | undefined,
): string[] {
  // Tolerate a missing / corrupted / partially-written ledger by treating
  // unknown items as stale (the same as having no entry).
  const entries = ledgerEntries ?? {};
  return items
    .filter((item) => {
      const trackedUpdatedAt = entries[item.id];
      return trackedUpdatedAt !== item.updated_at;
    })
    .map((item) => item.id)
    .sort((left, right) => left.localeCompare(right));
}
