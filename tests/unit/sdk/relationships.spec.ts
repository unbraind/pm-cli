import { describe, expect, it } from "vitest";
import {
  RelationshipGraph,
  RelationshipKindRegistry,
  createRelationshipKindRegistry,
  dependencyToRelationship,
  isOrderingRelationshipKind,
} from "../../../src/sdk/relationships.js";

describe("relationship kind registry", () => {
  it("normalizes built-in aliases and exposes immutable deterministic definitions", () => {
    const registry = createRelationshipKindRegistry();
    expect(registry.resolve("related-to")?.kind).toBe("related");
    expect(registry.resolve("depends_on")?.kind).toBe("blocked_by");
    expect(registry.resolve(null)).toBeUndefined();
    expect(registry.list().map(({ kind }) => kind)).toEqual(
      [...registry.list().map(({ kind }) => kind)].sort(),
    );
    expect(isOrderingRelationshipKind("blocks", registry)).toBe(true);
    expect(isOrderingRelationshipKind("related", registry)).toBe(false);
    expect(isOrderingRelationshipKind("unknown", registry)).toBe(false);
  });

  it("registers custom definitions and rejects invalid or colliding contracts", () => {
    const payloadSchema = {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
    };
    const registry = new RelationshipKindRegistry([]).register({
      kind: "owns",
      direction: "directed",
      inverse: "owned_by",
      ordering: false,
      hierarchy: true,
      outgoing: "many",
      incoming: "one",
      lifecycle: "supersedable",
      aliases: ["has_asset", "has_asset"],
      compatibilityVersion: 2,
      allowSelf: false,
      payloadSchema,
    });
    payloadSchema.properties.id.type = "number";
    expect(registry.require("has-asset").kind).toBe("owns");
    expect(registry.list()[0]!.payloadSchema).toEqual({
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
    });
    expect(Object.isFrozen(registry.list()[0]!.payloadSchema!.required)).toBe(
      true,
    );
    expect(
      Object.isFrozen(
        (registry.list()[0]!.payloadSchema!.properties as { id: object }).id,
      ),
    ).toBe(true);
    expect(() => registry.require("missing")).toThrow(
      "Unknown relationship kind",
    );
    expect(() => registry.register({ ...registry.require("owns") })).toThrow(
      "already registered",
    );
    expect(() =>
      new RelationshipKindRegistry([]).register({
        ...registry.require("owns"),
        kind: "9bad",
      }),
    ).toThrow("Invalid relationship kind");
    expect(() =>
      new RelationshipKindRegistry([]).register({
        ...registry.require("owns"),
        compatibilityVersion: 0,
      }),
    ).toThrow("Invalid compatibility version");
    expect(() =>
      new RelationshipKindRegistry([]).register({
        ...registry.require("owns"),
        aliases: ["owns"],
      }),
    ).toThrow("alias already registered");
    expect(() =>
      new RelationshipKindRegistry([]).register({
        ...registry.require("owns"),
        aliases: ["not valid"],
      }),
    ).toThrow("Invalid relationship alias");
    expect(
      new RelationshipKindRegistry([]).register({
        ...registry.require("owns"),
        kind: "contains",
        inverse: "Contained-By",
        aliases: [],
      }).require("contains").inverse,
    ).toBe("contained_by");
    expect(() =>
      new RelationshipKindRegistry([]).register({
        ...registry.require("owns"),
        kind: "contains",
        inverse: "not valid",
        aliases: [],
      }),
    ).toThrow("Invalid inverse relationship kind");
    const cyclicSchema: { self?: unknown } = {};
    cyclicSchema.self = cyclicSchema;
    const cyclicRegistry = new RelationshipKindRegistry([]).register({
      ...registry.require("owns"),
      kind: "cycles",
      aliases: [],
      payloadSchema: cyclicSchema,
    });
    expect(
      cyclicRegistry.require("cycles").payloadSchema?.self,
    ).toBe(cyclicRegistry.require("cycles").payloadSchema);
  });
});

