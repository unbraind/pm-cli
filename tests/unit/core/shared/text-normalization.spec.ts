import { describe, expect, it } from "vitest";

import {
  COMPACTED_STRING_LENGTH,
  compactExplanatoryString,
  isCompactedCursorArgument,
  isContinuationTokenKey,
  jaccardSimilarity,
  readCompactionMarker,
} from "../../../../src/core/shared/text-normalization.js";

describe("text-normalization.jaccardSimilarity", () => {
  it("returns 1 for two empty token lists and 0 when only one is empty", () => {
    expect(jaccardSimilarity([], [])).toBe(1);
    expect(jaccardSimilarity(["a"], [])).toBe(0);
    expect(jaccardSimilarity([], ["a"])).toBe(0);
  });

  it("computes the ratio of shared to total distinct tokens", () => {
    expect(jaccardSimilarity(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3, 5);
    expect(jaccardSimilarity(["a", "a"], ["a"])).toBe(1);
  });
});

describe("read-output compaction marker and continuation tokens (pm-n98pir, GH-1710)", () => {
  it("keeps short strings, and ends a compacted string with the omitted code-unit count", () => {
    expect(compactExplanatoryString("a".repeat(COMPACTED_STRING_LENGTH))).toBe("a".repeat(COMPACTED_STRING_LENGTH));
    const compacted = compactExplanatoryString("a".repeat(1000));
    expect(compacted).toBe(`${"a".repeat(240)}…[+760 chars]`);
    expect(readCompactionMarker(compacted)).toBe(760);
    // A surrogate pair at the cutoff moves to the omitted side, and the count says so.
    const astral = compactExplanatoryString(`${"a".repeat(239)}😀${"z".repeat(10)}`);
    expect(astral).toBe(`${"a".repeat(239)}…[+12 chars]`);
    expect(readCompactionMarker(astral)).toBe(12);
  });

  it("recognises only a trailing marker, tolerating trailing whitespace", () => {
    expect(readCompactionMarker("text…[+5 chars]\n")).toBe(5);
    expect(readCompactionMarker("a genuine ellipsis…")).toBeUndefined();
    expect(readCompactionMarker("quoted …[+5 chars] mid-text")).toBeUndefined();
    expect(readCompactionMarker("text…[+0 chars]")).toBeUndefined();
    expect(readCompactionMarker("text…[+05 chars]")).toBeUndefined();
    expect(readCompactionMarker("text...[+5 chars]")).toBeUndefined();
  });

  it("names continuation-token keys and detects a cursor argument a compacted read shortened", () => {
    for (const key of ["cursor", "next_cursor", "output_cursor", "source_cursor", "base_source_cursor"]) {
      expect(isContinuationTokenKey(key)).toBe(true);
    }
    for (const key of ["cursor_semantics", "cursors", "title", "precursor"]) expect(isContinuationTokenKey(key)).toBe(false);
    expect(isCompactedCursorArgument("eyJ2…")).toBe(true);
    expect(isCompactedCursorArgument("eyJ2ZXJzaW9uIjox")).toBe(false);
  });
});
