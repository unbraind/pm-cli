import { describe, expect, it } from "vitest";
import {
  enumerateRelationshipPaths,
  hierarchyAncestors,
  hierarchyDescendants,
  orderingPredecessors,
  orderingSuccessors,
} from "../../../../src/sdk/graph/traversal.js";
import {
  RelationshipGraph,
  RelationshipKindRegistry,
  type RelationshipEdge,
} from "../../../../src/sdk/relationships.js";

function itemGraph(
  items: Parameters<typeof RelationshipGraph.fromItems>[0],
): RelationshipGraph {
  return RelationshipGraph.fromItems(items);
}

const dep = (id: string, kind: string) => ({ id, kind });

describe("hierarchy traversal", () => {
  it("walks transitive ancestors and descendants over parent edges", () => {
    const graph = itemGraph([
      { id: "pm-epic" },
      { id: "pm-feature", parent: "pm-epic" },
      { id: "pm-task", parent: "pm-feature" },
      { id: "pm-unrelated" },
    ]);
    const ancestors = hierarchyAncestors(graph, "pm-task");
    expect(ancestors.value).toEqual(["pm-feature", "pm-epic"]);
    expect(ancestors.meta.truncated).toBe(false);
    expect(ancestors.meta.nextCursor).toBe("pm-epic");
    const descendants = hierarchyDescendants(graph, "pm-epic");
    expect(descendants.value).toEqual(["pm-feature", "pm-task"]);
    expect(hierarchyAncestors(graph, "pm-epic").value).toEqual([]);
    expect(hierarchyDescendants(graph, "pm-unrelated").value).toEqual([]);
  });

  it("honors a source_parent hierarchy kind so inverse spellings agree", () => {
    const registry = new RelationshipKindRegistry();
    registry.register({
      kind: "owns",
      direction: "directed",
      ordering: false,
      hierarchy: true,
      hierarchyDirection: "source_parent",
      outgoing: "many",
      incoming: "one",
      lifecycle: "persistent",
      compatibilityVersion: 1,
      allowSelf: false,
    });
    const graph = new RelationshipGraph(
      ["pm-root", "pm-leaf"],
      [{ source: "pm-root", target: "pm-leaf", kind: "owns" }],
      registry,
    );
    expect(hierarchyAncestors(graph, "pm-leaf").value).toEqual(["pm-root"]);
    expect(hierarchyDescendants(graph, "pm-root").value).toEqual(["pm-leaf"]);
  });

  it("defaults a custom hierarchy kind without a declared direction to source parent", () => {
    const registry = new RelationshipKindRegistry();
    registry.register({
      kind: "contains",
      direction: "directed",
      ordering: false,
      hierarchy: true,
      outgoing: "many",
      incoming: "one",
      lifecycle: "persistent",
      compatibilityVersion: 1,
      allowSelf: false,
    });
    const graph = new RelationshipGraph(
      ["pm-a", "pm-b"],
      [{ source: "pm-a", target: "pm-b", kind: "contains" }],
      registry,
    );
    expect(hierarchyAncestors(graph, "pm-b").value).toEqual(["pm-a"]);
    expect(hierarchyDescendants(graph, "pm-a").value).toEqual(["pm-b"]);
  });

  it("restricts the walk to the requested hierarchy kinds", () => {
    const graph = itemGraph([
      { id: "pm-epic" },
      { id: "pm-task", parent: "pm-epic" },
    ]);
    expect(
      hierarchyAncestors(graph, "pm-task", { kinds: ["parent"] }).value,
    ).toEqual(["pm-epic"]);
    expect(() =>
      hierarchyAncestors(graph, "pm-task", { kinds: ["related"] }),
    ).toThrow(/not a hierarchy kind/);
    expect(() =>
      hierarchyAncestors(graph, "pm-task", { kinds: ["nope"] }),
    ).toThrow(/Unknown relationship kind/);
  });
});

