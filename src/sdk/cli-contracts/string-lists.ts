/**
 * @module sdk/cli-contracts/string-lists
 *
 * Shared string-list normalization for the CLI contract modules: collapse a
 * sequence of strings to its unique, non-empty members in first-seen order.
 */

/**
 * Returns the unique, non-empty (after trimming) members of `values` in
 * first-seen order. Used to deduplicate flag aliases and MCP schema parameter
 * keys without reordering them.
 */
export function normalizeUniqueStringList(values: Iterable<string>): string[] {
  return [...new Set(Array.from(values).filter((value) => value.trim().length > 0))];
}
