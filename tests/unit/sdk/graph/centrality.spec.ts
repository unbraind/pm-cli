import { describe, expect, it } from "vitest";
import {
  computeRelationshipCentrality,
  findRelationshipCutStructure,
} from "../../../../src/sdk/graph/centrality.js";
import { RelationshipGraph } from "../../../../src/sdk/relationships.js";

const dep = (id: string, kind: string) => ({ id, kind });

describe("computeRelationshipCentrality", () => {
  it("ranks a path graph with directed fan-in/out and isolate closeness", () => {
    // a -(related)- b -(blocked_by)- c, plus an isolated node.
    const graph = RelationshipGraph.fromItems([
      { id: "pm-a", dependencies: [dep("pm-b", "related")] },
      { id: "pm-b", dependencies: [dep("pm-c", "blocked_by")] },
      { id: "pm-c" },
      { id: "pm-iso" },
    ]);
    const result = computeRelationshipCentrality(graph);
    expect(result.value.nodeCount).toBe(4);
    expect(result.value.edgeCount).toBe(2);
    expect(result.meta.truncated).toBe(false);
    expect(result.meta.visitedNodes).toBeGreaterThan(0);
    expect(result.meta.inspectedEdges).toBeGreaterThan(0);
    expect(result.value.rows).toEqual([
      {
        id: "pm-b",
        degree: 2,
        inDegree: 0,
        outDegree: 1,
        betweenness: 1,
        closeness: 0.666667,
      },
      {
        id: "pm-a",
        degree: 1,
        inDegree: 0,
        outDegree: 0,
        betweenness: 0,
        closeness: 0.444444,
      },
      {
        id: "pm-c",
        degree: 1,
        inDegree: 1,
        outDegree: 0,
        betweenness: 0,
        closeness: 0.444444,
      },
      {
        id: "pm-iso",
        degree: 0,
        inDegree: 0,
        outDegree: 0,
        betweenness: 0,
        closeness: 0,
      },
    ]);
    // Deterministic across repeated calls.
    expect(computeRelationshipCentrality(graph).value.rows).toEqual(
      result.value.rows,
    );
  });

  it("splits betweenness across equal-length shortest paths in a square", () => {
    // a-b, a-c, b-d, c-d: a and d connect through both b and c.
    const graph = RelationshipGraph.fromItems([
      {
        id: "pm-a",
        dependencies: [dep("pm-b", "related"), dep("pm-c", "related")],
      },
      { id: "pm-b", dependencies: [dep("pm-d", "related")] },
      { id: "pm-c", dependencies: [dep("pm-d", "related")] },
      { id: "pm-d" },
    ]);
    const result = computeRelationshipCentrality(graph);
    expect(result.value.edgeCount).toBe(4);
    // The square is symmetric: every node brokers exactly one pair's paths.
    for (const row of result.value.rows) {
      expect(row.degree).toBe(2);
      expect(row.betweenness).toBe(0.5);
      expect(row.closeness).toBe(0.75);
    }
  });

  it("returns a zero-closeness single node without dividing by zero", () => {
    const graph = RelationshipGraph.fromItems([{ id: "pm-solo" }]);
    const result = computeRelationshipCentrality(graph);
    expect(result.value.nodeCount).toBe(1);
    expect(result.value.edgeCount).toBe(0);
    expect(result.value.rows).toEqual([
      {
        id: "pm-solo",
        degree: 0,
        inDegree: 0,
        outDegree: 0,
        betweenness: 0,
        closeness: 0,
      },
    ]);
  });

  it("restricts adjacency to selected kinds", () => {
    const graph = RelationshipGraph.fromItems([
      { id: "pm-a", dependencies: [dep("pm-b", "related")] },
      { id: "pm-b", dependencies: [dep("pm-c", "blocks")] },
      { id: "pm-c" },
    ]);
    const related = computeRelationshipCentrality(graph, { kinds: ["related"] });
    // Only a-b survives, so c is isolated and b is no longer a broker.
    const byId = new Map(related.value.rows.map((row) => [row.id, row]));
    expect(byId.get("pm-c")!.degree).toBe(0);
    expect(byId.get("pm-b")!.betweenness).toBe(0);
    expect(related.value.edgeCount).toBe(1);
  });

  it("honors an abort signal", () => {
    const graph = RelationshipGraph.fromItems([
      { id: "pm-a", dependencies: [dep("pm-b", "related")] },
      { id: "pm-b" },
    ]);
    expect(() =>
      computeRelationshipCentrality(graph, { signal: AbortSignal.abort() }),
    ).toThrow(/aborted/i);
  });

  it("returns empty results for an empty workspace", () => {
    const graph = RelationshipGraph.fromItems([]);
    const result = computeRelationshipCentrality(graph);
    expect(result.value).toEqual({ nodeCount: 0, edgeCount: 0, rows: [] });
    expect(result.meta.visitedNodes).toBe(0);
  });
});

