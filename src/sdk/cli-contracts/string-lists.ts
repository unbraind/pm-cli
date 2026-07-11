/**
 * @module sdk/cli-contracts/string-lists
 *
 * Shared string-list normalization for the CLI contract modules: collapse a
 * sequence of strings to its unique, trimmed, non-empty members in first-seen
 * order.
 */

/** Returns the unique, trimmed, non-empty members of `values` in first-seen order. Each value is trimmed before deduplication so accidental surrounding whitespace cannot leak into — or produce duplicate — flag aliases and MCP schema parameter keys. */
export function normalizeUniqueStringList(values: Iterable<string>): string[] {
  return [
    ...new Set(
      Array.from(values, (value) => value.trim()).filter(
        (value) => value.length > 0,
      ),
    ),
  ];
}
