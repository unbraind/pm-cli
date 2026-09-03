import { describe, expect, it } from "vitest";
import {
  PM_EPISODE_SCHEMA,
  PM_OBSERVATION_SCHEMA,
  PM_VERDICT_SCHEMA,
  defineEpisodeSpecification,
  defineObservationContract,
  defineVerdictContract,
  describeObservationCost,
  evaluateVerdictContract,
  openPmEpisode,
  serveDeclaredObservation,
  type EpisodeRuntimeAdapter,
  type EpisodeSpecification,
  type ObservationContract,
  type VerdictContract,
  type WorkspaceRecordedState,
} from "../../../../src/sdk/environment/agent-environment.js";
import { PM_WORKSPACE_RECIPE_SCHEMA } from "../../../../src/sdk/workspace-recipe.js";

const observation = {
  schema: PM_OBSERVATION_SCHEMA,
  id: "task-state",
  version: 1,
  reads: [
    { command: "get", budget_tokens: 160 },
    { command: "history", budget_tokens: 96 },
  ],
  calibration: {
    basis: "emitted_bytes" as const,
    samples: [160, 192, 224],
    expected_emitted_bytes: 192,
    tolerance_bytes: 32,
  },
  corpus_dependence: { kind: "independent" as const },
  tiers: [
    {
      id: "standard",
      max_tokens: 256,
      fields: ["item.id", "item.title", "item.status", "item.resolution"],
    },
    { id: "compact", max_tokens: 96, fields: ["item.id", "item.status"] },
    { id: "identity", max_tokens: 32, fields: ["item.id"] },
  ],
};

const verdict = {
  schema: PM_VERDICT_SCHEMA,
  id: "task-complete",
  version: 1,
  predicates: [
    {
      id: "closed",
      kind: "field_equals" as const,
      path: "item.status",
      expected: "closed",
    },
    {
      id: "resolution",
      kind: "field_present" as const,
      path: "item.resolution",
    },
  ],
  composition: {
    operator: "all" as const,
    predicate_ids: ["closed", "resolution"],
  },
};

const episodeSpecification: EpisodeSpecification = {
  schema: PM_EPISODE_SCHEMA,
  id: "sdk-environment-example",
  version: 1,
  mode: "evaluation",
  recipe: {
    schema: PM_WORKSPACE_RECIPE_SCHEMA,
    seed: "sdk-environment-example",
    clock: "2026-09-03T00:00:00.000Z",
    tickMs: 1,
    operations: [],
  },
  task_item_ids: ["pm-task"],
  observable_fields: [
    "item.id",
    "item.title",
    "item.status",
    "item.resolution",
  ],
  withheld_fields: ["grading.expected_status"],
  observation,
  verdict,
  limits: {
    max_actions: 2,
    max_observations: 4,
    max_tokens_per_observation: 256,
  },
};

class MemoryEpisodeAdapter implements EpisodeRuntimeAdapter<{
  status: string;
}> {
  private state: WorkspaceRecordedState = {
    snapshot_id: "snapshot:initial",
    state: {
      item: { id: "pm-task", title: "Complete me", status: "open" },
      grading: { expected_status: "closed" },
    },
  };

  async reset() {
    this.state = {
      snapshot_id: "snapshot:initial",
      state: {
        item: { id: "pm-task", title: "Complete me", status: "open" },
        grading: { expected_status: "closed" },
      },
    };
    return { workspace_id: "memory", state_id: this.state.snapshot_id };
  }

  async execute(action: { status: string }) {
    this.state = {
      snapshot_id: `snapshot:${action.status}`,
      state: {
        item: {
          id: "pm-task",
          title: "Complete me",
          status: action.status,
          ...(action.status === "closed" ? { resolution: "done" } : {}),
        },
        grading: { expected_status: "closed" },
      },
    };
    return { state_id: this.state.snapshot_id, output: { accepted: true } };
  }

  async readRecordedState() {
    return structuredClone(this.state);
  }
}

