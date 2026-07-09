import { describe, expect, it } from "vitest";
import { buildItemContextRelevanceCandidates, runContext } from "../../../src/cli/commands/context.js";
import { runNext } from "../../../src/cli/commands/next.js";
import { resolveRuntimeStatusRegistry } from "../../../src/core/schema/runtime-schema.js";
import { SETTINGS_DEFAULTS } from "../../../src/core/shared/constants.js";
import type { ItemFrontMatter } from "../../../src/types/index.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

function relevanceItem(
  id: string,
  overrides: Partial<ItemFrontMatter> = {},
): ItemFrontMatter {
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
  } as ItemFrontMatter;
}

describe("context relevance command integration", () => {
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
        learnings: [{ text: "three" }, { text: "four" }, { text: "five" }] as never,
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
    const candidates = buildItemContextRelevanceCandidates(items, registry, now, "codex-root");

    expect(candidates.map((entry) => entry.id)).toEqual(items.map((item) => item.id));
    expect(candidates[0]?.signals).toMatchObject({
      graph_proximity: 0.3,
      claim_focus: 1,
      priority_pressure: 1,
      risk_pressure: 1,
      deadline_pressure: 1,
      knowledge_density: 1,
      author_affinity: 0,
      recency: 1,
    });
    expect(candidates[1]?.signals).toMatchObject({ claim_focus: 0.75, risk_pressure: 0.5, author_affinity: 1 });
    expect(candidates[1]?.signals?.deadline_pressure).toBeCloseTo(0.5);
    expect(candidates[2]?.signals?.risk_pressure).toBe(0.1);
    expect(candidates[3]?.signals).toMatchObject({ claim_focus: 0, risk_pressure: 0, deadline_pressure: 0 });
    expect(buildItemContextRelevanceCandidates([items[0] as ItemFrontMatter], registry, now, undefined)[0]?.signals?.recency).toBe(1);
    expect(buildItemContextRelevanceCandidates([
      relevanceItem("pm-invalid-runtime", { priority: undefined as never, deadline: "2026-08-09" }),
    ], registry, "invalid-now", undefined)[0]?.signals).toMatchObject({ priority_pressure: 0, deadline_pressure: 0 });
    expect(buildItemContextRelevanceCandidates([
      relevanceItem("pm-string-priority", { priority: "2" as never }),
    ], registry, now, undefined)[0]?.signals?.priority_pressure).toBe(0.5);
    const tied = buildItemContextRelevanceCandidates([
      relevanceItem("pm-b"),
      relevanceItem("pm-a"),
    ], registry, now, undefined);
    expect(tied.find((entry) => entry.id === "pm-a")?.signals?.recency).toBe(1);
  });

  it("normalizes defensive runtime metadata shapes without invalid signals", () => {
    const registry = resolveRuntimeStatusRegistry(SETTINGS_DEFAULTS.schema);
    const runtimeShapes = buildItemContextRelevanceCandidates([
      relevanceItem("pm-date-deadline", { deadline: new Date("2026-07-09T00:00:00.000Z") as never, risk: " High " as never }),
      relevanceItem("pm-number-deadline", { deadline: Date.parse("2026-08-09T00:00:00.000Z") as never, assignee: 42 as never }),
    ], registry, "2026-07-10T00:00:00.000Z", "codex-root");

    expect(runtimeShapes[0]?.signals).toMatchObject({ deadline_pressure: 1, risk_pressure: 1 });
    expect(runtimeShapes[1]?.signals?.deadline_pressure).toBeCloseTo(0.5);
    expect(runtimeShapes[1]?.signals?.author_affinity).toBe(0);
  });

  it("uses one scorer for context and next and emits explanations only on request", async () => {
    await withTempPmPath(async (context) => {
      for (const [title, priority] of [["Baseline", "3"], ["Urgent", "0"]]) {
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
      }

      const compact = await runContext({}, { path: context.pmPath });
      const explainedContext = await runContext({ explainRanking: true }, { path: context.pmPath });
      const explainedNext = await runNext({ explainRanking: true }, { path: context.pmPath });
      const contextAlias = context.runCli(["context", "--json", "--explain_ranking"], { expectJson: true });
      const nextAlias = context.runCli(["next", "--json", "--explain_ranking"], { expectJson: true });

      expect(compact.ranking).toBeUndefined();
      expect(explainedContext.ranking?.model).toBe("default-weighted-v1");
      expect(explainedContext.ranking?.available_signals).toContain("priority_pressure");
      expect(explainedNext.ranking?.items.map((entry) => entry.id)).toEqual(
        explainedNext.ready.map((entry) => entry.id),
      );
      expect(explainedNext.ranking?.items[0]?.contributions.priority_pressure).toBeGreaterThan(0);
      expect(contextAlias.code).toBe(0);
      expect(contextAlias.json).toMatchObject({ ranking: { model: "default-weighted-v1" } });
      expect(nextAlias.code).toBe(0);
      expect(nextAlias.json).toMatchObject({ ranking: { model: "default-weighted-v1" } });
    });
  });
});
