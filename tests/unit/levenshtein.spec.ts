import { describe, expect, it } from "vitest";
import { levenshteinDistanceWithinLimit } from "../../src/core/shared/levenshtein.js";

// pm-fl0c #6 (2026-05-28): the suggestion helpers in commander-usage.ts and
// bootstrap-args.ts cap the typo budget at distance 1 for short tokens. Before
// the upgrade to Optimal String Alignment Damerau-Levenshtein, a single
// adjacent transposition still scored as 2 (two substitutions), so the
// canonical "titel" -> "title" / "lst" -> "list" / "carete" -> "create"
// experiences were silently dropped from the suggestion list.

describe("levenshteinDistanceWithinLimit (OSA Damerau)", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshteinDistanceWithinLimit("abc", "abc", 0)).toBe(0);
  });

  it("counts a single adjacent transposition as 1 (pm-fl0c #6)", () => {
    // Only ADJACENT transpositions cost 1 in OSA Damerau — moving a letter
    // two positions still costs 2. We assert both real-world examples that
    // motivated the upgrade (commander-usage suggestNearestLongFlags fires
    // at maxDistance 1 for tokens shorter than 8 chars).
    expect(levenshteinDistanceWithinLimit("titel", "title", 1)).toBe(1);
    expect(levenshteinDistanceWithinLimit("title", "titel", 1)).toBe(1);
    expect(levenshteinDistanceWithinLimit("lst", "lts", 1)).toBe(1);
    expect(levenshteinDistanceWithinLimit("teh", "the", 1)).toBe(1);
  });

  it("counts insertions, deletions and substitutions as 1 each", () => {
    expect(levenshteinDistanceWithinLimit("kitten", "sitten", 1)).toBe(1);
    expect(levenshteinDistanceWithinLimit("abc", "abcd", 1)).toBe(1);
    expect(levenshteinDistanceWithinLimit("abcd", "abc", 1)).toBe(1);
  });

  it("returns null when even the rolling-row minimum exceeds the budget", () => {
    expect(levenshteinDistanceWithinLimit("title", "completely-different", 2)).toBeNull();
    expect(levenshteinDistanceWithinLimit("titel", "completely-different", 1)).toBeNull();
  });

  it("returns null when the rolling minimum stays in-budget but the final cell still exceeds the limit", () => {
    // "abcd" vs "abcyy" with limit 1: the leading "abc" forces rowMins {0,0,0,1}
    // (each row's diagonal cell stays at the prefix-match length), so the
    // rowMin > limit short-circuit never fires; the bottom-right cell still
    // finishes at 3 (replace d→y plus insert y), so the post-loop guard at
    // the final return must reject it.
    expect(levenshteinDistanceWithinLimit("abcd", "abcyy", 1)).toBeNull();
  });

  it("short-circuits on a length delta larger than the limit", () => {
    expect(levenshteinDistanceWithinLimit("a", "abcdef", 2)).toBeNull();
  });

  it("does not count a non-adjacent transposition as 1", () => {
    // "abxcd" -> "cbxad" reorders the first and last letters — not adjacent —
    // so OSA Damerau scores it like plain Levenshtein (two substitutions).
    expect(levenshteinDistanceWithinLimit("abxcd", "cbxad", 1)).toBeNull();
  });
});