describe("agent-environment SDK contracts", () => {
  it("publishes guaranteed and calibrated observation cost before serving", () => {
    const contract = defineObservationContract(observation);

    expect(describeObservationCost(contract)).toEqual({
      contract_id: "task-state",
      contract_version: 1,
      guaranteed_ceiling_tokens: 256,
      expected_emitted_bytes: 192,
      expected_tokens: 48,
      tolerance_bytes: 32,
      calibration_basis: "emitted_bytes",
      corpus_dependence: { kind: "independent" },
    });
    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(contract.tiers)).toBe(true);
  });

  it("degrades deterministically and reports the served tier from emitted bytes", async () => {
    const attempts: string[] = [];
    const result = await serveDeclaredObservation(
      defineObservationContract(observation),
      async (tier) => {
        attempts.push(tier.id);
        return tier.id === "standard"
          ? { rows: Array.from({ length: 200 }, (_, index) => `row-${index}`) }
          : { id: "pm-task" };
      },
      { budget_tokens: 96 },
    );

    expect(attempts).toEqual(["standard", "compact"]);
    expect(result.status).toBe("served");
    expect(result.receipt.served_tier).toBe("compact");
    expect(result.receipt.degraded).toBe(true);
    expect(result.receipt.emitted_bytes).toBeGreaterThan(0);
    expect(result.receipt.estimated_tokens).toBeLessThanOrEqual(96);
    expect(result.receipt.calibration_basis).toBe("emitted_bytes");
  });

  it("serves the first tier without degradation and describes bounded corpora", async () => {
    const bounded = defineObservationContract({
      ...observation,
      corpus_dependence: {
        kind: "bounded",
        dimension: "items",
        maximum: 10,
      },
    });
    const result = await serveDeclaredObservation(
      bounded,
      async () => ({ id: "pm-task" }),
      { budget_tokens: 256 },
    );

    expect(describeObservationCost(bounded).corpus_dependence).toEqual({
      kind: "bounded",
      dimension: "items",
      maximum: 10,
    });
    expect(result).toMatchObject({
      status: "served",
      receipt: { served_tier: "standard", degraded: false },
    });
  });

  it("refuses truthfully when no declared tier fits", async () => {
    const result = await serveDeclaredObservation(
      defineObservationContract(observation),
      async () => ({ payload: "x".repeat(10_000) }),
      { budget_tokens: 32 },
    );

    expect(result).toMatchObject({
      status: "refused",
      receipt: {
        served_tier: null,
        degraded: true,
        attempted_tiers: ["standard", "compact", "identity"],
      },
    });
    expect("payload" in result).toBe(false);

    const session = await openPmEpisode(
      defineEpisodeSpecification({
        ...episodeSpecification,
        limits: {
          ...episodeSpecification.limits,
          max_tokens_per_observation: 1,
        },
      }),
      new MemoryEpisodeAdapter(),
    );
    expect((await session.observe()).status).toBe("refused");
  });

  it("computes reproducible total verdicts without mutating recorded state", () => {
    const contract = defineVerdictContract(verdict);
    const recorded: WorkspaceRecordedState = {
      snapshot_id: "snapshot:closed",
      state: { item: { status: "closed", resolution: "done" } },
    };
    const before = structuredClone(recorded);
    const first = evaluateVerdictContract(contract, recorded);
    const second = evaluateVerdictContract(contract, recorded);

    expect(first).toEqual(second);
    expect(first.outcome).toBe("satisfied");
    expect(first.score).toBe(1);
    expect(first.policy).toBe("verdict_only_no_reward");
    expect(
      first.predicates.every((entry) =>
        entry.evidence_pointer.startsWith("snapshot:closed#"),
      ),
    ).toBe(true);
    expect(recorded).toEqual(before);
  });

  it("returns explicit violated and not-applicable verdicts", () => {
    const violated = evaluateVerdictContract(defineVerdictContract(verdict), {
      snapshot_id: "snapshot:open",
      state: { item: { status: "open" } },
    });
    const empty = evaluateVerdictContract(
      defineVerdictContract({
        schema: PM_VERDICT_SCHEMA,
        id: "nothing-checkable",
        version: 1,
        predicates: [],
        composition: { operator: "all", predicate_ids: [] },
      }),
      { snapshot_id: "snapshot:empty", state: {} },
    );

    expect(violated.outcome).toBe("violated");
    expect(violated.score).toBe(0);
    expect(empty).toMatchObject({
      outcome: "not_applicable",
      reason: "no_predicates_declared",
      score: null,
      predicates: [],
    });
  });

  it("supports any composition, absence checks, and escaped evidence pointers", () => {
    const result = evaluateVerdictContract(
      defineVerdictContract({
        schema: PM_VERDICT_SCHEMA,
        id: "alternative-completion",
        version: 1,
        predicates: [
          { id: "missing", kind: "field_absent", path: "item.blocker" },
          {
            id: "mismatch",
            kind: "field_equals",
            path: "item.a~/b",
            expected: "different",
          },
        ],
        composition: {
          operator: "any",
          predicate_ids: ["missing", "mismatch"],
        },
      }),
      {
        snapshot_id: "snapshot:any",
        state: { item: { "a~/b": "value" } },
      },
    );

    expect(result.outcome).toBe("satisfied");
    expect(result.score).toBe(0.5);
    expect(result.predicates[1]?.evidence_pointer).toBe(
      "snapshot:any#/item/a~0~1b",
    );
  });

  it("fails closed on malformed observation declarations", async () => {
    const cases: ObservationContract[] = [
      { ...observation, schema: "wrong" as typeof PM_OBSERVATION_SCHEMA },
      { ...observation, id: " " },
      { ...observation, version: 0 },
      { ...observation, reads: [] },
      { ...observation, reads: [{ command: "", budget_tokens: 1 }] },
      { ...observation, reads: [{ command: "get", budget_tokens: 0 }] },
      {
        ...observation,
        reads: [
          { command: "get", budget_tokens: Number.MAX_SAFE_INTEGER },
          { command: "get", budget_tokens: 1 },
        ],
      },
      {
        ...observation,
        calibration: {
          ...observation.calibration,
          basis: "tokens" as "emitted_bytes",
        },
      },
      {
        ...observation,
        calibration: { ...observation.calibration, samples: [-1] },
      },
      {
        ...observation,
        calibration: { ...observation.calibration, samples: [] },
      },
      {
        ...observation,
        calibration: { ...observation.calibration, expected_emitted_bytes: 0 },
      },
      {
        ...observation,
        calibration: { ...observation.calibration, tolerance_bytes: -1 },
      },
      {
        ...observation,
        calibration: {
          ...observation.calibration,
          expected_emitted_bytes: 500,
          tolerance_bytes: 1,
        },
      },
      {
        ...observation,
        corpus_dependence: { kind: "bounded", dimension: "", maximum: 1 },
      },
      {
        ...observation,
        corpus_dependence: { kind: "bounded", dimension: "items", maximum: 0 },
      },
      { ...observation, tiers: [] },
      { ...observation, tiers: [{ id: "", max_tokens: 1, fields: [] }] },
      { ...observation, tiers: [{ id: "tiny", max_tokens: 0, fields: [] }] },
      {
        ...observation,
        tiers: [
          { id: "same", max_tokens: 2, fields: [] },
          { id: "same", max_tokens: 1, fields: [] },
        ],
      },
      {
        ...observation,
        tiers: [
          { id: "small", max_tokens: 1, fields: [] },
          { id: "large", max_tokens: 2, fields: [] },
        ],
      },
      {
        ...observation,
        tiers: [
          { id: "unsafe", max_tokens: 1, fields: ["__proto__.polluted"] },
        ],
      },
      {
        ...observation,
        tiers: [
          { id: "duplicate", max_tokens: 1, fields: ["item.id", "item.id"] },
        ],
      },
    ];

    for (const declaration of cases) {
      expect(() => defineObservationContract(declaration)).toThrow();
    }
    await expect(
      serveDeclaredObservation(
        defineObservationContract(observation),
        async () => ({}),
        { budget_tokens: 0 },
      ),
    ).rejects.toThrow(/positive safe integer/u);
  });

  it("fails closed on malformed verdict declarations", () => {
    const cyclicExpected: Record<string, unknown> = {};
    cyclicExpected.self = cyclicExpected;
    const cases: VerdictContract[] = [
      { ...verdict, schema: "wrong" as typeof PM_VERDICT_SCHEMA },
      { ...verdict, id: "" },
      { ...verdict, version: 0 },
      {
        ...verdict,
        predicates: [{ id: "", kind: "field_present", path: "item.id" }],
        composition: { operator: "all", predicate_ids: [""] },
      },
      {
        ...verdict,
        predicates: [{ id: "unsafe", kind: "field_present", path: "item..id" }],
        composition: { operator: "all", predicate_ids: ["unsafe"] },
      },
      {
        ...verdict,
        predicates: [
          { id: "same", kind: "field_present", path: "item.id" },
          { id: "same", kind: "field_absent", path: "item.id" },
        ],
        composition: { operator: "all", predicate_ids: ["same", "same"] },
      },
      {
        ...verdict,
        predicates: [
          { id: "unknown", kind: "unsupported", path: "item.id" },
        ] as unknown as VerdictContract["predicates"],
        composition: { operator: "all", predicate_ids: ["unknown"] },
      },
      {
        ...verdict,
        composition: {
          operator: "none" as "all",
          predicate_ids: ["closed", "resolution"],
        },
      },
      {
        ...verdict,
        composition: { operator: "all", predicate_ids: ["closed"] },
      },
      {
        ...verdict,
        composition: { operator: "all", predicate_ids: ["closed", "unknown"] },
      },
      {
        ...verdict,
        predicates: [
          {
            id: "cyclic",
            kind: "field_equals",
            path: "item.value",
            expected: cyclicExpected,
          },
        ],
        composition: { operator: "all", predicate_ids: ["cyclic"] },
      },
      {
        ...verdict,
        predicates: [
          {
            id: "undefined",
            kind: "field_equals",
            path: "item.value",
            expected: undefined,
          },
        ],
        composition: { operator: "all", predicate_ids: ["undefined"] },
      },
    ];

    for (const declaration of cases) {
      expect(() => defineVerdictContract(declaration)).toThrow();
    }
  });

  it("runs reset, ordinary actions, bounded observation, verdict, and close", async () => {
    const session = await openPmEpisode(
      defineEpisodeSpecification(episodeSpecification),
      new MemoryEpisodeAdapter(),
    );
    const initial = await session.observe();

    expect(initial.status).toBe("served");
    if (initial.status === "served") {
      expect(initial.payload).toEqual({
        item: { id: "pm-task", title: "Complete me", status: "open" },
      });
      expect(JSON.stringify(initial.payload)).not.toContain("expected_status");
    }

    await session.step({ status: "closed" });
    const result = await session.close();

    expect(result.verdict.outcome).toBe("satisfied");
    expect(result.trajectory.map((entry) => entry.kind)).toEqual([
      "reset",
      "observation",
      "action",
      "verdict",
      "close",
    ]);
    expect(result.reward).toBeUndefined();
  });

  it("isolates concurrent runs and produces byte-identical deterministic receipts", async () => {
    const run = async () => {
      const session = await openPmEpisode(
        defineEpisodeSpecification(episodeSpecification),
        new MemoryEpisodeAdapter(),
      );
      await session.observe();
      await session.step({ status: "closed" });
      return session.close();
    };
    const [first, second] = await Promise.all([run(), run()]);

    expect(first).toEqual(second);
  });

  it("enforces action limits and rejects hidden-field leakage in declarations", async () => {
    const session = await openPmEpisode(
      defineEpisodeSpecification(episodeSpecification),
      new MemoryEpisodeAdapter(),
    );
    await session.step({ status: "open" });
    await session.step({ status: "closed" });
    await expect(session.step({ status: "closed" })).rejects.toThrow(
      /max_actions/u,
    );

    expect(() =>
      defineEpisodeSpecification({
        ...episodeSpecification,
        observable_fields: ["grading.expected_status"],
      }),
    ).toThrow(/withheld field/u);
  });

  it("rejects ancestor and descendant overlaps with withheld fields", () => {
    for (const observableField of [
      "grading",
      "grading.expected_status.detail",
    ]) {
      expect(() =>
        defineEpisodeSpecification({
          ...episodeSpecification,
          observable_fields: [observableField],
        }),
      ).toThrow(/overlaps withheld field/u);
    }
  });

  it("charges observation and grading reads to one closed-session limit", async () => {
    const observationLimited = await openPmEpisode(
      defineEpisodeSpecification({
        ...episodeSpecification,
        limits: { ...episodeSpecification.limits, max_observations: 1 },
      }),
      new MemoryEpisodeAdapter(),
    );
    await observationLimited.observe();
    await expect(observationLimited.observe()).rejects.toThrow(
      /max_observations/u,
    );
    await expect(observationLimited.score()).rejects.toThrow(
      /max_observations/u,
    );

    const scoreLimited = await openPmEpisode(
      defineEpisodeSpecification({
        ...episodeSpecification,
        limits: { ...episodeSpecification.limits, max_observations: 1 },
      }),
      new MemoryEpisodeAdapter(),
    );
    const verdictResult = await scoreLimited.score();
    expect(verdictResult.outcome).toBe("violated");
    await expect(scoreLimited.score()).rejects.toThrow(/max_observations/u);
    await expect(scoreLimited.close()).rejects.toThrow(/max_observations/u);

    const closedSession = await openPmEpisode(
      defineEpisodeSpecification({
        ...episodeSpecification,
        limits: { ...episodeSpecification.limits, max_observations: 2 },
      }),
      new MemoryEpisodeAdapter(),
    );
    await closedSession.observe();
    await closedSession.close();
    await expect(closedSession.observe()).rejects.toThrow(/already closed/u);
    await expect(closedSession.step({ status: "open" })).rejects.toThrow(
      /already closed/u,
    );
    await expect(closedSession.score()).rejects.toThrow(/already closed/u);
    await expect(closedSession.close()).rejects.toThrow(/already closed/u);
  });

  it("fails closed on malformed episode declarations", () => {
    const cases: EpisodeSpecification[] = [
      { ...episodeSpecification, schema: "wrong" as typeof PM_EPISODE_SCHEMA },
      { ...episodeSpecification, id: "" },
      { ...episodeSpecification, version: 0 },
      { ...episodeSpecification, mode: "unknown" as "evaluation" },
      { ...episodeSpecification, task_item_ids: [] },
      { ...episodeSpecification, task_item_ids: [""] },
      {
        ...episodeSpecification,
        limits: { ...episodeSpecification.limits, max_actions: 0 },
      },
      {
        ...episodeSpecification,
        limits: { ...episodeSpecification.limits, max_observations: 0 },
      },
      {
        ...episodeSpecification,
        limits: {
          ...episodeSpecification.limits,
          max_tokens_per_observation: 0,
        },
      },
      { ...episodeSpecification, observable_fields: ["item..id"] },
      { ...episodeSpecification, withheld_fields: ["constructor.value"] },
      {
        ...episodeSpecification,
        observable_fields: ["item.id"],
      },
      {
        ...episodeSpecification,
        recipe: {
          ...episodeSpecification.recipe,
          schema: "wrong" as typeof PM_WORKSPACE_RECIPE_SCHEMA,
        },
      },
    ];

    for (const [index, declaration] of cases.entries()) {
      expect(
        () => defineEpisodeSpecification(declaration),
        `malformed episode case ${index}`,
      ).toThrow();
    }
  });
});
