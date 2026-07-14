import { describe, expect, it } from "vitest";
import {
  RelationshipEventLog,
  RelationshipGraph,
  RelationshipKindRegistry,
  analyzeGraphImpact,
  analyzeKnowledgeGraph,
  analyzeRelationshipExecution,
  buildRelationshipContext,
  compareRelationshipSnapshots,
  createRelationshipKindRegistry,
} from "../../../src/sdk/index.js";

const nodes = ["design", "build", "test", "ship", "note"];

describe("relationship event history", () => {
  it("appends attributable events and replays immutable snapshots", () => {
    const log = new RelationshipEventLog(nodes);
    const design = log.append({
      eventId: "evt-1",
      relationshipId: "rel-build-design",
      action: "add",
      edge: { source: "build", target: "design", kind: "blocked_by" },
      author: "planner",
      timestamp: "2026-07-14T08:00:00.000Z",
      expectedVersion: 0,
    });
    const test = log.append({
      eventId: "evt-2",
      relationshipId: "rel-test-build",
      action: "add",
      edge: { source: "test", target: "build", kind: "blocked_by" },
      author: "builder",
      timestamp: "2026-07-14T09:00:00.000Z",
      expectedVersion: 1,
    });
    log.append({
      eventId: "evt-3",
      relationshipId: "rel-test-build",
      action: "supersede",
      edge: { source: "ship", target: "test", kind: "blocked_by" },
      author: "release-agent",
      timestamp: "2026-07-14T10:00:00.000Z",
      expectedVersion: 2,
      reason: "replace the delivery edge",
    });
    log.append({
      eventId: "evt-4",
      relationshipId: "rel-build-design",
      action: "remove",
      author: "planner",
      timestamp: "2026-07-14T11:00:00.000Z",
      expectedVersion: 3,
    });

    expect(design).toMatchObject({ sequence: 1, action: "add" });
    expect(Object.isFrozen(design.edge)).toBe(true);
    expect(test.sequence).toBe(2);
    expect(log.version).toBe(4);
    expect(log.snapshot({ atVersion: 2 }).edges).toEqual([
      expect.objectContaining({ source: "build", target: "design" }),
      expect.objectContaining({ source: "test", target: "build" }),
    ]);
    expect(
      log.snapshot({ atTimestamp: "2026-07-14T10:30:00.000Z" }).edges,
    ).toEqual([
      expect.objectContaining({ source: "build", target: "design" }),
      expect.objectContaining({ source: "ship", target: "test" }),
    ]);
    expect(log.snapshot().edges).toEqual([
      expect.objectContaining({ source: "ship", target: "test" }),
    ]);
    expect(log.events()).toHaveLength(4);
  });

  it("paginates a stable event stream and rejects unsafe mutations", () => {
    const log = new RelationshipEventLog(nodes);
    log.append({
      eventId: "evt-a",
      relationshipId: "rel-a",
      action: "add",
      edge: { source: "build", target: "design", kind: "blocked_by" },
      author: "agent",
      timestamp: "2026-07-14T08:00:00.000Z",
    });
    log.append({
      eventId: "evt-b",
      relationshipId: "rel-b",
      action: "add",
      edge: { source: "test", target: "build", kind: "blocked_by" },
      author: "agent",
      timestamp: "2026-07-14T09:00:00.000Z",
    });
    const first = log.page({ limit: 1 });
    expect(first).toMatchObject({ version: 2, hasMore: true });
    expect(first.events.map(({ eventId }) => eventId)).toEqual(["evt-a"]);
    expect(
      log
        .page({ limit: 1, cursor: first.nextCursor })
        .events.map(({ eventId }) => eventId),
    ).toEqual(["evt-b"]);

    expect(() =>
      log.append({
        eventId: "evt-c",
        relationshipId: "rel-c",
        action: "add",
        edge: { source: "ship", target: "test", kind: "blocked_by" },
        author: "agent",
        timestamp: "bad timestamp",
        expectedVersion: 1,
      }),
    ).toThrow("version conflict");
    expect(() =>
      log.append({
        eventId: "evt-a",
        relationshipId: "rel-c",
        action: "add",
        edge: { source: "ship", target: "test", kind: "blocked_by" },
        author: "agent",
        timestamp: "bad timestamp",
      }),
    ).toThrow("event already exists");
    expect(() =>
      log.append({
        eventId: "evt-c",
        relationshipId: "missing",
        action: "remove",
        author: "agent",
        timestamp: "2026-07-14T10:00:00.000Z",
      }),
    ).toThrow("not active");
  });

  it("enforces registered cardinality and custom payload semantics", () => {
    const registry = new RelationshipKindRegistry([]).register({
      kind: "owns",
      inverse: "owned_by",
      direction: "directed",
      ordering: false,
      hierarchy: true,
      outgoing: "many",
      incoming: "one",
      lifecycle: "supersedable",
      compatibilityVersion: 1,
      allowSelf: false,
      payloadSchema: { type: "object" },
    });
    const log = new RelationshipEventLog(["company", "asset", "other"], {
      registry,
    });
    log.append({
      eventId: "own-1",
      relationshipId: "ownership-1",
      action: "add",
      edge: {
        source: "company",
        target: "asset",
        kind: "owns",
        payload: { votingShare: 0.8 },
      },
      author: "legal",
      timestamp: "2026-07-14T08:00:00.000Z",
    });
    expect(() =>
      log.append({
        eventId: "own-2",
        relationshipId: "ownership-2",
        action: "add",
        edge: { source: "other", target: "asset", kind: "owns" },
        author: "legal",
        timestamp: "2026-07-14T09:00:00.000Z",
      }),
    ).toThrow("incoming cardinality");
  });

  it("rejects malformed event, snapshot, paging, duplicate, and cardinality inputs", () => {
    const log = new RelationshipEventLog(["a", "b", "c"]);
    const valid = {
      eventId: "event-1",
      relationshipId: "relationship-1",
      action: "add" as const,
      edge: { source: "a", target: "b", kind: "blocked_by" },
      author: "agent",
      timestamp: "2026-07-14T08:00:00.000Z",
    };
    expect(() => log.append({ ...valid, eventId: " " })).toThrow("eventId");
    expect(() => log.append({ ...valid, author: "" })).toThrow("author");
    expect(() => log.append({ ...valid, timestamp: "invalid" })).toThrow(
      "timestamp",
    );
    expect(() => log.append({ ...valid, action: "rewrite" as never })).toThrow(
      "Unknown relationship event action",
    );
    expect(() => log.append({ ...valid, edge: undefined })).toThrow(
      "requires an edge",
    );
    log.append(valid);
    expect(() => log.append({ ...valid, eventId: "event-2" })).toThrow(
      "already active",
    );
    expect(() =>
      log.append({
        ...valid,
        eventId: "event-2",
        relationshipId: "relationship-2",
      }),
    ).toThrow("edge already active");
    expect(() =>
      log.snapshot({ atVersion: 0, atTimestamp: valid.timestamp }),
    ).toThrow("one target");
    expect(() => log.snapshot({ atTimestamp: "invalid" })).toThrow("timestamp");
    expect(() => log.snapshot({ atVersion: 2 })).toThrow("out of range");
    expect(() => log.page({ limit: 0 })).toThrow("limit must be positive");
    expect(new RelationshipEventLog([]).snapshot()).not.toHaveProperty("asOf");

    const hierarchy = new RelationshipEventLog(["a", "b", "c"]);
    hierarchy.append({
      ...valid,
      edge: { source: "a", target: "b", kind: "parent" },
    });
    expect(() =>
      hierarchy.append({
        ...valid,
        eventId: "event-2",
        relationshipId: "relationship-2",
        edge: { source: "a", target: "c", kind: "parent" },
      }),
    ).toThrow("outgoing cardinality");

    const undirected = new RelationshipEventLog(["a", "b"]);
    undirected.append({
      ...valid,
      edge: { source: "a", target: "b", kind: "related" },
    });
    expect(() =>
      undirected.append({
        ...valid,
        eventId: "event-2",
        relationshipId: "relationship-2",
        edge: { source: "b", target: "a", kind: "related" },
      }),
    ).toThrow("edge already active");
  });
});

