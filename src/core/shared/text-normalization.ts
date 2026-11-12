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

/** UTF-16 code units a budgeted read keeps of an explanatory string it compacts. */
export const COMPACTED_STRING_LENGTH = 240;

/** The compaction marker: an ellipsis plus the omitted code-unit count (pm-n98pir). */
const COMPACTION_MARKER_PATTERN = /\u2026\[\+([1-9]\d*) chars\]$/u;

/**
 * Shorten an explanatory string the way budgeted reads do: a Unicode-safe
 * prefix followed by a marker naming how many code units were omitted, so a
 * write path can recognise text copied from a compacted read (pm-n98pir).
 */
export function compactExplanatoryString(value: string): string {
  if (value.length <= COMPACTED_STRING_LENGTH) return value;
  const prefix = unicodeSafePrefix(value, COMPACTED_STRING_LENGTH);
  return `${prefix}\u2026[+${value.length - prefix.length} chars]`;
}

/** Return how many code units a compacted string omitted, or undefined when the text does not end with the compaction marker. */
export function readCompactionMarker(text: string): number | undefined {
  const match = COMPACTION_MARKER_PATTERN.exec(text.trimEnd());
  return match ? Number(match[1]) : undefined;
}

/**
 * Whether an output key names a continuation token (`cursor`, `next_cursor`,
 * `output_cursor`, `source_cursor`, ...). A token is machine input for the
 * next call, so compaction never shortens it (GH-1710).
 */
export function isContinuationTokenKey(key: string): boolean {
  return key === "cursor" || key.endsWith("_cursor");
}

/**
 * Whether a cursor argument carries an ellipsis, which no encoder emits: the
 * caller pasted a value a compacted read shortened (GH-1710).
 */
export function isCompactedCursorArgument(value: string): boolean {
  return value.includes("\u2026");
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
