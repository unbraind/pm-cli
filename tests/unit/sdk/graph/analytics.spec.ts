import { describe, expect, it } from "vitest";
import {
  computeRelationshipDominators,
  detectRelationshipCommunities,
  findRedundantRelationshipEdges,
} from "../../../../src/sdk/graph/analytics.js";
import {
  RelationshipGraph,
  RelationshipKindRegistry,
} from "../../../../src/sdk/relationships.js";

const dep = (id: string, kind: string) => ({ id, kind });

/** Registry with one self-allowing ordering kind for loop-edge coverage. */
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

describe("detectRelationshipCommunities", () => {
  it("clusters two disjoint groups deterministically and reports convergence", () => {
    const graph = RelationshipGraph.fromItems([
      { id: "pm-a1", dependencies: [dep("pm-a2", "related")] },
      { id: "pm-a2", dependencies: [dep("pm-a3", "related")] },
      { id: "pm-a3" },
      { id: "pm-b1", dependencies: [dep("pm-b2", "related")] },
      { id: "pm-b2" },
      { id: "pm-c1", dependencies: [dep("pm-c2", "related")] },
      { id: "pm-c2" },
      { id: "pm-isolate" },
    ]);
    const result = detectRelationshipCommunities(graph);
    expect(result.value.converged).toBe(true);
    expect(result.meta.truncated).toBe(false);
    // Equal-size communities order by representative after the size sort.
    expect(result.value.communities).toEqual([
      {
        representative: "pm-a1",
        size: 3,
        members: ["pm-a1", "pm-a2", "pm-a3"],
      },
      {
        representative: "pm-b1",
        size: 2,
        members: ["pm-b1", "pm-b2"],
      },
      {
        representative: "pm-c1",
        size: 2,
        members: ["pm-c1", "pm-c2"],
      },
    ]);
    expect(result.meta.visitedNodes).toBeGreaterThan(0);
    expect(result.meta.inspectedEdges).toBeGreaterThan(0);
    const again = detectRelationshipCommunities(graph);
    expect(again.value).toEqual(result.value);
  });

  it("respects kind filters including inverse spellings and the size floor", () => {
    const graph = RelationshipGraph.fromItems([
      { id: "pm-x", dependencies: [dep("pm-y", "blocked_by")] },
      { id: "pm-y", dependencies: [dep("pm-z", "related")] },
      { id: "pm-z" },
    ]);
    const filtered = detectRelationshipCommunities(graph, {
      kinds: ["blocks"],
    });
    expect(filtered.value.communities).toEqual([
      { representative: "pm-x", size: 2, members: ["pm-x", "pm-y"] },
    ]);
    const floored = detectRelationshipCommunities(graph, { minSize: 3 });
    expect(floored.value.communities).toEqual([
      { representative: "pm-x", size: 3, members: ["pm-x", "pm-y", "pm-z"] },
    ]);
    expect(
      detectRelationshipCommunities(graph, { minSize: 4 }).value.communities,
    ).toEqual([]);
  });

  it("weights parallel edges when breaking label ties", () => {
    // pm-mid has one edge to pm-solo and two parallel edges to pm-pair, so
    // the doubled neighbor label wins over the lexicographically smaller one.
    const graph = RelationshipGraph.fromItems([
      {
        id: "pm-mid",
        dependencies: [
          dep("pm-a-solo", "related"),
          dep("pm-z-pair", "related"),
          dep("pm-z-pair", "blocked_by"),
        ],
      },
      { id: "pm-a-solo" },
      { id: "pm-z-pair" },
    ]);
    const result = detectRelationshipCommunities(graph);
    const labels = result.value.communities.find((community) =>
      community.members.includes("pm-mid"),
    );
    expect(labels?.members).toContain("pm-z-pair");
  });

  it("reports non-convergence as truncation when the iteration bound stops the sweep", () => {
    const graph = RelationshipGraph.fromItems([
      { id: "pm-1", dependencies: [dep("pm-2", "related")] },
      { id: "pm-2", dependencies: [dep("pm-3", "related")] },
      { id: "pm-3", dependencies: [dep("pm-4", "related")] },
      { id: "pm-4" },
    ]);
    const bounded = detectRelationshipCommunities(graph, { maxIterations: 1 });
    expect(bounded.value.iterations).toBe(1);
    expect(bounded.value.converged).toBe(false);
    expect(bounded.meta.truncated).toBe(true);
  });

  it("skips self loops and rejects invalid bounds, unknown kinds, and aborts", () => {
    const registry = selfLoopRegistry();
    const graph = new RelationshipGraph(
      ["pm-a", "pm-b"],
      [
        { source: "pm-a", target: "pm-a", kind: "retries" },
        { source: "pm-a", target: "pm-b", kind: "retries" },
      ],
      registry,
    );
    expect(detectRelationshipCommunities(graph).value.communities).toEqual([
      { representative: "pm-a", size: 2, members: ["pm-a", "pm-b"] },
    ]);
    expect(() =>
      detectRelationshipCommunities(graph, { maxIterations: 0 }),
    ).toThrow(/Invalid maxIterations bound/);
    expect(() =>
      detectRelationshipCommunities(graph, { minSize: 1.5 }),
    ).toThrow(/Invalid minSize bound/);
    expect(() =>
      detectRelationshipCommunities(graph, { kinds: ["nope"] }),
    ).toThrow(/Unknown relationship kind/);
    expect(() =>
      detectRelationshipCommunities(graph, { signal: AbortSignal.abort() }),
    ).toThrow(/aborted/i);
  });
});

