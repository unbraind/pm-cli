/**
 * @module core/shared/split-comma-list
 *
 * Provides shared primitives and utilities for Split Comma List.
 */
/**
 * Configures comma-list parsing for command flags that support escaped separators.
 */
export interface SplitCommaListOptions {
  /** Separator pattern. Defaults to `/,/`. */
  separators?: RegExp | string;
  /** De-duplicate entries while preserving first-seen order. Defaults to `true`. */
  unique?: boolean;
  /** Sort entries lexicographically (default JS string sort). Defaults to `false`. */
  sort?: boolean;
}

/**
 * Split a comma-separated (or custom-separator) string into trimmed, non-empty entries.
 *
 * Default behaviour:
 *   - Splits on `,`.
 *   - Trims each entry and discards empty results (collapsing leading/trailing/duplicate separators).
 *   - De-duplicates while preserving first-seen order.
 *   - Does not sort.
 *
 * Returns `[]` for `undefined`/`null` input. Pure, dependency-free.
 */
export function splitCommaList(raw: string | undefined | null, options?: SplitCommaListOptions): string[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  const separators = options?.separators ?? /,/;
  const parts = raw.split(separators as never);
  const trimmed = parts.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  const unique = options?.unique !== false;
  const deduped = unique ? Array.from(new Set(trimmed)) : trimmed;
  if (options?.sort === true) {
    return [...deduped].sort();
  }
  return deduped;
}
