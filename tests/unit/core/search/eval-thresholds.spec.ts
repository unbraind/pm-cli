import { describe, expect, it } from "vitest";
import { evaluateMetricFloors, parseEvalMetricFloors } from "../../../../src/core/search/eval-thresholds.js";

const metrics = { ndcg: 0.8, mrr: 1, precision: 0.2, recall: 0.4 };

describe("per-query retrieval floors", () => {
  it("checks each declared metric without rounding or imposing undeclared floors", () => {
    expect(evaluateMetricFloors(metrics, {})).toEqual([]);
    expect(evaluateMetricFloors(metrics, metrics)).toEqual([]);
    expect(evaluateMetricFloors(metrics, { recall: 0.40001 })).toEqual(["recall:0.4<0.40001"]);
    expect(evaluateMetricFloors({ ...metrics, ndcg: Number.NaN }, { ndcg: 0 })).toEqual(["ndcg:invalid"]);
    expect(evaluateMetricFloors({ ...metrics, recall: 2 }, { recall: 0 })).toEqual(["recall:invalid"]);
    expect(evaluateMetricFloors({ ...metrics, recall: -1 }, { recall: 0 })).toEqual(["recall:invalid"]);
  });

  it("rejects malformed declarations instead of silently removing a gate", () => {
    for (const value of [null, [], "0.5"]) {
      expect(() => parseEvalMetricFloors(value)).toThrow("must be an object");
    }
    expect(() => parseEvalMetricFloors({ ncdg: 0.5 })).toThrow("Unknown eval minimum metric");
    for (const recall of [null, "0.5", -1, 2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => parseEvalMetricFloors({ recall })).toThrow("finite number in [0, 1]");
    }
  });
});