describe("findRedundantRelationshipEdges", () => {
  it("finds ordering edges implied by same-family chains across inverse spellings", () => {
    const graph = RelationshipGraph.fromItems([
      {
        id: "pm-a",
        dependencies: [dep("pm-b", "blocked_by"), dep("pm-c", "blocked_by")],
      },
      { id: "pm-b", dependencies: [dep("pm-c", "blocked_by")] },
      { id: "pm-c", dependencies: [dep("pm-d", "blocks")] },
      { id: "pm-d" },
    ]);
    const result = findRedundantRelationshipEdges(graph);
    expect(result.meta.truncated).toBe(false);
    expect(result.value).toHaveLength(1);
    const finding = result.value[0]!;
    expect(finding.edge).toMatchObject({
      source: "pm-a",
      target: "pm-c",
      kind: "blocked_by",
    });
    // Witness runs in semantic predecessor -> successor orientation.
    expect(finding.witness).toEqual(["pm-c", "pm-b", "pm-a"]);
  });

  it("finds hierarchy shortcut edges through mixed parent/child spellings", () => {
    // pm-root -child-> pm-mid stores the inverse spelling (source_parent), so
    // the family orientation must flip it into the same child -> parent flow
    // as the leaf's parent edges.
    const graph = RelationshipGraph.fromItems([
      {
        id: "pm-leaf",
        parent: "pm-mid",
        dependencies: [dep("pm-root", "parent")],
      },
      { id: "pm-mid" },
      { id: "pm-root", dependencies: [dep("pm-mid", "child")] },
    ]);
    const result = findRedundantRelationshipEdges(graph, { kinds: ["parent"] });
    expect(result.value).toHaveLength(1);
    expect(result.value[0]!.edge).toMatchObject({
      source: "pm-leaf",
      target: "pm-root",
      kind: "parent",
    });
    expect(result.value[0]!.witness).toEqual(["pm-leaf", "pm-mid", "pm-root"]);
  });

  it("does not treat a stored inverse duplicate as its own witness", () => {
    const graph = RelationshipGraph.fromItems([
      { id: "pm-a", dependencies: [dep("pm-b", "blocked_by")] },
      { id: "pm-b", dependencies: [dep("pm-a", "blocks")] },
    ]);
    expect(findRedundantRelationshipEdges(graph).value).toEqual([]);
  });

  it("honors depth and row limits with explicit truncation", () => {
    const chain = [
      { id: "pm-1", dependencies: [dep("pm-2", "blocked_by"), dep("pm-4", "blocked_by")] },
      { id: "pm-2", dependencies: [dep("pm-3", "blocked_by")] },
      { id: "pm-3", dependencies: [dep("pm-4", "blocked_by")] },
      { id: "pm-4", dependencies: [dep("pm-5", "blocked_by")] },
      { id: "pm-5" },
      { id: "pm-6", dependencies: [dep("pm-7", "blocked_by"), dep("pm-8", "blocked_by")] },
      { id: "pm-7", dependencies: [dep("pm-8", "blocked_by")] },
      { id: "pm-8" },
    ];
    const graph = RelationshipGraph.fromItems(chain);
    const all = findRedundantRelationshipEdges(graph);
    expect(all.value).toHaveLength(2);
    const shallow = findRedundantRelationshipEdges(graph, { maxDepth: 1 });
    expect(shallow.value).toEqual([]);
    const limited = findRedundantRelationshipEdges(graph, { limit: 1 });
    expect(limited.value).toHaveLength(1);
    expect(limited.meta.truncated).toBe(true);
  });

  it("skips self loops and validates kinds, bounds, and aborts", () => {
    const registry = selfLoopRegistry();
    const graph = new RelationshipGraph(
      ["pm-a", "pm-b"],
      [
        { source: "pm-a", target: "pm-a", kind: "retries" },
        { source: "pm-a", target: "pm-b", kind: "retries" },
      ],
      registry,
    );
    expect(findRedundantRelationshipEdges(graph).value).toEqual([]);
    const itemsGraph = RelationshipGraph.fromItems([
      { id: "pm-a", dependencies: [dep("pm-b", "related")] },
      { id: "pm-b" },
    ]);
    expect(
      findRedundantRelationshipEdges(itemsGraph, { kinds: ["blocked_by"] })
        .value,
    ).toEqual([]);
    expect(() =>
      findRedundantRelationshipEdges(itemsGraph, { kinds: ["related"] }),
    ).toThrow(/not a directed ordering or hierarchy kind/);
    expect(() =>
      findRedundantRelationshipEdges(itemsGraph, { maxDepth: 0 }),
    ).toThrow(/Invalid maxDepth bound/);
    expect(() =>
      findRedundantRelationshipEdges(itemsGraph, { limit: -1 }),
    ).toThrow(/Invalid limit bound/);
    const ordered = RelationshipGraph.fromItems([
      { id: "pm-a", dependencies: [dep("pm-b", "blocked_by")] },
      { id: "pm-b" },
    ]);
    expect(() =>
      findRedundantRelationshipEdges(ordered, {
        signal: AbortSignal.abort(),
      }),
    ).toThrow(/aborted/i);
  });
});

