/**
 * @module core/shared/memo
 *
 * Provides shared primitives and utilities for capped memoization maps.
 */

/**
 * Drop the oldest-inserted half of a memo map (Map preserves insertion order), so a
 * size-cap hit mid-scan keeps the newest-inserted half instead of cold-starting the
 * memo. Callers that re-insert entries on hit (the envelope memo) get LRU eviction;
 * the scalar comparator memos evict purely by insertion order.
 */
export function evictOldestMemoEntries<Value>(memo: Map<string, Value>): void {
  let remaining = Math.ceil(memo.size / 2);
  for (const key of memo.keys()) {
    if (remaining === 0) {
      return;
    }
    memo.delete(key);
    remaining -= 1;
  }
}
