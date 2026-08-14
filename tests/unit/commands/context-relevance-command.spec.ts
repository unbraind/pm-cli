import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildItemContextRelevanceCandidates,
  runContext,
  toContextRankingSummary,
} from "../../../src/cli/commands/context.js";
import { runNext } from "../../../src/cli/commands/next.js";
import { resolveRuntimeStatusRegistry } from "../../../src/core/schema/runtime-schema.js";
import {
  detectAgentIdentity,
  resolveAuthor,
  runWithHarnessDetectionSignals,
} from "../../../src/core/shared/author.js";
import { SETTINGS_DEFAULTS } from "../../../src/core/shared/constants.js";
import { recordClaimedWorkAttribution } from "../../../src/core/session/session-state.js";
import type { ContextRelevanceReport } from "../../../src/sdk/context-relevance.js";
import { readSettings } from "../../../src/core/store/settings.js";
import type { ItemMetadata } from "../../../src/types/index.js";
import {
  withTempPmPath,
  type TempPmContext,
} from "../../helpers/withTempPmPath.js";

function relevanceItem(
  id: string,
  overrides: Partial<ItemMetadata> = {},
): ItemMetadata {
  return {
    id,
    title: id,
    description: `${id} description`,
    type: "Task",
    status: "open",
    priority: 2,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  } as ItemMetadata;
}

function createContextRankingItems(context: TempPmContext): string[] {
  const createdIds: string[] = [];
  for (const [title, priority] of [
    ["Baseline", "3"],
    ["Urgent", "0"],
  ]) {
    const created = context.runCli(
      [
        "create",
        "--json",
        "--title",
        title,
        "--description",
        `${title} description`,
        "--type",
        "Task",
        "--status",
        "open",
        "--priority",
        priority,
      ],
      { expectJson: true },
    );
    expect(created.code).toBe(0);
    createdIds.push((created.json as { item: { id: string } }).item.id);
  }
  return createdIds;
}

