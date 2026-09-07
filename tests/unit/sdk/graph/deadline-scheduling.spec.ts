import { describe, expect, it } from "vitest";
import { assembleWorkspaceRelationshipGraph } from "../../../../src/sdk/graph/assembly.js";
import { deriveRelationshipDeadlines } from "../../../../src/sdk/graph/deadline-scheduling.js";
import {
  RelationshipGraph,
  RelationshipKindRegistry,
} from "../../../../src/sdk/relationships.js";

describe("deadline-derived scheduling", () => {
  it("propagates estimates backward and clears shortfall when the deadline moves later", () => {
    const items = [
      {
        id: "pm-a",
        title: "Prerequisite",
        status: "open",
        estimated_minutes: 60,
      },
      {
        id: "pm-b",
        title: "Milestone",
        status: "open",
        estimated_minutes: 30,
        blocked_by: "pm-a",
        deadline: "2026-09-07T01:00:00Z",
      },
    ];
    const graph = assembleWorkspaceRelationshipGraph(items).graph;
    const options = { now: "2026-09-07T00:00:00Z" };
    const early = deriveRelationshipDeadlines(graph, items, options);
    expect(early.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "pm-a",
          latest_start: "2026-09-06T23:30:00.000Z",
          slack_minutes: -30,
        }),
        expect.objectContaining({
          id: "pm-b",
          latest_start: "2026-09-07T00:30:00.000Z",
          slack_minutes: -30,
        }),
      ]),
    );
    expect(early.overcommitted).toEqual([
      expect.objectContaining({
        deadline_id: "pm-b",
        shortfall_minutes: 30,
        path: ["pm-a", "pm-b"],
      }),
    ]);
    const later = deriveRelationshipDeadlines(
      graph,
      items.map((item) =>
        item.deadline ? { ...item, deadline: "2026-09-07T02:00:00Z" } : item,
      ),
      options,
    );
    expect(later.overcommitted).toEqual([]);
    expect(items[0]).not.toHaveProperty("deadline");
  });

  it("reports missing estimates and cycles without manufacturing feasibility", () => {
    const items = [
      { id: "pm-a", title: "Unknown", status: "open" },
      {
        id: "pm-b",
        title: "Milestone",
        status: "open",
        estimated_minutes: 30,
        blocked_by: "pm-a",
        deadline: "2026-09-07T01:00:00Z",
      },
      {
        id: "pm-c",
        title: "Cycle",
        status: "open",
        estimated_minutes: 1,
        blocked_by: "pm-d",
      },
      {
        id: "pm-d",
        title: "Cycle peer",
        status: "open",
        estimated_minutes: 1,
        blocked_by: "pm-c",
      },
    ];
    const result = deriveRelationshipDeadlines(
      assembleWorkspaceRelationshipGraph(items).graph,
      items,
      { now: "2026-09-07T00:00:00Z" },
    );
    expect(result.residuals).toEqual(
      expect.arrayContaining([
        { id: "pm-a", reason: "unknown_estimate" },
        { id: "pm-b", reason: "unknown_predecessor_estimate" },
        { id: "pm-c", reason: "cycle_or_gated_by_cycle" },
      ]),
    );
    expect(
      result.rows.find((row) => row.id === "pm-b")?.slack_minutes,
    ).toBeNull();
    expect(result.complete).toBe(false);
  });

  it("bounds work and every evidence collection, including long controlling paths", () => {
    const items = Array.from({ length: 6 }, (_, index) => ({
      id: `pm-${index}`,
      title: "Chain",
      status: "open",
      estimated_minutes: 1,
      ...(index > 0 ? { blocked_by: `pm-${index - 1}` } : {}),
      deadline: "2026-09-07T00:00:00Z",
    }));
    const graph = assembleWorkspaceRelationshipGraph(items).graph;
    expect(
      deriveRelationshipDeadlines(graph, items, { maxWork: 1 }),
    ).toMatchObject({
      complete: false,
      work_limit_exceeded: true,
      rows: [],
    });
    const result = deriveRelationshipDeadlines(graph, items, {
      now: "2026-09-07T00:00:00Z",
      limit: 1,
    });
    expect(result).toMatchObject({
      scheduled_count: 6,
      overcommitted_count: 6,
      truncated: true,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.overcommitted).toHaveLength(1);
    const endpointOnly = items.map((item, index) => ({
      ...item,
      deadline: index === 5 ? item.deadline : undefined,
    }));
    expect(
      deriveRelationshipDeadlines(graph, endpointOnly, {
        now: "2026-09-07T00:00:00Z",
        limit: 2,
      }).overcommitted,
    ).toEqual([
      expect.objectContaining({ path: ["pm-4", "pm-5"], path_truncated: true }),
    ]);
    const unknown = deriveRelationshipDeadlines(
      graph,
      items.map((item) => ({ ...item, estimated_minutes: undefined })),
      { limit: 1 },
    );
    expect(unknown).toMatchObject({ residual_count: 6, truncated: true });
    expect(unknown.residuals).toHaveLength(1);
  });

  it("uses registered precedence, deduplicates inverse constraints, and resolves tied paths deterministically", () => {
    const registry = new RelationshipKindRegistry();
    registry.register({
      kind: "precedes",
      direction: "directed",
      ordering: true,
      hierarchy: false,
      outgoing: "many",
      incoming: "many",
      lifecycle: "persistent",
      compatibilityVersion: 1,
      allowSelf: false,
    });
    const graph = new RelationshipGraph(
      ["pm-a", "pm-b", "pm-c", "pm-d"],
      [
        { source: "pm-a", target: "pm-d", kind: "precedes" },
        { source: "pm-d", target: "pm-a", kind: "blocked_by" },
        { source: "pm-b", target: "pm-d", kind: "blocks" },
        { source: "pm-c", target: "pm-d", kind: "blocks" },
        { source: "pm-a", target: "pm-b", kind: "related" },
      ],
      registry,
    );
    const items = graph.nodes().map((id) => ({
      id,
      estimated_minutes: id === "pm-c" ? 0 : 10,
      ...(id === "pm-d" ? { deadline: "2026-09-07T00:00:00Z" } : {}),
    }));
    const result = deriveRelationshipDeadlines(graph, items, {
      now: "2026-09-07T00:00:00Z",
    });
    expect(result.overcommitted[0]).toMatchObject({
      shortfall_minutes: 20,
      path: ["pm-a", "pm-d"],
    });
    expect(result.residuals).toEqual([]);
    expect(result.scheduled_count).toBe(4);
  });

  it("retains the tightest of several dated successors and propagates unknown prerequisites", () => {
    const items = [
      { id: "pm-a", title: "A", status: "open", estimated_minutes: 10 },
      {
        id: "pm-b",
        title: "B",
        status: "open",
        estimated_minutes: 20,
        blocked_by: "pm-a",
        deadline: "2026-09-07T01:00:00Z",
      },
      {
        id: "pm-c",
        title: "C",
        status: "open",
        estimated_minutes: 20,
        blocked_by: "pm-a",
        deadline: "2026-09-07T02:00:00Z",
      },
      {
        id: "pm-d",
        title: "Unknown",
        status: "open",
        blocked_by: "pm-a",
        deadline: "2026-09-07T00:00:00Z",
      },
    ];
    const graph = assembleWorkspaceRelationshipGraph(items).graph;
    const result = deriveRelationshipDeadlines(graph, items, {
      now: "2026-09-07T00:00:00Z",
    });
    expect(result.rows.find((row) => row.id === "pm-a")).toMatchObject({
      deadline_id: "pm-b",
      slack_minutes: 30,
    });
    expect(result.residuals).toContainEqual({
      id: "pm-d",
      reason: "unknown_estimate",
    });
  });

  it("rejects malformed controls, honors cancellation, and reports invalid recorded dates", () => {
    const graph = new RelationshipGraph(["pm-a"], []);
    for (const options of [{ now: "invalid" }, { limit: 0 }, { maxWork: -1 }]) {
      expect(() => deriveRelationshipDeadlines(graph, [], options)).toThrow(
        TypeError,
      );
    }
    expect(() =>
      deriveRelationshipDeadlines(graph, [], { signal: AbortSignal.abort() }),
    ).toThrow();
    expect(
      deriveRelationshipDeadlines(graph, [
        { id: "pm-a", deadline: "invalid", estimated_minutes: Number.NaN },
      ]).residuals,
    ).toEqual([
      { id: "pm-a", reason: "invalid_deadline" },
      { id: "pm-a", reason: "unknown_estimate" },
    ]);
    expect(
      deriveRelationshipDeadlines(new RelationshipGraph([], []), []).complete,
    ).toBe(true);
    expect(deriveRelationshipDeadlines(graph, []).residuals).toContainEqual({
      id: "pm-a",
      reason: "unknown_estimate",
    });
    expect(
      deriveRelationshipDeadlines(graph, [
        {
          id: "pm-a",
          estimated_minutes: 1e300,
          deadline: "2026-09-07T00:00:00Z",
        },
      ]).residuals,
    ).toContainEqual({ id: "pm-a", reason: "date_range_exceeded" });
  });
  it("leaves known-duration undated components unconstrained", () => {
    const graph = new RelationshipGraph(["pm-a"], []);
    expect(
      deriveRelationshipDeadlines(graph, [
        { id: "pm-a", estimated_minutes: 15 },
      ]),
    ).toMatchObject({
      complete: true,
      scheduled_count: 0,
      residual_count: 0,
      overcommitted_count: 0,
    });
  });
});
