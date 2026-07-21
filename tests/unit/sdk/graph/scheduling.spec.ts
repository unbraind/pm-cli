import { describe, expect, it } from "vitest";
import { analyzeRelationshipSchedule } from "../../../../src/sdk/graph/scheduling.js";
import {
  RelationshipGraph,
  RelationshipKindRegistry,
} from "../../../../src/sdk/relationships.js";

const dep = (id: string, kind: string) => ({ id, kind });

/** Registry with one self-allowing ordering kind for self-loop coverage. */
function selfLoopRegistry(): RelationshipKindRegistry {
  const registry = new RelationshipKindRegistry();
  registry.register({
    kind: "retries",
    direction: "directed",
    ordering: true,
    precedence: "source_before_target",
    hierarchy: false,
    outgoing: "many",
    incoming: "many",
    lifecycle: "persistent",
    compatibilityVersion: 1,
    allowSelf: true,
  });
  return registry;
}

describe("analyzeRelationshipSchedule", () => {
  it("schedules a diamond with a shortcut, giving the short leg slack", () => {
    // a -> b -> c -> d  (long leg) and a -> x -> d (short leg).
    const graph = RelationshipGraph.fromItems([
      {
        id: "pm-a",
        dependencies: [dep("pm-b", "blocks"), dep("pm-x", "blocks")],
      },
      { id: "pm-b", dependencies: [dep("pm-c", "blocks")] },
      { id: "pm-c", dependencies: [dep("pm-d", "blocks")] },
      { id: "pm-x", dependencies: [dep("pm-d", "blocks")] },
      { id: "pm-d" },
    ]);
    const analysis = analyzeRelationshipSchedule(graph);
    expect(analysis.exact).toBe(true);
    expect(analysis.acyclic).toBe(true);
    expect(analysis.makespan).toBe(4);
    expect(analysis.scheduledCount).toBe(5);
    expect(analysis.cycles).toEqual([]);
    expect(analysis.criticalPath).toEqual(["pm-a", "pm-b", "pm-c", "pm-d"]);
    expect(analysis.criticalPathLength).toBe(3);
    expect(analysis.provenance).toEqual({
      algorithm: "critical-path-method",
      edgeFamily: "ordering",
      weighting: "unit",
    });
    expect(analysis.rows).toEqual([
      {
        id: "pm-a",
        earliestStart: 0,
        earliestFinish: 1,
        latestStart: 0,
        latestFinish: 1,
        slack: 0,
        critical: true,
      },
      {
        id: "pm-b",
        earliestStart: 1,
        earliestFinish: 2,
        latestStart: 1,
        latestFinish: 2,
        slack: 0,
        critical: true,
      },
      {
        id: "pm-c",
        earliestStart: 2,
        earliestFinish: 3,
        latestStart: 2,
        latestFinish: 3,
        slack: 0,
        critical: true,
      },
      {
        id: "pm-d",
        earliestStart: 3,
        earliestFinish: 4,
        latestStart: 3,
        latestFinish: 4,
        slack: 0,
        critical: true,
      },
      {
        id: "pm-x",
        earliestStart: 1,
        earliestFinish: 2,
        latestStart: 2,
        latestFinish: 3,
        slack: 1,
        critical: false,
      },
    ]);
    // Deterministic across repeated calls.
    expect(analyzeRelationshipSchedule(graph).rows).toEqual(analysis.rows);
  });

  it("breaks equal slack and start ties by id across parallel chains", () => {
    // Two independent chains a->b and c->d: both roots tie at slack 0, start 0.
    const graph = RelationshipGraph.fromItems([
      { id: "pm-a", dependencies: [dep("pm-b", "blocks")] },
      { id: "pm-b" },
      { id: "pm-c", dependencies: [dep("pm-d", "blocks")] },
      { id: "pm-d" },
    ]);
    const analysis = analyzeRelationshipSchedule(graph);
    expect(analysis.makespan).toBe(2);
    expect(analysis.scheduledCount).toBe(4);
    expect(analysis.rows.map((row) => row.id)).toEqual([
      "pm-a",
      "pm-c",
      "pm-b",
      "pm-d",
    ]);
    expect(analysis.rows.every((row) => row.critical)).toBe(true);
  });

  it("omits tasks with no order-bearing edge and reports no schedule", () => {
    const graph = RelationshipGraph.fromItems([
      { id: "pm-a", dependencies: [dep("pm-b", "related")] },
      { id: "pm-b", dependencies: [dep("pm-c", "parent")] },
      { id: "pm-c" },
    ]);
    const analysis = analyzeRelationshipSchedule(graph);
    expect(analysis.acyclic).toBe(true);
    expect(analysis.makespan).toBe(0);
    expect(analysis.scheduledCount).toBe(0);
    expect(analysis.rows).toEqual([]);
    expect(analysis.criticalPath).toEqual([]);
    expect(analysis.criticalPathLength).toBe(0);
  });

  it("excludes a genuine ordering cycle from the schedule", () => {
    const graph = RelationshipGraph.fromItems([
      { id: "pm-p", dependencies: [dep("pm-q", "blocks")] },
      { id: "pm-q", dependencies: [dep("pm-p", "blocks")] },
    ]);
    const analysis = analyzeRelationshipSchedule(graph);
    expect(analysis.acyclic).toBe(false);
    expect(analysis.scheduledCount).toBe(0);
    expect(analysis.makespan).toBe(0);
    expect(analysis.cycles).toEqual([["pm-p", "pm-q"]]);
  });

  it("schedules an acyclic task that points into a downstream cycle", () => {
    // a -> b, and b <-> c form a cycle; a is still schedulable.
    const graph = RelationshipGraph.fromItems([
      { id: "pm-a", dependencies: [dep("pm-b", "blocks")] },
      { id: "pm-b", dependencies: [dep("pm-c", "blocks")] },
      { id: "pm-c", dependencies: [dep("pm-b", "blocks")] },
    ]);
    const analysis = analyzeRelationshipSchedule(graph);
    expect(analysis.acyclic).toBe(false);
    expect(analysis.cycles).toEqual([["pm-b", "pm-c"]]);
    expect(analysis.scheduledCount).toBe(1);
    expect(analysis.makespan).toBe(1);
    expect(analysis.rows).toEqual([
      {
        id: "pm-a",
        earliestStart: 0,
        earliestFinish: 1,
        latestStart: 0,
        latestFinish: 1,
        slack: 0,
        critical: true,
      },
    ]);
  });

  it("skips self-loop ordering edges and reports the self-cycle", () => {
    const graph = new RelationshipGraph(
      ["pm-x", "pm-y"],
      [
        { source: "pm-x", target: "pm-x", kind: "retries" },
        { source: "pm-x", target: "pm-y", kind: "retries" },
      ],
      selfLoopRegistry(),
    );
    const analysis = analyzeRelationshipSchedule(graph);
    expect(analysis.acyclic).toBe(false);
    expect(analysis.cycles).toEqual([["pm-x"]]);
    expect(analysis.scheduledCount).toBe(0);
  });

  it("honors an abort signal", () => {
    const graph = RelationshipGraph.fromItems([
      { id: "pm-a", dependencies: [dep("pm-b", "blocks")] },
      { id: "pm-b" },
    ]);
    expect(() =>
      analyzeRelationshipSchedule(graph, { signal: AbortSignal.abort() }),
    ).toThrow(/aborted/i);
  });
});
