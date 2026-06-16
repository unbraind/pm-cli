import { describe, expect, it } from "vitest";

import { jaccardSimilarity } from "../../../../src/core/shared/text-normalization.js";

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
