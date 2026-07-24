/**
 * @module sdk/similarity-scoring
 *
 * Dependency-light deterministic scoring shared by core governance and
 * extension packages without loading tracker query infrastructure.
 */
const ISSUE_CODE_PATTERN = /\b[a-z][a-z0-9]*-\d+\b/giu;

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
  const leftNormalized = normalizeSimilarityText(leftTitle);
  const rightNormalized = normalizeSimilarityText(rightTitle);
  if (leftNormalized === rightNormalized) {
    return { score: 1, reason: "exact_title" };
  }
  const leftCodes = new Set(
    leftNormalized.match(ISSUE_CODE_PATTERN)?.map((code) => code.toLowerCase()),
  );
  const rightCodes = rightNormalized.match(ISSUE_CODE_PATTERN) ?? [];
  if (rightCodes.some((code) => leftCodes.has(code.toLowerCase()))) {
    return { score: 0.99, reason: "issue_code" };
  }
  return {
    score: jaccardSimilarity(
      tokenizeSimilarityText(leftNormalized),
      tokenizeSimilarityText(rightNormalized),
    ),
    reason: "title_token_jaccard",
  };
}