describe("computeRelationshipDominators", () => {
  it("computes immediate dominators and gating weights over a diamond", () => {
    const graph = RelationshipGraph.fromItems([
      { id: "pm-root", dependencies: [dep("pm-a", "blocked_by"), dep("pm-b", "blocked_by")] },
      { id: "pm-a", dependencies: [dep("pm-gate", "blocked_by")] },
      { id: "pm-b", dependencies: [dep("pm-gate", "blocked_by")] },
      { id: "pm-gate", dependencies: [dep("pm-deep", "blocked_by")] },
      { id: "pm-deep" },
      { id: "pm-unreachable" },
    ]);
    const result = computeRelationshipDominators(graph, "pm-root", {
      direction: "outgoing",
      kinds: ["blocked_by"],
    });
    expect(result.value.reachableCount).toBe(5);
    expect(result.meta.truncated).toBe(false);
    expect(result.value.rows).toEqual([
      { id: "pm-gate", idom: "pm-root", dominatedCount: 1 },
      { id: "pm-a", idom: "pm-root", dominatedCount: 0 },
      { id: "pm-b", idom: "pm-root", dominatedCount: 0 },
      { id: "pm-deep", idom: "pm-gate", dominatedCount: 0 },
    ]);
  });

  it("converges on cycles and honors direction filters", () => {
    const graph = RelationshipGraph.fromItems([
      { id: "pm-r", dependencies: [dep("pm-x", "blocked_by")] },
      { id: "pm-x", dependencies: [dep("pm-y", "blocked_by")] },
      { id: "pm-y", dependencies: [dep("pm-x", "blocked_by")] },
    ]);
    const outgoing = computeRelationshipDominators(graph, "pm-r", {
      direction: "outgoing",
    });
    expect(outgoing.value.reachableCount).toBe(3);
    expect(outgoing.value.rows).toEqual([
      { id: "pm-x", idom: "pm-r", dominatedCount: 1 },
      { id: "pm-y", idom: "pm-x", dominatedCount: 0 },
    ]);
    const incoming = computeRelationshipDominators(graph, "pm-r", {
      direction: "incoming",
    });
    expect(incoming.value.reachableCount).toBe(1);
    expect(incoming.value.rows).toEqual([]);
  });

  it("deduplicates parallel neighbors, skips self loops, and validates input", () => {
    const registry = selfLoopRegistry();
    const graph = new RelationshipGraph(
      ["pm-a", "pm-b"],
      [
        { source: "pm-a", target: "pm-a", kind: "retries" },
        { source: "pm-a", target: "pm-b", kind: "retries" },
      ],
      registry,
    );
    const result = computeRelationshipDominators(graph, "pm-a");
    expect(result.value.rows).toEqual([
      { id: "pm-b", idom: "pm-a", dominatedCount: 0 },
    ]);
    const parallel = RelationshipGraph.fromItems([
      {
        id: "pm-u",
        dependencies: [dep("pm-v", "blocked_by"), dep("pm-v", "related")],
      },
      { id: "pm-v" },
    ]);
    const both = computeRelationshipDominators(parallel, "pm-u", {
      direction: "both",
    });
    expect(both.value.reachableCount).toBe(2);
    expect(() => computeRelationshipDominators(graph, "pm-missing")).toThrow(
      /Relationship node not found/,
    );
    expect(() =>
      computeRelationshipDominators(graph, "pm-a", {
        signal: AbortSignal.abort(),
      }),
    ).toThrow(/aborted/i);
  });
});