describe("relationship graph", () => {
  const graph = new RelationshipGraph(
    ["a", "b", "c", "d", "e"],
    [
      { source: "a", target: "b", kind: "blocked_by" },
      { source: "b", target: "c", kind: "blocked_by" },
      { source: "c", target: "d", kind: "blocked_by" },
      { source: "a", target: "e", kind: "related_to" },
      { source: "e", target: "a", kind: "related" },
    ],
  );

  it("deduplicates undirected edges and provides directional adjacency", () => {
    expect(graph.edges()).toHaveLength(4);
    expect(graph.adjacency("a", { kinds: ["related"] }).value).toEqual(["e"]);
    expect(
      graph.adjacency("b", {
        direction: "incoming",
        kinds: ["blocked_by"],
      }).value,
    ).toEqual(["a"]);
    expect(graph.adjacency("a", { limit: 1 }).meta).toMatchObject({
      inspectedEdges: 2,
      truncated: true,
      nextCursor: "b",
    });
    expect(() => graph.adjacency("missing")).toThrow("node not found");
    expect(() => graph.adjacency("a", { kinds: ["missing"] })).toThrow(
      "Unknown relationship kind",
    );
  });

  it("computes bounded closure, reverse impact, shortest paths, and induced subgraphs", () => {
    expect(graph.closure("a", { kinds: ["blocked_by"] }).value).toEqual([
      "b",
      "c",
      "d",
    ]);
    expect(
      graph.closure("d", {
        direction: "incoming",
        kinds: ["blocked_by"],
      }).value,
    ).toEqual(["c", "b", "a"]);
    expect(
      graph.closure("a", { kinds: ["blocked_by"], maxDepth: 1 }).meta.truncated,
    ).toBe(true);
    expect(
      graph.closure("a", { kinds: ["blocked_by"], limit: 1 }),
    ).toMatchObject({
      value: ["b"],
      meta: { visitedNodes: 2, truncated: true },
    });
    expect(graph.closure("a", { limit: 1 }).meta.visitedNodes).toBe(1);
    expect(
      graph.shortestPath("a", "d", { kinds: ["blocked_by"] }).value,
    ).toEqual(["a", "b", "c", "d"]);
    expect(graph.shortestPath("a", "c").meta.visitedNodes).toBe(2);
    expect(graph.shortestPath("a", "a").value).toEqual(["a"]);
    expect(
      graph.shortestPath("d", "a", { kinds: ["blocked_by"] }).value,
    ).toEqual([]);
    expect(
      graph.shortestPath("a", "d", {
        kinds: ["blocked_by"],
        maxDepth: 2,
      }),
    ).toMatchObject({ value: [], meta: { truncated: true } });
    expect(
      graph.subgraph("a", { kinds: ["blocked_by"], limit: 2 }).value,
    ).toMatchObject({
      nodes: ["a", "b", "c"],
      edges: [
        expect.objectContaining({ kind: "blocked_by" }),
        expect.objectContaining({ kind: "blocked_by" }),
      ],
    });
    expect(graph.subgraph("d").value).toMatchObject({
      nodes: ["d"],
      edges: [],
    });
  });

  it("honors cancellation and validates graph construction", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => graph.adjacency("a", { signal: controller.signal })).toThrow();
    expect(() => graph.closure("a", { signal: controller.signal })).toThrow();
    expect(() =>
      graph.shortestPath("a", "d", { signal: controller.signal }),
    ).toThrow();
    expect(
      () =>
        new RelationshipGraph(
          ["a"],
          [{ source: "a", target: "b", kind: "related" }],
        ),
    ).toThrow("endpoint not found");
    expect(
      () =>
        new RelationshipGraph(
          ["a"],
          [{ source: "a", target: "a", kind: "related" }],
        ),
    ).toThrow("Self relationship");
    expect(
      () =>
        new RelationshipGraph(
          ["a", "b"],
          [{ source: "a", target: "b", kind: "unknown" }],
        ),
    ).toThrow("Unknown relationship kind");
    expect(
      () =>
        new RelationshipGraph(
          ["a", null] as never,
          [{ source: null, target: "a", kind: "related" }] as never,
        ),
    ).toThrow("endpoint not found");
    expect(
      () =>
        new RelationshipGraph(
          ["a"],
          [{ source: "a", target: null, kind: "related" }] as never,
        ),
    ).toThrow("endpoint not found");
  });

  it("keeps cyclic and parallel-edge traversal deterministic", () => {
    const cyclic = new RelationshipGraph(
      ["x", "y", "z"],
      [
        { source: "x", target: "y", kind: "blocked_by" },
        { source: "x", target: "y", kind: "discovered_from" },
        { source: "y", target: "x", kind: "blocked_by" },
        { source: "y", target: "z", kind: "related" },
      ],
    );
    expect(cyclic.edges()).toHaveLength(4);
    expect(cyclic.adjacency("x", { direction: "both" }).value).toEqual(["y"]);
    expect(
      cyclic.adjacency("y", { direction: "both", kinds: ["related"] }).meta
        .inspectedEdges,
    ).toBe(1);
    expect(cyclic.adjacency("y", { kinds: ["related"] }).value).toEqual(["z"]);
    expect(cyclic.closure("x", { kinds: ["blocked_by"] }).value).toEqual(["y"]);
    expect(
      cyclic.closure("x", { kinds: ["blocked_by"], maxDepth: 1 }).meta,
    ).toMatchObject({ inspectedEdges: 2, truncated: false });
    expect(cyclic.shortestPath("x", "z", { direction: "both" }).value).toEqual([
      "x",
      "y",
      "z",
    ]);
    expect(
      cyclic.shortestPath("x", "z", {
        kinds: ["blocked_by"],
        maxDepth: 1,
      }).meta.truncated,
    ).toBe(false);
    const oneWay = new RelationshipGraph(
      ["source", "target"],
      [{ source: "source", target: "target", kind: "blocked_by" }],
    );
    expect(oneWay.adjacency("source", { direction: "both" }).value).toEqual([
      "target",
    ]);
    expect(
      oneWay.adjacency("target", { direction: "both", kinds: ["blocks"] })
        .value,
    ).toEqual(["source"]);
    expect(oneWay.closure("target", { maxDepth: 0 }).meta.truncated).toBe(
      false,
    );
  });

  it("builds from item metadata and preserves dependency attribution", () => {
    const fromItems = RelationshipGraph.fromItems([
      {
        id: " a ",
        parent: " b ",
        blocked_by: " c ",
        dependencies: [
          {
            id: " d ",
            kind: "discovered_from",
            created_at: "2026-01-01T00:00:00.000Z",
            author: "agent",
          },
          { id: "d", kind: "custom_unknown", created_at: "now" },
          { id: "missing", kind: "related", created_at: "now" },
        ],
      },
      { id: "b" },
      { id: "c" },
      { id: "d" },
      { id: null, parent: true },
    ] as never);
    expect(fromItems.edges()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "a", target: "b", kind: "parent" }),
        expect.objectContaining({
          source: "a",
          target: "c",
          kind: "blocked_by",
        }),
        expect.objectContaining({
          source: "a",
          target: "d",
          kind: "discovered_from",
          author: "agent",
        }),
      ]),
    );
    expect(
      dependencyToRelationship("a", {
        id: "b",
        kind: "related_to",
        created_at: "now",
        author: "me",
      }),
    ).toEqual({
      source: "a",
      target: "b",
      kind: "related",
      createdAt: "now",
      author: "me",
    });
  });
});