describe("relationship graph analytics", () => {
  const graph = new RelationshipGraph(nodes, [
    { source: "build", target: "design", kind: "blocked_by" },
    { source: "test", target: "build", kind: "blocked_by" },
    { source: "ship", target: "test", kind: "blocked_by" },
    { source: "note", target: "build", kind: "related" },
  ]);

  it("derives exact execution layers, critical path, frontier, and depth", () => {
    expect(analyzeRelationshipExecution(graph)).toMatchObject({
      exact: true,
      acyclic: true,
      order: ["design", "note", "build", "test", "ship"],
      layers: [["design", "note"], ["build"], ["test"], ["ship"]],
      frontier: ["design", "note"],
      criticalPath: ["design", "build", "test", "ship"],
      criticalPathLength: 3,
      depth: { build: 1, design: 0, note: 0, ship: 3, test: 2 },
      cycles: [],
    });
  });

  it("reports ordering cycles separately from associative components", () => {
    const cyclic = new RelationshipGraph(
      ["a", "b", "c", "isolated"],
      [
        { source: "a", target: "b", kind: "blocked_by" },
        { source: "b", target: "a", kind: "blocked_by" },
        { source: "b", target: "c", kind: "related" },
      ],
    );
    expect(analyzeRelationshipExecution(cyclic)).toMatchObject({
      acyclic: false,
      cycles: [["a", "b"]],
    });
    expect(analyzeKnowledgeGraph(cyclic)).toMatchObject({
      components: [["a", "b", "c"], ["isolated"]],
      orphans: ["isolated"],
      hubs: [{ id: "b", degree: 2 }],
    });
  });

  it("returns bounded impact with explainable paths", () => {
    expect(
      analyzeGraphImpact(graph, "design", {
        direction: "incoming",
        kinds: ["blocked_by"],
        limit: 2,
      }),
    ).toMatchObject({
      root: "design",
      affected: [
        { id: "build", distance: 1, path: ["design", "build"] },
        { id: "test", distance: 2, path: ["design", "build", "test"] },
      ],
      exact: true,
      truncated: true,
    });
  });

  it("compares temporal snapshots without mutating either view", () => {
    const log = new RelationshipEventLog(nodes);
    log.append({
      eventId: "evt-1",
      relationshipId: "rel-1",
      action: "add",
      edge: { source: "build", target: "design", kind: "blocked_by" },
      author: "agent",
      timestamp: "2026-07-14T08:00:00.000Z",
    });
    const before = log.snapshot();
    log.append({
      eventId: "evt-2",
      relationshipId: "rel-2",
      action: "add",
      edge: { source: "test", target: "build", kind: "blocked_by" },
      author: "agent",
      timestamp: "2026-07-14T09:00:00.000Z",
    });
    expect(compareRelationshipSnapshots(before, log.snapshot())).toMatchObject({
      fromVersion: 1,
      toVersion: 2,
      added: [expect.objectContaining({ source: "test", target: "build" })],
      removed: [],
      unchangedCount: 1,
    });
    expect(before.edges).toHaveLength(1);
    log.append({
      eventId: "evt-3",
      relationshipId: "rel-1",
      action: "remove",
      author: "agent",
      timestamp: "2026-07-14T10:00:00.000Z",
    });
    expect(
      compareRelationshipSnapshots(
        log.snapshot({ atVersion: 2 }),
        log.snapshot(),
      ),
    ).toMatchObject({
      removed: [expect.objectContaining({ source: "build" })],
    });
  });

  it("covers empty graphs and deterministic equal-depth execution ties", () => {
    expect(analyzeRelationshipExecution(new RelationshipGraph([], []))).toEqual(
      {
        exact: true,
        acyclic: true,
        order: [],
        layers: [],
        frontier: [],
        depth: {},
        criticalPath: [],
        criticalPathLength: 0,
        cycles: [],
        provenance: { algorithm: "kahn-longest-path", edgeFamily: "ordering" },
      },
    );
    const registry = createRelationshipKindRegistry().register({
      kind: "precedes_default",
      direction: "directed",
      ordering: true,
      hierarchy: false,
      outgoing: "many",
      incoming: "many",
      lifecycle: "persistent",
      compatibilityVersion: 1,
      allowSelf: false,
    });
    const diamond = new RelationshipGraph(
      ["a", "b", "c", "d"],
      [
        { source: "a", target: "b", kind: "precedes_default" },
        { source: "a", target: "c", kind: "precedes_default" },
        { source: "b", target: "d", kind: "precedes_default" },
        { source: "c", target: "d", kind: "precedes_default" },
      ],
      registry,
    );
    expect(analyzeRelationshipExecution(diamond, { registry })).toMatchObject({
      criticalPath: ["a", "b", "d"],
      depth: { a: 0, b: 1, c: 1, d: 2 },
    });
    expect(analyzeKnowledgeGraph(diamond).components).toEqual([
      ["a", "b", "c", "d"],
    ]);
    expect(
      analyzeKnowledgeGraph(
        new RelationshipGraph(
          ["a", "b", "c"],
          [
            { source: "a", target: "b", kind: "discovered_from" },
            { source: "a", target: "c", kind: "discovered_from" },
            { source: "b", target: "c", kind: "discovered_from" },
          ],
        ),
      ).stronglyConnected,
    ).toEqual([["a"], ["b"], ["c"]]);
  });
});

