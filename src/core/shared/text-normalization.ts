export function normalizeLowercaseWhitespace(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function tokenizeAlphaNumeric(value: string): string[] {
  return normalizeLowercaseWhitespace(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

export function uniqueTokens(value: string): string[] {
  return [...new Set(tokenizeAlphaNumeric(value))];
}

export function jaccardSimilarity(leftTokens: string[], rightTokens: string[]): number {
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
  const union = new Set([...leftSet, ...rightSet]).size;
  return union === 0 ? 0 : intersection / union;
}
