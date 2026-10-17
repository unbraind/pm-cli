/**
 * @module core/shared/text-normalization
 *
 * Provides shared primitives and utilities for Text Normalization.
 */
/** Normalizes text to lowercase whitespace-collapsed form for stable matching and comparison. */
export function normalizeLowercaseWhitespace(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Return a UTF-16 prefix without splitting a valid surrogate pair at its boundary. */
export function unicodeSafePrefix(value: string, end: number): string {
  const prefix = value.slice(0, end);
  const last = prefix.charCodeAt(prefix.length - 1);
  const next = value.charCodeAt(prefix.length);
  return last >= 0xD800 && last <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF
    ? prefix.slice(0, -1)
    : prefix;
}

/** Implements tokenize alpha numeric for the public runtime surface of this module. */
export function tokenizeAlphaNumeric(value: string): string[] {
  return normalizeLowercaseWhitespace(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/** Implements jaccard similarity for the public runtime surface of this module. */
export function jaccardSimilarity(
  leftTokens: readonly string[],
  rightTokens: readonly string[],
): number {
  if (leftTokens.length === 0 && rightTokens.length === 0) {
    return 1;
  }
  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return 0;
  }
  const leftSet = new Set(leftTokens);
  const rightSet = new Set(rightTokens);
  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) {
      intersection += 1;
    }
  }
  // Both token sets are non-empty here (guarded above), so union is always >= 1.
  const union = new Set([...leftSet, ...rightSet]).size;
  return intersection / union;
}