describe("findRelationshipCutStructure", () => {
  it("finds the middle of a path as an articulation point with two bridges", () => {
    const graph = RelationshipGraph.fromItems([
      { id: "pm-a", dependencies: [dep("pm-b", "related")] },
      { id: "pm-b", dependencies: [dep("pm-c", "related")] },
      { id: "pm-c" },
      { id: "pm-iso" },
    ]);
    const result = findRelationshipCutStructure(graph);
    expect(result.value.articulationPoints).toEqual(["pm-b"]);
    expect(result.value.bridges).toEqual([
      { source: "pm-a", target: "pm-b" },
      { source: "pm-b", target: "pm-c" },
    ]);
    expect(result.meta.visitedNodes).toBe(4);
    expect(result.meta.inspectedEdges).toBeGreaterThan(0);
    expect(result.meta.truncated).toBe(false);
  });

  it("flags a star center via the root-with-multiple-children rule", () => {
    const graph = RelationshipGraph.fromItems([
      {
        id: "pm-a",
        dependencies: [dep("pm-b", "related"), dep("pm-c", "related")],
      },
      { id: "pm-b" },
      { id: "pm-c" },
    ]);
    const result = findRelationshipCutStructure(graph);
    expect(result.value.articulationPoints).toEqual(["pm-a"]);
    expect(result.value.bridges).toEqual([
      { source: "pm-a", target: "pm-b" },
      { source: "pm-a", target: "pm-c" },
    ]);
  });

  it("reports no cuts inside a fully connected triangle", () => {
    const graph = RelationshipGraph.fromItems([
      {
        id: "pm-a",
        dependencies: [dep("pm-b", "related"), dep("pm-c", "related")],
      },
      { id: "pm-b", dependencies: [dep("pm-c", "related")] },
      { id: "pm-c" },
    ]);
    const result = findRelationshipCutStructure(graph);
    expect(result.value.articulationPoints).toEqual([]);
    expect(result.value.bridges).toEqual([]);
  });

  it("restricts cut detection to selected kinds", () => {
    const graph = RelationshipGraph.fromItems([
      { id: "pm-a", dependencies: [dep("pm-b", "related")] },
      { id: "pm-b", dependencies: [dep("pm-c", "blocks")] },
      { id: "pm-c" },
    ]);
    const related = findRelationshipCutStructure(graph, { kinds: ["related"] });
    // Only a-b remains, one bridge, no articulation point.
    expect(related.value.articulationPoints).toEqual([]);
    expect(related.value.bridges).toEqual([
      { source: "pm-a", target: "pm-b" },
    ]);
  });

  it("returns empty results for an empty workspace", () => {
    const result = findRelationshipCutStructure(RelationshipGraph.fromItems([]));
    expect(result.value).toEqual({ articulationPoints: [], bridges: [] });
    expect(result.meta.visitedNodes).toBe(0);
  });

  it("honors an abort signal", () => {
    const graph = RelationshipGraph.fromItems([
      { id: "pm-a", dependencies: [dep("pm-b", "related")] },
      { id: "pm-b" },
    ]);
    expect(() =>
      findRelationshipCutStructure(graph, { signal: AbortSignal.abort() }),
    ).toThrow(/aborted/i);
  });
});