describe("ordering traversal", () => {
  it("walks execution predecessors and successors over blocked_by edges", () => {
    const graph = itemGraph([
      { id: "pm-a", dependencies: [dep("pm-b", "blocked_by")] },
      { id: "pm-b", dependencies: [dep("pm-c", "blocked_by")] },
      { id: "pm-c" },
    ]);
    expect(orderingPredecessors(graph, "pm-a").value).toEqual([
      "pm-b",
      "pm-c",
    ]);
    expect(orderingSuccessors(graph, "pm-c").value).toEqual(["pm-b", "pm-a"]);
    expect(orderingPredecessors(graph, "pm-c").value).toEqual([]);
  });

  it("agrees across inverse ordering spellings and custom default precedence", () => {
    const registry = new RelationshipKindRegistry();
    registry.register({
      kind: "then",
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
      ["pm-first", "pm-second", "pm-third"],
      [
        // blocks: source must finish before target.
        { source: "pm-first", target: "pm-second", kind: "blocks" },
        // custom kind without precedence defaults to source_before_target.
        { source: "pm-second", target: "pm-third", kind: "then" },
      ],
      registry,
    );
    expect(orderingPredecessors(graph, "pm-third").value).toEqual([
      "pm-second",
      "pm-first",
    ]);
    expect(orderingSuccessors(graph, "pm-first").value).toEqual([
      "pm-second",
      "pm-third",
    ]);
    expect(
      orderingPredecessors(graph, "pm-third", { kinds: ["then"] }).value,
    ).toEqual(["pm-second"]);
    expect(() =>
      orderingPredecessors(graph, "pm-third", { kinds: ["parent"] }),
    ).toThrow(/not a ordering kind/);
  });

  it("ignores non-ordering edges during ordering walks", () => {
    const graph = itemGraph([
      { id: "pm-a", dependencies: [dep("pm-b", "related")] },
      { id: "pm-b" },
    ]);
    expect(orderingPredecessors(graph, "pm-a").value).toEqual([]);
    expect(orderingSuccessors(graph, "pm-a").value).toEqual([]);
  });
});

describe("bounded traversal controls", () => {
  const chain = itemGraph([
    { id: "pm-1", dependencies: [dep("pm-2", "blocked_by")] },
    { id: "pm-2", dependencies: [dep("pm-3", "blocked_by")] },
    { id: "pm-3", dependencies: [dep("pm-4", "blocked_by")] },
    { id: "pm-4" },
  ]);

  it("truncates at the limit and resumes deterministically from the cursor", () => {
    const firstPage = orderingPredecessors(chain, "pm-1", { limit: 2 });
    expect(firstPage.value).toEqual(["pm-2", "pm-3"]);
    expect(firstPage.meta.truncated).toBe(true);
    expect(firstPage.meta.nextCursor).toBe("pm-3");
    const secondPage = orderingPredecessors(chain, "pm-1", {
      after: firstPage.meta.nextCursor,
    });
    expect(secondPage.value).toEqual(["pm-4"]);
    expect(secondPage.meta.truncated).toBe(false);
  });

  it("fails fast when the resume cursor never appears in the sequence", () => {
    expect(() =>
      orderingPredecessors(chain, "pm-1", { after: "pm-nope" }),
    ).toThrow(/Traversal cursor not found in sequence: pm-nope/);
  });

  it("reports truncation when maxDepth stops the walk early", () => {
    const bounded = orderingPredecessors(chain, "pm-1", { maxDepth: 1 });
    expect(bounded.value).toEqual(["pm-2"]);
    expect(bounded.meta.truncated).toBe(true);
  });

  it("rejects unknown start nodes and honors abort signals", () => {
    expect(() => orderingPredecessors(chain, "pm-nope")).toThrow(
      /Relationship node not found: pm-nope/,
    );
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      orderingPredecessors(chain, "pm-1", { signal: controller.signal }),
    ).toThrow();
  });

  it("deduplicates semantic neighbors and terminates ordering cycles", () => {
    const registry = new RelationshipKindRegistry();
    registry.register({
      kind: "requires",
      direction: "directed",
      ordering: true,
      hierarchy: false,
      outgoing: "many",
      incoming: "many",
      lifecycle: "persistent",
      compatibilityVersion: 1,
      allowSelf: false,
      precedence: "target_before_source",
    });
    const graph = new RelationshipGraph(
      ["pm-a", "pm-b"],
      [
        { source: "pm-a", target: "pm-b", kind: "blocked_by" },
        { source: "pm-a", target: "pm-b", kind: "requires" },
        { source: "pm-b", target: "pm-a", kind: "blocked_by" },
      ],
      registry,
    );
    expect(orderingPredecessors(graph, "pm-a").value).toEqual(["pm-b"]);
    expect(orderingPredecessors(graph, "pm-a", { maxDepth: 1 })).toMatchObject({
      value: ["pm-b"],
      meta: { truncated: false },
    });
  });
});

