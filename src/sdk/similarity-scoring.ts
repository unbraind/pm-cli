/**
 * @module sdk/similarity-scoring
 *
 * Dependency-light deterministic scoring shared by core governance and
 * extension packages without loading tracker query infrastructure.
 */
const ISSUE_CODE_PATTERN = /\b[a-z][a-z0-9]*-\d+\b/giu;

/** Precomputed title signals reused by bounded batch similarity operations. */
export interface PreparedSimilarityText {
  /** Canonical title used for exact comparison. */
  normalized: string;
  /** Unique normalized word tokens. */
  tokens: string[];
  /** Unique issue identifiers embedded in the title. */
  issueCodes: string[];
}

/** Stable score and strongest signal returned by title comparison. */
export interface ItemSimilarityScore {
  /** Similarity on the zero-to-one scale. */
  score: number;
  /** Strongest deterministic match signal. */
  reason: "exact_title" | "issue_code" | "title_token_jaccard";
}

/** Normalize title text for exact comparisons and tokenization. */
export function normalizeSimilarityText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Split normalized text into unique Unicode letter/number tokens. */
export function tokenizeSimilarityText(value: string): string[] {
  return [
    ...new Set(normalizeSimilarityText(value).match(/[\p{L}\p{N}]+/gu) ?? []),
  ];
}

/** Precompute every deterministic title signal exactly once for repeated comparisons. */
export function prepareSimilarityText(value: string): PreparedSimilarityText {
  const normalized = normalizeSimilarityText(value);
  return {
    normalized,
    tokens: tokenizeSimilarityText(normalized),
    issueCodes: [
      ...new Set(
        normalized
          .match(ISSUE_CODE_PATTERN)
          ?.map((code) => code.toLowerCase()) ?? [],
      ),
    ],
  };
}

/** Measure set overlap between two token collections. */
export function jaccardSimilarity(
  leftTokens: readonly string[],
  rightTokens: readonly string[],
): number {
  const left = new Set(leftTokens);
  const right = new Set(rightTokens);
  const union = new Set([...left, ...right]);
  if (union.size === 0) return 1;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  return intersection / union.size;
}

/** Score two titles through the canonical exact, issue-code, and token signals. */
export function scoreItemSimilarity(
  leftTitle: string,
  rightTitle: string,
): ItemSimilarityScore {
  return scorePreparedItemSimilarity(
    prepareSimilarityText(leftTitle),
    prepareSimilarityText(rightTitle),
  );
}

/** Score two precomputed title representations without repeating normalization or tokenization. */
export function scorePreparedItemSimilarity(
  left: PreparedSimilarityText,
  right: PreparedSimilarityText,
): ItemSimilarityScore {
  if (left.normalized === right.normalized) {
    return { score: 1, reason: "exact_title" };
  }
  const leftCodes = new Set(left.issueCodes);
  if (right.issueCodes.some((code) => leftCodes.has(code))) {
    return { score: 0.99, reason: "issue_code" };
  }
  return {
    score: jaccardSimilarity(left.tokens, right.tokens),
    reason: "title_token_jaccard",
  };
}
