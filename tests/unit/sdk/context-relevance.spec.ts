import { afterEach, describe, expect, it } from "vitest";
import {
  CONTEXT_RELEVANCE_SIGNAL_NAMES,
  defaultScoreContextCandidates,
  evaluateContextRanking,
  runContextEvaluationCorpus,
  runContextEvaluationScenario,
  scoreContextCandidates,
  scoreContextCandidatesWithActiveExtensions,
  summarizeContextEvaluationReports,
  type ContextRelevanceCandidate,
  type ExtensionServiceRegistry,
} from "../../../src/sdk/index.js";
import { clearActiveExtensionHooks, setActiveExtensionServices } from "../../../src/core/extensions/index.js";

type TestItem = { title: string };

function candidate(
  id: string,
  title: string,
  signals: ContextRelevanceCandidate<TestItem>["signals"] = {},
): ContextRelevanceCandidate<TestItem> {
  return { id, item: { title }, signals };
}

describe("context relevance SDK primitives", () => {
  afterEach(() => {
    clearActiveExtensionHooks();
  });

  it("preserves baseline ordering when advanced signals are absent", () => {
    const report = defaultScoreContextCandidates([
      { id: "pm-b", item: { title: "first" } },
      candidate("pm-a", "second"),
      candidate("pm-c", "third"),
    ]);

    expect(report.ranked.map((entry) => entry.id)).toEqual(["pm-b", "pm-a", "pm-c"]);
    expect(report.ranked.map((entry) => entry.rank)).toEqual([1, 2, 3]);
    expect(report.available_signals).toEqual(["structural"]);
    expect(defaultScoreContextCandidates([candidate("pm-only", "only")]).ranked[0]?.score).toBe(1);
    expect(defaultScoreContextCandidates([candidate("pm-zero", "zero")], { weights: { structural: 0 } }).ranked[0]?.score).toBe(0);
    expect(defaultScoreContextCandidates([
      candidate("pm-a", "first"),
      candidate("pm-b", "second"),
    ], { weights: { structural: 0 } }).ranked.map((entry) => entry.id)).toEqual(["pm-a", "pm-b"]);
  });

  it("validates candidate identity, signal values, and weights", () => {
    expect(() => defaultScoreContextCandidates([candidate("", "blank")])).toThrow("unique non-empty ids");
    expect(() => defaultScoreContextCandidates([candidate("pm-a", "first"), candidate("pm-a", "duplicate")])).toThrow("unique non-empty ids");
    expect(() => defaultScoreContextCandidates([
      { ...candidate("pm-a", "unknown"), signals: { unknown: 1 } as never },
    ])).toThrow("Unknown context relevance signal");
    expect(() => defaultScoreContextCandidates([candidate("pm-a", "invalid", { recency: Number.NaN })])).toThrow("finite number from 0 to 1");
    expect(() => defaultScoreContextCandidates([candidate("pm-a", "invalid", { recency: -0.1 })])).toThrow("finite number from 0 to 1");
    expect(() => defaultScoreContextCandidates([candidate("pm-a", "invalid", { recency: 1.1 })])).toThrow("finite number from 0 to 1");
    expect(() => defaultScoreContextCandidates([candidate("pm-a", "invalid")], { weights: { recency: -1 } })).toThrow("finite non-negative number");
  });

  it("combines available signal families with explainable contributions", () => {
    const report = defaultScoreContextCandidates([
      candidate("pm-old", "baseline leader", { recency: 0, semantic_similarity: 0 }),
      candidate("pm-relevant", "semantic match", { recency: 1, semantic_similarity: 1 }),
    ]);

    expect(report.ranked[0]?.id).toBe("pm-relevant");
    expect(report.available_signals).toEqual(["structural", "recency", "semantic_similarity"]);
    expect(report.ranked[0]?.contributions.semantic_similarity).toBeGreaterThan(0);
    expect(CONTEXT_RELEVANCE_SIGNAL_NAMES).toContain("knowledge_density");
    expect(report.ranked.find((entry) => entry.id === "pm-old")?.contributions).toHaveProperty("recency");
    const sparse = defaultScoreContextCandidates([
      candidate("pm-sparse", "sparse"),
      candidate("pm-signaled", "signaled", { risk_pressure: 1 }),
    ]);
    expect(sparse.ranked.find((entry) => entry.id === "pm-sparse")?.contributions.risk_pressure).toBeUndefined();
  });

  it("lets SDK consumers wrap the deterministic default scorer", async () => {
    const report = await scoreContextCandidates(
      [candidate("pm-a", "alpha"), candidate("pm-b", "beta")],
      {
        scorer(input) {
          return input.default_report.ranked.map((entry) => ({
            id: entry.id,
            score: entry.id === "pm-b" ? entry.score + 10 : entry.score,
          }));
        },
      },
    );

    expect(report.model).toBe("custom");
    expect(report.ranked.map((entry) => entry.id)).toEqual(["pm-b", "pm-a"]);
    expect(report.ranked[0]?.contributions).toEqual({ custom: report.ranked[0]?.score });
    expect((await scoreContextCandidates(
      [candidate("pm-a", "alpha"), candidate("pm-b", "beta")],
      { scorer: ({ candidates }) => candidates.map((entry) => ({ id: entry.id, score: 1 })) },
    )).ranked.map((entry) => entry.id)).toEqual(["pm-a", "pm-b"]);
  });

  it("rejects malformed custom scorer output", async () => {
    await expect(
      scoreContextCandidates([candidate("pm-a", "alpha")], {
        scorer: () => [{ id: "pm-missing", score: Number.NaN }],
      }),
    ).rejects.toThrow("Context relevance scorer must return one finite score for every candidate");
    await expect(scoreContextCandidates(
      [candidate("pm-a", "alpha"), candidate("pm-b", "beta")],
      { scorer: () => [{ id: "pm-a", score: 1 }] },
    )).rejects.toThrow("one finite score for every candidate");
    await expect(scoreContextCandidates(
      [candidate("pm-a", "alpha"), candidate("pm-b", "beta")],
      { scorer: () => [{ id: "pm-a", score: 1 }, { id: "pm-a", score: 2 }] },
    )).rejects.toThrow("one finite score for every candidate");
    await expect(scoreContextCandidates([candidate("pm-a", "alpha")])).resolves.toMatchObject({ model: "default-weighted-v1" });
    const extensionFree = await scoreContextCandidatesWithActiveExtensions("context", [candidate("pm-a", "alpha")]);
    expect(extensionFree.model).toBe("default-weighted-v1");
    expect(extensionFree.warnings).toBeUndefined();
  });

  it("routes command scoring through the governed extension service", async () => {
    const services: ExtensionServiceRegistry = {
      overrides: [
        {
          layer: "project",
          name: "relevance-test",
          service: "context_relevance",
          run(context) {
            const payload = context.payload as { candidates: Array<{ id: string }> };
            return payload.candidates.map((entry) => ({ id: entry.id, score: entry.id === "pm-b" ? 5 : 1 }));
          },
        },
      ],
    };
    setActiveExtensionServices(services);

    const report = await scoreContextCandidatesWithActiveExtensions(
      "context",
      [candidate("pm-a", "alpha"), candidate("pm-b", "beta")],
    );

    expect(report.model).toBe("custom");
    expect(report.ranked.map((entry) => entry.id)).toEqual(["pm-b", "pm-a"]);
  });

  it("preserves extension warnings and falls back from invalid results", async () => {
    const validOverride = {
      layer: "project" as const,
      name: "valid-after-warning",
      service: "context_relevance" as const,
      run: () => [{ id: "pm-a", score: 2 }],
    };
    setActiveExtensionServices({
      overrides: [
        validOverride,
        {
          layer: "project",
          name: "throwing-first",
          service: "context_relevance",
          run() {
            throw new Error("expected test failure");
          },
        },
      ],
    });
    await expect(scoreContextCandidatesWithActiveExtensions("next", [candidate("pm-a", "alpha")])).resolves.toMatchObject({
      model: "custom",
      warnings: ["extension_service_override_failed:project:throwing-first:context_relevance"],
    });

    setActiveExtensionServices({ overrides: [{ ...validOverride, name: "invalid-shape", run: () => ({ score: 1 }) }] });
    await expect(scoreContextCandidatesWithActiveExtensions("context", [candidate("pm-a", "alpha")])).resolves.toMatchObject({
      model: "default-weighted-v1",
      warnings: ["extension_context_relevance_invalid_result"],
    });

    setActiveExtensionServices({ overrides: [{ ...validOverride, name: "invalid-score", run: () => [{ id: "pm-a", score: Number.NaN }] }] });
    await expect(scoreContextCandidatesWithActiveExtensions("context", [candidate("pm-a", "alpha")])).resolves.toMatchObject({
      model: "default-weighted-v1",
      warnings: ["extension_context_relevance_invalid_result"],
    });

    setActiveExtensionServices({
      overrides: [{ ...validOverride, name: "invalid-members", run: () => [{ id: "pm-a", score: 1 }, { id: "pm-a", score: 2 }] }],
    });
    await expect(scoreContextCandidatesWithActiveExtensions("context", [candidate("pm-a", "alpha")])).resolves.toMatchObject({
      model: "default-weighted-v1",
      warnings: ["extension_context_relevance_invalid_result"],
    });

    setActiveExtensionServices({
      overrides: [{ ...validOverride, name: "only-failure", run: () => { throw new Error("expected test failure"); } }],
    });
    await expect(scoreContextCandidatesWithActiveExtensions("context", [candidate("pm-a", "alpha")])).resolves.toMatchObject({
      model: "default-weighted-v1",
      warnings: ["extension_service_override_failed:project:only-failure:context_relevance"],
    });
  });

  it("reports ranking quality and token-budget adherence", () => {
    expect(
      evaluateContextRanking({
        ranked_ids: ["pm-a", "pm-b", "pm-c"],
        judgments: { "pm-a": 3, "pm-b": 1, "pm-c": 0 },
        required_ids: ["pm-a", "pm-d"],
        continuity_ids: ["pm-a", "pm-c"],
        actual_tokens: 96,
        token_budget: 100,
      }),
    ).toMatchObject({
      ndcg: 1,
      reciprocal_rank: 1,
      required_recall: 0.5,
      continuity_coverage: 1,
      token_budget_adherence: 1,
      within_token_budget: true,
    });
    expect(evaluateContextRanking({
      ranked_ids: ["pm-missing"],
      judgments: {},
      actual_tokens: 200,
      token_budget: 100,
    })).toMatchObject({
      ndcg: 1,
      reciprocal_rank: 0,
      token_budget_adherence: 0.5,
      within_token_budget: false,
    });
    expect(evaluateContextRanking({
      ranked_ids: [],
      judgments: { "pm-positive": 3 },
      actual_tokens: 0,
      token_budget: 100,
    }).ndcg).toBe(0);
    expect(() => evaluateContextRanking({
      ranked_ids: [],
      judgments: {},
      actual_tokens: -1,
      token_budget: 0,
    })).toThrow("token counts");
  });

  it("runs context and next judgments through the public read contract", async () => {
    const ranking = {
      model: "test",
      available_signals: ["structural"] as const,
      items: [
        { id: "pm-a", rank: 1, baseline_rank: 1, score: 1, contributions: { structural: 1 } },
        { id: "pm-b", rank: 2, baseline_rank: 2, score: 0.5, contributions: { structural: 0.5 } },
      ],
    };
    const focus = (id: string) => ({ id }) as never;
    const reader = {
      context: async () => ({ high_level: [], low_level: [focus("pm-a"), focus("pm-b")], blocked_fallback: [], ranking }) as never,
      next: async () => ({ ready: [focus("pm-b"), focus("pm-a")], ranking }) as never,
    };
    const scenarios = [
      {
        id: "context-case",
        surface: "context" as const,
        judgments: { "pm-a": 3, "pm-b": 1 },
        required_ids: ["pm-a"],
        token_budget: 100,
        rationale: "Context should lead with the active anchor.",
      },
      {
        id: "next-case",
        surface: "next" as const,
        judgments: { "pm-b": 3, "pm-a": 1 },
        continuity_ids: ["pm-a"],
        token_budget: 100,
        rationale: "Next should preserve the returning-agent handoff.",
      },
    ];

    const report = await runContextEvaluationCorpus(scenarios, reader, {
      ndcg: 1,
      reciprocal_rank: 1,
      required_recall: 1,
      continuity_coverage: 1,
      token_budget_adherence: 1,
    });

    expect(report.passed).toBe(true);
    expect(report.scenario_count).toBe(2);
    expect(report.scenarios[0]?.attribution[0]).toEqual({ id: "pm-a", contributions: { structural: 1 } });
    expect(report.scenarios[1]?.ranked_ids).toEqual(["pm-b", "pm-a"]);

    const noAttribution = await runContextEvaluationScenario({
      id: "no-attribution",
      surface: "context",
      judgments: {},
      token_budget: 100,
      rationale: "A reader may omit optional ranking metadata.",
    }, {
      context: async () => ({ high_level: [], low_level: [], blocked_fallback: [] }) as never,
      next: async () => ({ ready: [] }) as never,
    });
    expect(noAttribution.attribution).toEqual([]);
    const sparseResult = await runContextEvaluationScenario({
      id: "sparse-result",
      surface: "context",
      judgments: {},
      token_budget: 100,
      rationale: "Runtime readers may omit arrays despite their static contract.",
    }, {
      context: async () => ({}) as never,
      next: async () => ({}) as never,
    });
    expect(sparseResult.ranked_ids).toEqual([]);
    const sparseNext = await runContextEvaluationScenario({
      id: "sparse-next",
      surface: "next",
      judgments: {},
      token_budget: 100,
      rationale: "Runtime next readers may omit ready arrays.",
    }, {
      context: async () => ({}) as never,
      next: async () => ({}) as never,
    });
    expect(sparseNext.ranked_ids).toEqual([]);
  });

  it("reports aggregate threshold failures and validates scenario/corpus metadata", async () => {
    const reader = {
      context: async () => ({ high_level: [], low_level: [], blocked_fallback: [], ranking: { items: [] } }) as never,
      next: async () => ({ ready: [], ranking: { items: [] } }) as never,
    };
    await expect(
      runContextEvaluationScenario(
        { id: "", surface: "context", judgments: {}, token_budget: 1, rationale: "" },
        reader,
      ),
    ).rejects.toThrow("non-empty id and rationale");
    expect(() => summarizeContextEvaluationReports([], {
      ndcg: 1,
      reciprocal_rank: 1,
      required_recall: 1,
      continuity_coverage: 1,
      token_budget_adherence: 1,
    })).toThrow("at least one scenario");

    const report = summarizeContextEvaluationReports([
      {
        id: "weak",
        surface: "context",
        rationale: "Regression fixture",
        ranked_ids: [],
        actual_tokens: 2,
        attribution: [],
        metrics: {
          ndcg: 0.5,
          reciprocal_rank: 0,
          required_recall: 1,
          continuity_coverage: 1,
          token_budget_adherence: 0.5,
          within_token_budget: false,
        },
      },
    ], {
      ndcg: 0.8,
      reciprocal_rank: 0.5,
      required_recall: 1,
      continuity_coverage: 1,
      token_budget_adherence: 0.9,
    });
    expect(report.passed).toBe(false);
    expect(report.failures).toEqual(["ndcg:0.5<0.8", "reciprocal_rank:0<0.5", "token_budget_adherence:0.5<0.9"]);
  });
});
