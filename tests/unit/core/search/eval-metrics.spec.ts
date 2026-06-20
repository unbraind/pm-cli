import { describe, expect, it } from "vitest";
import {
  aggregateEvalMetrics,
  DEFAULT_EVAL_K,
  dcgAtK,
  EvalQuerySetError,
  evaluateRanking,
  ndcgAtK,
  parseEvalQuerySet,
  precisionAtK,
  recallAtK,
  reciprocalRankAtK,
} from "../../../../src/core/search/eval.js";

describe("eval dcgAtK", () => {
  it("discounts later positions and caps at k", () => {
    // gains [1,1]: 1/log2(2) + 1/log2(3) = 1 + 0.63093 = 1.63093
    expect(dcgAtK([1, 1], 10)).toBeCloseTo(1.630929, 5);
    // cutoff drops the third gain
    expect(dcgAtK([1, 0, 1], 2)).toBeCloseTo(1, 5);
  });

  it("returns 0 with a non-positive cutoff", () => {
    expect(dcgAtK([1, 1], 0)).toBe(0);
  });
});

describe("eval ndcgAtK", () => {
  it("returns 0 when there are no relevant ids", () => {
    expect(ndcgAtK(["a", "b"], new Set(), 10)).toBe(0);
  });

  it("scores a perfect ranking as 1 and a partial ranking below 1", () => {
    expect(ndcgAtK(["a", "b"], new Set(["a", "b"]), 10)).toBeCloseTo(1, 12);
    const partial = ndcgAtK(["x", "a", "b"], new Set(["a", "b"]), 10);
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(1);
  });

  it("returns 0 when the ideal DCG is 0 (cutoff 0)", () => {
    expect(ndcgAtK(["a"], new Set(["a"]), 0)).toBe(0);
  });
});

describe("eval reciprocalRankAtK", () => {
  it("returns the reciprocal of the first relevant rank within the cutoff", () => {
    expect(reciprocalRankAtK(["x", "a", "b"], new Set(["a"]), 10)).toBeCloseTo(1 / 2, 12);
    expect(reciprocalRankAtK(["a"], new Set(["a"]), 10)).toBe(1);
  });

  it("returns 0 when no relevant id appears within the cutoff", () => {
    expect(reciprocalRankAtK(["x", "a"], new Set(["a"]), 1)).toBe(0);
    expect(reciprocalRankAtK(["x", "y"], new Set(["a"]), 10)).toBe(0);
  });
});

describe("eval precisionAtK / recallAtK", () => {
  it("computes precision over the cutoff and recall over the relevant set", () => {
    expect(precisionAtK(["a", "x", "b"], new Set(["a", "b"]), 2)).toBeCloseTo(0.5, 12);
    expect(recallAtK(["a", "x", "b"], new Set(["a", "b", "c"]), 3)).toBeCloseTo(2 / 3, 12);
  });

  it("returns 0 for a non-positive cutoff or an empty relevant set", () => {
    expect(precisionAtK(["a"], new Set(["a"]), 0)).toBe(0);
    expect(recallAtK(["a"], new Set(), 10)).toBe(0);
  });
});

describe("eval evaluateRanking", () => {
  it("returns all four metrics plus match counts together", () => {
    const metrics = evaluateRanking(["a", "x", "b"], new Set(["a", "b"]), 10);
    expect(metrics.ndcg).toBeGreaterThan(0);
    expect(metrics.mrr).toBe(1);
    expect(metrics.relevant_total).toBe(2);
    expect(metrics.retrieved_relevant).toBe(2);
  });
});

describe("eval aggregateEvalMetrics", () => {
  it("returns zeros with query_count 0 for an empty input", () => {
    expect(aggregateEvalMetrics([])).toEqual({ ndcg: 0, mrr: 0, precision: 0, recall: 0, query_count: 0 });
  });

  it("macro-averages per-query metrics", () => {
    const aggregate = aggregateEvalMetrics([
      { ndcg: 1, mrr: 1, precision: 0.5, recall: 1, relevant_total: 1, retrieved_relevant: 1 },
      { ndcg: 0, mrr: 0, precision: 0, recall: 0, relevant_total: 1, retrieved_relevant: 0 },
    ]);
    expect(aggregate).toEqual({ ndcg: 0.5, mrr: 0.5, precision: 0.25, recall: 0.5, query_count: 2 });
  });
});

describe("eval parseEvalQuerySet", () => {
  it("accepts a bare array and trims/de-duplicates relevant ids", () => {
    const parsed = parseEvalQuerySet([
      { query: "  offline search  ", relevant_ids: [" pm-75k9 ", "pm-75k9", ""], description: "  intent  " },
    ]);
    expect(parsed.queries).toEqual([
      { query: "offline search", relevant_ids: ["pm-75k9"], description: "intent" },
    ]);
  });

  it("accepts an object with a queries array and a per-query mode", () => {
    const parsed = parseEvalQuerySet({ queries: [{ query: "x", relevant_ids: ["pm-1"], mode: "hybrid" }] });
    expect(parsed.queries[0].mode).toBe("hybrid");
  });

  it("omits an empty/whitespace description", () => {
    const parsed = parseEvalQuerySet([{ query: "x", relevant_ids: ["pm-1"], description: "   " }]);
    expect(parsed.queries[0]).not.toHaveProperty("description");
  });

  it("rejects non-array / non-object / null payloads", () => {
    expect(() => parseEvalQuerySet(42)).toThrow(EvalQuerySetError);
    expect(() => parseEvalQuerySet(null)).toThrow(/array of queries/);
    expect(() => parseEvalQuerySet({ nope: true })).toThrow(/queries/);
  });

  it("rejects an empty query set", () => {
    expect(() => parseEvalQuerySet([])).toThrow(/at least one query/);
  });

  it("rejects a non-object entry", () => {
    expect(() => parseEvalQuerySet([null])).toThrow(/index 0 must be an object/);
  });

  it("rejects a missing/empty/non-string query", () => {
    expect(() => parseEvalQuerySet([{ query: "  ", relevant_ids: ["pm-1"] }])).toThrow(/non-empty "query"/);
    expect(() => parseEvalQuerySet([{ relevant_ids: ["pm-1"] }])).toThrow(/non-empty "query"/);
  });

  it("rejects a missing relevant_ids array", () => {
    expect(() => parseEvalQuerySet([{ query: "x" }])).toThrow(/"relevant_ids" array/);
  });

  it("rejects an empty relevant_ids list (after trimming)", () => {
    expect(() => parseEvalQuerySet([{ query: "x", relevant_ids: ["", "  "] }])).toThrow(/at least one relevant id/);
  });

  it("rejects a relevant_ids array containing a non-string entry", () => {
    expect(() => parseEvalQuerySet([{ query: "x", relevant_ids: ["pm-1", 7] }])).toThrow(/array of strings/);
  });

  it("rejects an invalid mode", () => {
    expect(() => parseEvalQuerySet([{ query: "x", relevant_ids: ["pm-1"], mode: "fuzzy" }])).toThrow(/invalid mode/);
    expect(() => parseEvalQuerySet([{ query: "x", relevant_ids: ["pm-1"], mode: 7 }])).toThrow(/invalid mode/);
  });

  it("exposes DEFAULT_EVAL_K as 10", () => {
    expect(DEFAULT_EVAL_K).toBe(10);
  });
});