describe("context relevance command integration", () => {
  it("keeps feature-store diagnostics optional for SDK summary callers", () => {
    const summary = toContextRankingSummary({
      model: "default-weighted-v1",
      available_signals: [],
      ranked: [],
    });
    expect(summary).not.toHaveProperty("feature_store");
    expect(summary).toMatchObject({ candidate_count: 0, omitted_count: 0 });
  });

  it("keeps ranking explanations answer-sized as the candidate corpus grows", () => {
    const ranked: ContextRelevanceReport<ItemMetadata>["ranked"] = Array.from(
      { length: 10_000 },
      (_, index) => ({
        id: `pm-scale-${String(index).padStart(5, "0")}`,
        item: relevanceItem(`pm-scale-${String(index).padStart(5, "0")}`),
        signals: { priority_pressure: 1 },
        baseline_rank: index + 1,
        rank: index + 1,
        score: 1 - index / 10_000,
        contributions: { priority_pressure: 1 },
      }),
    );
    const servedItemIds = new Set([ranked[0]!.id, ranked[1]!.id]);
    const small = toContextRankingSummary(
      {
        model: "default-weighted-v1",
        available_signals: ["priority_pressure"],
        ranked: ranked.slice(0, 100),
      },
      undefined,
      servedItemIds,
    );
    const large = toContextRankingSummary(
      {
        model: "default-weighted-v1",
        available_signals: ["priority_pressure"],
        ranked,
      },
      undefined,
      servedItemIds,
    );

    expect(large.items).toEqual(small.items);
    expect(large).toMatchObject({
      candidate_count: 10_000,
      omitted_count: 9_998,
    });
    expect(
      JSON.stringify(large).length - JSON.stringify(small).length,
    ).toBeLessThan(16);
  });

  it("derives normalized metadata signals for diverse project items", () => {
    const registry = resolveRuntimeStatusRegistry(SETTINGS_DEFAULTS.schema);
    const now = "2026-07-10T00:00:00.000Z";
    const items = [
      relevanceItem("pm-critical", {
        status: "in_progress",
        priority: 0,
        risk: "critical",
        deadline: "2026-07-09",
        parent: "pm-parent",
        comments: [{ text: "one" }] as never,
        notes: [{ text: "two" }] as never,
        learnings: [
          { text: "three" },
          { text: "four" },
          { text: "five" },
        ] as never,
        updated_at: "2026-07-03T00:00:00.000Z",
      }),
      relevanceItem("pm-medium", {
        risk: "medium",
        deadline: "2026-08-09",
        assignee: "Codex-Root",
        updated_at: "2026-07-02T00:00:00.000Z",
      }),
      relevanceItem("pm-low", { risk: "low" }),
      relevanceItem("pm-none", { risk: undefined, deadline: "not-a-date" }),
    ];
    const candidates = buildItemContextRelevanceCandidates(items, {
      statusRegistry: registry,
      now,
      author: "codex-root",
      usageAffinity: { "pm-critical": 0.8 },
    });

    expect(candidates.map((entry) => entry.id)).toEqual(
      items.map((item) => item.id),
    );
    expect(candidates[0]?.signals).toMatchObject({
      graph_proximity: 0.3,
      claim_focus: 1,
      priority_pressure: 1,
      risk_pressure: 1,
      deadline_pressure: 1,
      knowledge_density: 1,
      author_affinity: 0,
      recency: 1,
      usage_affinity: 0.8,
    });
    expect(candidates[1]?.signals).toMatchObject({
      claim_focus: 0.75,
      risk_pressure: 0.5,
      author_affinity: 1,
    });
    expect(candidates[1]?.signals?.deadline_pressure).toBeCloseTo(0.5);
    expect(candidates[2]?.signals?.risk_pressure).toBe(0.1);
    expect(candidates[3]?.signals).toMatchObject({
      claim_focus: 0,
      risk_pressure: 0,
      deadline_pressure: 0,
    });
    expect(
      buildItemContextRelevanceCandidates([items[0] as ItemMetadata], {
        statusRegistry: registry,
        now,
      })[0]?.signals?.recency,
    ).toBe(1);
    expect(
      buildItemContextRelevanceCandidates(
        [
          relevanceItem("pm-invalid-runtime", {
            priority: undefined as never,
            deadline: "2026-08-09",
          }),
        ],
        { statusRegistry: registry, now: "invalid-now" },
      )[0]?.signals,
    ).toMatchObject({ priority_pressure: 0, deadline_pressure: 0 });
    expect(
      buildItemContextRelevanceCandidates(
        [relevanceItem("pm-string-priority", { priority: "2" as never })],
        { statusRegistry: registry, now },
      )[0]?.signals?.priority_pressure,
    ).toBe(0.5);
    const tied = buildItemContextRelevanceCandidates(
      [relevanceItem("pm-b"), relevanceItem("pm-a")],
      { statusRegistry: registry, now },
    );
    expect(tied.find((entry) => entry.id === "pm-a")?.signals?.recency).toBe(1);
  });

  it("normalizes defensive runtime metadata shapes without invalid signals", () => {
    const registry = resolveRuntimeStatusRegistry(SETTINGS_DEFAULTS.schema);
    const runtimeShapes = buildItemContextRelevanceCandidates(
      [
        relevanceItem("pm-date-deadline", {
          deadline: new Date("2026-07-09T00:00:00.000Z") as never,
          risk: " High " as never,
        }),
        relevanceItem("pm-number-deadline", {
          deadline: Date.parse("2026-08-09T00:00:00.000Z") as never,
          assignee: 42 as never,
        }),
      ],
      {
        statusRegistry: registry,
        now: "2026-07-10T00:00:00.000Z",
        author: "codex-root",
      },
    );

    expect(runtimeShapes[0]?.signals).toMatchObject({
      deadline_pressure: 1,
      risk_pressure: 1,
    });
    expect(runtimeShapes[1]?.signals?.deadline_pressure).toBeCloseTo(0.5);
    expect(runtimeShapes[1]?.signals?.author_affinity).toBe(0);
  });

  it("uses one scorer for context and next and emits explanations only on request", async () => {
    await withTempPmPath(async (context) => {
      createContextRankingItems(context);

      const compact = await runContext({}, { path: context.pmPath });
      const explainedContext = await runContext(
        { explainRanking: true },
        { path: context.pmPath },
      );
      const explainedNext = await runNext(
        { explainRanking: true },
        { path: context.pmPath },
      );
      const contextAlias = context.runCli(
        ["context", "--json", "--explain_ranking"],
        { expectJson: true },
      );
      const nextAlias = context.runCli(
        ["next", "--json", "--explain_ranking"],
        { expectJson: true },
      );
      const budgetAliases = [
        context.runCli(
          ["context", "--json", "--explain-ranking", "--token_budget", "64"],
          { expectJson: true },
        ),
        context.runCli(
          ["next", "--json", "--explain-ranking", "--token_budget", "64"],
          { expectJson: true },
        ),
      ];

      expect(compact.ranking).toBeUndefined();
      expect(compact.packing).toBeUndefined();
      expect(explainedContext.packing).toMatchObject({
        profile: "context",
        token_budget: 1600,
        selection_complete: true,
      });
      expect(explainedContext.ranking?.feature_store).toMatchObject({
        source: "derived_index",
        cache_status: "fresh",
      });
      expect(explainedContext.ranking?.model).toBe("default-weighted-v1");
      expect(explainedContext.ranking?.available_signals).toContain(
        "priority_pressure",
      );
      const contextRowIds = [
        ...explainedContext.high_level,
        ...explainedContext.low_level,
        ...explainedContext.blocked_fallback,
      ].map((entry) => entry.id);
      expect(explainedContext.ranking?.items.map((entry) => entry.id)).toEqual(
        contextRowIds,
      );
      expect(explainedContext.ranking?.candidate_count).toBeGreaterThanOrEqual(
        contextRowIds.length,
      );
      expect(explainedContext.ranking?.omitted_count).toBe(
        explainedContext.ranking!.candidate_count - contextRowIds.length,
      );
      expect(explainedNext.ranking?.items.map((entry) => entry.id)).toEqual(
        [
          explainedNext.recommended?.id,
          ...explainedNext.ready.map((entry) => entry.id),
        ].filter(Boolean),
      );
      expect(
        explainedNext.ranking?.items[0]?.contributions.priority_pressure,
      ).toBeGreaterThan(0);
      expect(explainedNext.packing).toMatchObject({
        profile: "next",
        token_budget: 640,
        selection_complete: true,
      });
      expect(explainedNext.ranking?.feature_store).toMatchObject({
        source: "derived_index",
        cache_status: "rebuilt",
      });
      const boundedContext = await runContext(
        { explainRanking: true, tokenBudget: "64" },
        { path: context.pmPath },
      );
      const boundedNext = await runNext(
        { explainRanking: true, tokenBudget: "64" },
        { path: context.pmPath },
      );
      expect(boundedContext.packing?.token_budget).toBe(64);
      expect(boundedNext.packing?.token_budget).toBe(64);
      expect(contextAlias.code).toBe(0);
      expect(contextAlias.json).toMatchObject({
        ranking: { model: "default-weighted-v1" },
      });
      expect(nextAlias.code).toBe(0);
      expect(nextAlias.json).toMatchObject({
        ranking: { model: "default-weighted-v1" },
      });
      for (const result of budgetAliases) {
        expect(result.code).toBe(0);
        expect(result.json).toMatchObject({
          filters: { token_budget: 64 },
          packing: { token_budget: 64 },
        });
      }
      await expect(
        runContext({ tokenBudget: "0" }, { path: context.pmPath }),
      ).rejects.toThrow("--token-budget must be a positive integer");
      await expect(
        runContext({ tokenBudget: "-1" }, { path: context.pmPath }),
      ).rejects.toThrow("--token-budget must be a positive integer");
      await expect(
        runContext({ tokenBudget: "1.5" }, { path: context.pmPath }),
      ).rejects.toThrow("--token-budget must be a positive integer");
      await expect(
        runContext({ tokenBudget: "" }, { path: context.pmPath }),
      ).rejects.toThrow("--token-budget must be a positive integer");
      await expect(
        runNext({ tokenBudget: 1.5 }, { path: context.pmPath }),
      ).rejects.toThrow("--token-budget must be a positive integer");
    });
  });

  it("packs active semantic claims as required context within the same ceiling", async () => {
    await withTempPmPath(async (context) => {
      const createdIds = createContextRankingItems(context);
      const settings = await readSettings(context.pmPath);
      const author = resolveAuthor(undefined, settings.author_default);
      const instance = detectAgentIdentity().instance;
      await recordClaimedWorkAttribution({
        pmRoot: context.pmPath,
        principal: instance ? `${author}#${instance}` : author,
        itemId: createdIds[0]!,
      });

      const result = await runContext(
        { explainRanking: true, tokenBudget: "64" },
        { path: context.pmPath },
      );
      expect(result.packing).toMatchObject({
        token_budget: 64,
        included: expect.arrayContaining([
          expect.objectContaining({ id: createdIds[0] }),
        ]),
      });
      expect(
        result.ranking?.items.find((entry) => entry.id === createdIds[0])
          ?.contributions.claim_focus,
      ).toBeGreaterThan(0);
      await expect(
        runWithHarnessDetectionSignals({ cwd: context.tempRoot, env: {} }, () =>
          runContext({}, { path: context.pmPath }),
        ),
      ).resolves.toBeDefined();
    });
  });

  it("folds usage feedback dynamically and tolerates an absent author", async () => {
    await withTempPmPath(async (context) => {
      const createdIds = createContextRankingItems(context);
      await runContext({}, { path: context.pmPath });
      const read = context.runCli(["get", createdIds[1]!, "--json"], {
        expectJson: true,
      });
      expect(read.code).toBe(0);
      const touched = context.runCli(
        ["update", createdIds[0]!, "--priority", "2", "--json"],
        { expectJson: true },
      );
      expect(touched.code).toBe(0);
      const feedbackNext = await runNext(
        { explainRanking: true },
        { path: context.pmPath },
      );
      expect(feedbackNext.ranking?.available_signals).toContain(
        "usage_affinity",
      );
      expect(
        feedbackNext.ranking?.items.find((entry) => entry.id === createdIds[0])
          ?.contributions.usage_affinity,
      ).toBeGreaterThan(0);
      expect(
        feedbackNext.ranking?.items.find((entry) => entry.id === createdIds[1])
          ?.contributions.usage_affinity,
      ).toBeGreaterThan(0);

      const previousAuthor = process.env.PM_AUTHOR;
      delete process.env.PM_AUTHOR;
      try {
        await expect(
          runContext({}, { path: context.pmPath }),
        ).resolves.toBeDefined();
        await expect(
          runNext({}, { path: context.pmPath }),
        ).resolves.toBeDefined();
      } finally {
        if (previousAuthor === undefined) delete process.env.PM_AUTHOR;
        else process.env.PM_AUTHOR = previousAuthor;
      }
    });
  });

  it("contains derived usage-write failures without breaking context or next", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        [
          "create",
          "--json",
          "--title",
          "Feedback resilience",
          "--description",
          "Exercises derived usage failure containment",
          "--type",
          "Task",
          "--status",
          "open",
        ],
        { expectJson: true },
      );
      expect(created.code).toBe(0);

      const runtimePath = path.join(context.pmPath, "runtime");
      await rm(runtimePath, { recursive: true, force: true });
      await writeFile(runtimePath, "blocks derived usage storage\n", "utf8");
      try {
        const contextResult = await runContext({}, { path: context.pmPath });
        const nextResult = await runNext({}, { path: context.pmPath });
        expect(contextResult.warnings).toContain(
          "context_usage_feedback_write_failed",
        );
        expect(nextResult.warnings).toContain(
          "context_usage_feedback_write_failed",
        );

        await writeFile(
          path.join(context.pmPath, "tasks", "invalid-usage-warning.toon"),
          "not valid item metadata\n",
          "utf8",
        );
        const warnedNext = await runNext({}, { path: context.pmPath });
        expect(warnedNext.warnings).toContain(
          "context_usage_feedback_write_failed",
        );
        expect(warnedNext.warnings?.length).toBeGreaterThan(1);
      } finally {
        await rm(runtimePath, { force: true });
      }
    });
  });
});