describe("bounded relationship context", () => {
  const graph = new RelationshipGraph(nodes, [
    { source: "build", target: "design", kind: "blocked_by" },
    { source: "test", target: "build", kind: "blocked_by" },
    { source: "ship", target: "test", kind: "blocked_by" },
    { source: "note", target: "build", kind: "discovered_from" },
  ]);
  const details = nodes.map((id) => ({
    id,
    title: id.toUpperCase(),
    status: id === "design" ? "closed" : "open",
    evidence: id === "build" ? ["src/build.ts", "test:build"] : [],
  }));

  it("joins lineage, impact, reasons, evidence, and bounded cost in one call", () => {
    const result = buildRelationshipContext(graph, "build", details, {
      direction: "both",
      maxDepth: 2,
      nodeLimit: 3,
      edgeLimit: 4,
      tokenBudget: 220,
    });
    expect(result.root).toMatchObject({ id: "build", title: "BUILD" });
    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "design",
          distance: 1,
          reasons: expect.arrayContaining(["prerequisite"]),
        }),
        expect.objectContaining({
          id: "test",
          distance: 1,
          reasons: expect.arrayContaining(["dependent"]),
        }),
      ]),
    );
    expect(result.evidence).toEqual(["src/build.ts", "test:build"]);
    expect(result.meta).toMatchObject({
      exact: true,
      nodeLimit: 3,
      edgeLimit: 4,
      tokenBudget: 220,
    });
    expect(result.meta.usedTokens).toBeLessThanOrEqual(220);
  });

  it("continues deterministically and rejects a cursor from another query", () => {
    const first = buildRelationshipContext(graph, "build", details, {
      direction: "both",
      maxDepth: 3,
      nodeLimit: 1,
      tokenBudget: 500,
    });
    expect(first.meta.truncated).toBe(true);
    expect(first.meta.nextCursor).toBeTypeOf("string");
    const second = buildRelationshipContext(graph, "build", details, {
      direction: "both",
      maxDepth: 3,
      nodeLimit: 1,
      tokenBudget: 500,
      cursor: first.meta.nextCursor,
    });
    expect(second.nodes[0]?.id).not.toBe(first.nodes[0]?.id);
    expect(() =>
      buildRelationshipContext(graph, "ship", details, {
        cursor: first.meta.nextCursor,
      }),
    ).toThrow("does not match");
  });

  it("honors custom precedence instead of inferring semantics from labels", () => {
    const registry = createRelationshipKindRegistry().register({
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
    const custom = new RelationshipGraph(
      ["draft", "review", "publish"],
      [
        { source: "draft", target: "review", kind: "precedes" },
        { source: "review", target: "publish", kind: "precedes" },
      ],
      registry,
    );
    expect(analyzeRelationshipExecution(custom, { registry }).order).toEqual([
      "draft",
      "review",
      "publish",
    ]);
    expect(
      buildRelationshipContext(custom, "draft", [], { registry }).nodes[0],
    ).toMatchObject({ id: "review", reasons: ["dependent"] });
  });

  it("explains hierarchy, provenance, association, and deeper reachability", () => {
    const semantic = new RelationshipGraph(
      ["root", "parent", "child", "origin", "incident", "peer", "deep"],
      [
        { source: "root", target: "parent", kind: "parent" },
        { source: "child", target: "root", kind: "parent" },
        { source: "root", target: "origin", kind: "discovered_from" },
        { source: "root", target: "incident", kind: "incident_from" },
        { source: "root", target: "peer", kind: "related" },
        { source: "peer", target: "deep", kind: "related" },
      ],
    );
    const result = buildRelationshipContext(semantic, "root", [], {
      maxDepth: 2,
      nodeLimit: 10,
      edgeLimit: 10,
      tokenBudget: 1000,
    });
    expect(result.root).toEqual({ id: "root" });
    expect(result.evidence).toEqual([]);
    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "parent", reasons: ["ancestor"] }),
        expect.objectContaining({ id: "child", reasons: ["descendant"] }),
        expect.objectContaining({ id: "origin", reasons: ["provenance"] }),
        expect.objectContaining({ id: "incident", reasons: ["provenance"] }),
        expect.objectContaining({ id: "peer", reasons: ["related"] }),
        expect.objectContaining({
          id: "deep",
          reasons: ["reachable at depth 2"],
        }),
      ]),
    );
    expect(result.meta.truncated).toBe(false);
    expect(result.meta).not.toHaveProperty("nextCursor");
  });

  it("validates bounds, cancellation, missing roots, and truncation causes", () => {
    const chain = new RelationshipGraph(
      ["a", "b", "c"],
      [
        { source: "a", target: "b", kind: "related" },
        { source: "b", target: "c", kind: "related" },
      ],
    );
    expect(() => buildRelationshipContext(chain, "missing", [])).toThrow(
      "node not found",
    );
    expect(() =>
      buildRelationshipContext(chain, "a", [], { nodeLimit: 0 }),
    ).toThrow("nodeLimit must be positive");
    expect(() =>
      buildRelationshipContext(chain, "a", [], { maxDepth: -1 }),
    ).toThrow("maxDepth must be non-negative");
    expect(
      buildRelationshipContext(chain, "a", [], {
        maxDepth: 0,
        tokenBudget: 100,
      }).meta.truncated,
    ).toBe(true);
    expect(() =>
      buildRelationshipContext(chain, "a", [], { tokenBudget: 1 }),
    ).toThrow("cannot fit one node");
    expect(
      buildRelationshipContext(chain, "b", [], {
        edgeLimit: 1,
        tokenBudget: 1000,
      }).meta.omittedEdges,
    ).toBeGreaterThan(0);
    expect(
      buildRelationshipContext(
        new RelationshipGraph(
          ["a", "b"],
          [{ source: "a", target: "b", kind: "related" }],
        ),
        "a",
        [],
        { tokenBudget: 25 },
      ).meta.omittedEdges,
    ).toBe(1);
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      buildRelationshipContext(chain, "a", [], { signal: controller.signal }),
    ).toThrow();
    expect(
      buildRelationshipContext(new RelationshipGraph(["solo"], []), "solo", [])
        .meta.truncated,
    ).toBe(false);
  });
});