describe("enumerateRelationshipPaths", () => {
  const diamond = itemGraph([
    { id: "pm-src", dependencies: [dep("pm-mid1", "blocked_by"), dep("pm-mid2", "blocked_by")] },
    { id: "pm-mid1", dependencies: [dep("pm-dst", "blocked_by")] },
    { id: "pm-mid2", dependencies: [dep("pm-dst", "blocked_by")] },
    { id: "pm-dst" },
  ]);

  it("enumerates simple paths shortest-first with edge evidence", () => {
    const paths = enumerateRelationshipPaths(diamond, "pm-src", "pm-dst");
    expect(paths.value.map((path) => path.nodes)).toEqual([
      ["pm-src", "pm-mid1", "pm-dst"],
      ["pm-src", "pm-mid2", "pm-dst"],
    ]);
    expect(paths.value[0]!.length).toBe(2);
    expect(
      paths.value[0]!.edges.map((edge: RelationshipEdge) => edge.kind),
    ).toEqual(["blocked_by", "blocked_by"]);
    expect(paths.meta.truncated).toBe(false);
  });

  it("returns the zero-length path for identical endpoints", () => {
    const paths = enumerateRelationshipPaths(diamond, "pm-src", "pm-src");
    expect(paths.value).toEqual([{ nodes: ["pm-src"], edges: [], length: 0 }]);
  });

  it("returns no paths for disconnected endpoints", () => {
    const paths = enumerateRelationshipPaths(diamond, "pm-dst", "pm-src");
    expect(paths.value).toEqual([]);
    expect(paths.meta.truncated).toBe(false);
  });

  it("truncates on maxPaths, maxDepth, and maxVisitedPaths bounds", () => {
    const capped = enumerateRelationshipPaths(diamond, "pm-src", "pm-dst", {
      maxPaths: 1,
    });
    expect(capped.value).toHaveLength(1);
    expect(capped.meta.truncated).toBe(true);
    const tooShallow = enumerateRelationshipPaths(diamond, "pm-src", "pm-dst", {
      maxDepth: 1,
    });
    expect(tooShallow.value).toEqual([]);
    expect(tooShallow.meta.truncated).toBe(true);
    const starved = enumerateRelationshipPaths(diamond, "pm-src", "pm-dst", {
      maxVisitedPaths: 1,
    });
    expect(starved.meta.truncated).toBe(true);
  });

  it("honors direction and kind filters", () => {
    const paths = enumerateRelationshipPaths(diamond, "pm-dst", "pm-src", {
      direction: "incoming",
    });
    expect(paths.value.length).toBeGreaterThan(0);
    const none = enumerateRelationshipPaths(diamond, "pm-src", "pm-dst", {
      kinds: ["related"],
    });
    expect(none.value).toEqual([]);
  });

  it("rejects unknown endpoints and honors abort signals", () => {
    expect(() =>
      enumerateRelationshipPaths(diamond, "pm-nope", "pm-dst"),
    ).toThrow(/Relationship node not found: pm-nope/);
    expect(() =>
      enumerateRelationshipPaths(diamond, "pm-src", "pm-nope"),
    ).toThrow(/Relationship node not found: pm-nope/);
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      enumerateRelationshipPaths(diamond, "pm-src", "pm-dst", {
        signal: controller.signal,
      }),
    ).toThrow();
  });

  it("skips cycle-producing partial paths during simple-path enumeration", () => {
    const graph = itemGraph([
      { id: "pm-a", dependencies: [dep("pm-b", "blocked_by")] },
      { id: "pm-b", dependencies: [dep("pm-a", "blocked_by")] },
      { id: "pm-unreachable" },
    ]);
    expect(
      enumerateRelationshipPaths(graph, "pm-a", "pm-unreachable", {
        direction: "outgoing",
      }).value,
    ).toEqual([]);
  });
});
