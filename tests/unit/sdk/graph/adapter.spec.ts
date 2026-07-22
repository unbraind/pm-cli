import { describe, expect, it } from "vitest";
import {
  MemoryRelationshipGraphAdapter,
  assertMemoryRelationshipGraphAdapterConformance,
  assertRelationshipGraphAdapterConformance,
  createRelationshipGraphScaleFixture,
  createRelationshipGraphSnapshot,
  federateRelationshipGraphSnapshots,
  loadRelationshipGraphAdapter,
  parseRelationshipGraphSnapshot,
  syncRelationshipGraphAdapter,
  type RelationshipGraphAdapter,
  type RelationshipGraphSnapshot,
} from "../../../../src/sdk/graph/index.js";
import {
  RelationshipGraph,
  RelationshipKindRegistry,
  createRelationshipKindRegistry,
  type RelationshipKindDefinition,
} from "../../../../src/sdk/relationships.js";

function snapshot(
  nodes: readonly string[] = ["a", "b"],
  kind = "related",
): RelationshipGraphSnapshot {
  const registry = createRelationshipKindRegistry();
  return createRelationshipGraphSnapshot(
    new RelationshipGraph(
      nodes,
      nodes.length > 1 ? [{ source: nodes[0]!, target: nodes[1]!, kind }] : [],
      registry,
    ),
    registry,
    { createdAt: "2026-01-01T00:00:00Z" },
  );
}

describe("portable relationship graph adapters", () => {
  it("creates, parses, loads, synchronizes, and isolates portable snapshots", async () => {
    const value = snapshot();
    const parsed = parseRelationshipGraphSnapshot(value);
    expect(parsed.snapshot).toEqual(value);
    expect(parsed.graph.adjacency("a").value).toEqual(["b"]);
    expect(parsed.registry.require("related").direction).toBe("undirected");

    const adapter = new MemoryRelationshipGraphAdapter("portable-memory");
    expect(
      await loadRelationshipGraphAdapter(adapter, { workspace: "demo" }),
    ).toBeNull();
    const first = await syncRelationshipGraphAdapter(adapter, {
      workspace: "demo",
      snapshot: value,
    });
    expect(first).toMatchObject({
      adapter: "portable-memory",
      disposition: "written",
      node_count: 2,
      edge_count: 1,
    });
    const current = await syncRelationshipGraphAdapter(adapter, {
      workspace: "demo",
      snapshot: value,
    });
    expect(current).toMatchObject({
      disposition: "current",
      previous_fingerprint: value.fingerprint,
    });

    const raw = (await adapter.read({ workspace: "demo" }))!;
    (raw.nodes as string[]).push("reader-only");
    expect(
      (await loadRelationshipGraphAdapter(adapter, { workspace: "demo" }))!
        .snapshot.nodes,
    ).toEqual(["a", "b"]);

    const replacement = snapshot(["a", "b", "c"]);
    const replaced = await syncRelationshipGraphAdapter(adapter, {
      workspace: "demo",
      snapshot: replacement,
    });
    expect(replaced).toMatchObject({
      disposition: "written",
      previous_fingerprint: value.fingerprint,
      fingerprint: replacement.fingerprint,
    });
    await expect(
      adapter.replace({
        workspace: "demo",
        snapshot: value,
        expected_fingerprint: value.fingerprint,
      }),
    ).rejects.toThrow("adapter conflict");
    await expect(
      adapter.clear!({
        workspace: "demo",
        expected_fingerprint: value.fingerprint,
      }),
    ).rejects.toThrow("adapter conflict");
    await adapter.clear!({
      workspace: "demo",
      expected_fingerprint: replacement.fingerprint,
    });
    expect(await adapter.read({ workspace: "demo" })).toBeNull();
  });

  it("rejects malformed, unsupported, corrupt, or semantically invalid snapshots", () => {
    const value = snapshot();
    expect(
      createRelationshipGraphSnapshot(
        new RelationshipGraph([], []),
        createRelationshipKindRegistry(),
      ).created_at,
    ).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(() => parseRelationshipGraphSnapshot(null)).toThrow(
      "must be an object",
    );
    expect(() =>
      parseRelationshipGraphSnapshot({ ...value, version: 2 }),
    ).toThrow("Unsupported");
    expect(() =>
      parseRelationshipGraphSnapshot({ ...value, nodes: [1] }),
    ).toThrow("nodes must be strings");
    expect(() =>
      parseRelationshipGraphSnapshot({ ...value, edges: null }),
    ).toThrow("edges and kinds must be arrays");
    expect(() =>
      parseRelationshipGraphSnapshot({ ...value, kinds: null }),
    ).toThrow("edges and kinds must be arrays");
    expect(() =>
      parseRelationshipGraphSnapshot({ ...value, created_at: "invalid" }),
    ).toThrow("created_at must be valid");
    expect(() =>
      parseRelationshipGraphSnapshot({ ...value, fingerprint: 1 }),
    ).toThrow("fingerprint must be a string");
    expect(() =>
      parseRelationshipGraphSnapshot({ ...value, fingerprint: "0".repeat(64) }),
    ).toThrow("fingerprint mismatch");
    expect(() =>
      parseRelationshipGraphSnapshot({
        ...value,
        edges: [{ source: "a", target: "missing", kind: "related" }],
      }),
    ).toThrow("endpoint not found");
    expect(() =>
      createRelationshipGraphSnapshot(
        new RelationshipGraph([], []),
        createRelationshipKindRegistry(),
        { createdAt: "not-a-date" },
      ),
    ).toThrow("createdAt must be a valid timestamp");
  });

  it("honors validation and cooperative cancellation on every memory operation", async () => {
    expect(() => new MemoryRelationshipGraphAdapter(" ")).toThrow(
      "adapter name must be non-empty",
    );
    const adapter = new MemoryRelationshipGraphAdapter();
    await expect(adapter.read({ workspace: " " })).rejects.toThrow(
      "workspace must be non-empty",
    );
    await expect(
      loadRelationshipGraphAdapter(
        { ...adapter, name: " " },
        { workspace: "x" },
      ),
    ).rejects.toThrow("adapter name must be non-empty");
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(
      adapter.read({ workspace: "x", signal: controller.signal }),
    ).rejects.toThrow("stop");
    await expect(
      adapter.replace({
        workspace: "x",
        signal: controller.signal,
        snapshot: snapshot(),
      }),
    ).rejects.toThrow("stop");
    await expect(
      adapter.clear!({ workspace: "x", signal: controller.signal }),
    ).rejects.toThrow("stop");
    await expect(
      adapter.clear!({ workspace: "missing", expected_fingerprint: "stale" }),
    ).rejects.toThrow("adapter conflict");
  });

  it("detects adapters that do not expose a completed replacement", async () => {
    const broken: RelationshipGraphAdapter = {
      name: "broken",
      async read() {
        return null;
      },
      async replace() {},
    };
    await expect(
      syncRelationshipGraphAdapter(broken, {
        workspace: "demo",
        snapshot: snapshot(),
      }),
    ).rejects.toThrow("did not expose");
  });

  it("federates compatible snapshots and rejects ontology collisions", () => {
    const first = snapshot(["a", "b"]);
    const second = snapshot(["b", "c"]);
    const federated = federateRelationshipGraphSnapshots([first, second], {
      createdAt: "2026-02-01T00:00:00Z",
    });
    expect(federated.nodes).toEqual(["a", "b", "c"]);
    expect(federated.edges).toHaveLength(2);
    expect(
      parseRelationshipGraphSnapshot(federated).graph.adjacency("b").value,
    ).toEqual(["a", "c"]);

    const definitions = [...first.kinds];
    const relatedIndex = definitions.findIndex(
      (entry) => entry.kind === "related",
    );
    definitions[relatedIndex] = {
      ...definitions[relatedIndex]!,
      allowSelf: true,
    };
    const conflictingRegistry = new RelationshipKindRegistry(
      definitions as RelationshipKindDefinition[],
    );
    const conflicting = createRelationshipGraphSnapshot(
      new RelationshipGraph(["d"], [], conflictingRegistry),
      conflictingRegistry,
      { createdAt: "2026-01-03T00:00:00Z" },
    );
    expect(() =>
      federateRelationshipGraphSnapshots([first, conflicting]),
    ).toThrow("Conflicting federated relationship kind: related");
  });

  it("publishes a reusable adapter conformance contract", async () => {
    const report =
      await assertMemoryRelationshipGraphAdapterConformance("contract");
    expect(report).toMatchObject({
      adapter: "memory",
      workspace: "contract",
      clear_supported: true,
    });
    expect(report.cases.map((entry) => entry.name)).toEqual([
      "empty-read",
      "atomic-replace",
      "read-isolation",
      "idempotent-sync",
      "replacement-visibility",
      "stale-cas",
      "clear",
    ]);

    const memory = new MemoryRelationshipGraphAdapter("without-clear");
    const withoutClear: RelationshipGraphAdapter = {
      name: memory.name,
      read: (context) => memory.read(context),
      replace: (context) => memory.replace(context),
    };
    const noClearReport =
      await assertRelationshipGraphAdapterConformance(withoutClear);
    expect(noClearReport.clear_supported).toBe(false);
    expect(noClearReport.cases.at(-1)?.name).toBe("stale-cas");

    const nonempty = new MemoryRelationshipGraphAdapter("nonempty");
    await nonempty.replace({
      workspace: "pm-graph-conformance",
      snapshot: snapshot(),
    });
    await expect(
      assertRelationshipGraphAdapterConformance(nonempty),
    ).rejects.toThrow("workspace must start empty");
    expect(
      (await assertMemoryRelationshipGraphAdapterConformance()).workspace,
    ).toBe("pm-graph-conformance");
  });
});

describe("relationship graph scale fixtures", () => {
  it("preserves snapshot identity across a deterministic topology property sweep", () => {
    const registry = createRelationshipKindRegistry();
    const topologies = ["chain", "star", "disconnected"] as const;

    for (let nodeCount = 1; nodeCount <= 32; nodeCount += 1) {
      for (const topology of topologies) {
        const edgeStride = (nodeCount % 5) + 1;
        const fixture = createRelationshipGraphScaleFixture({
          nodeCount,
          topology,
          edgeStride,
        });
        const nodes = [...fixture.nodes];
        const edges = [...fixture.edges];
        const canonical = createRelationshipGraphSnapshot(
          new RelationshipGraph(nodes, edges, registry),
          registry,
          { createdAt: "2026-01-01T00:00:00Z" },
        );
        const reordered = createRelationshipGraphSnapshot(
          new RelationshipGraph(
            nodes.toReversed(),
            edges.toReversed(),
            registry,
          ),
          registry,
          { createdAt: "2026-01-02T00:00:00Z" },
        );

        expect(reordered.fingerprint).toBe(canonical.fingerprint);
        expect(reordered.nodes).toEqual(canonical.nodes);
        expect(reordered.edges).toEqual(canonical.edges);
      }
    }
  });

  it("generates deterministic chain, star, disconnected, and sparse fixtures", () => {
    const chain = createRelationshipGraphScaleFixture({ nodeCount: 5 });
    expect([...chain.nodes]).toEqual([
      "node-0",
      "node-1",
      "node-2",
      "node-3",
      "node-4",
    ]);
    expect([...chain.edges]).toEqual([
      { source: "node-0", target: "node-1", kind: "related" },
      { source: "node-1", target: "node-2", kind: "related" },
      { source: "node-2", target: "node-3", kind: "related" },
      { source: "node-3", target: "node-4", kind: "related" },
    ]);
    const star = createRelationshipGraphScaleFixture({
      nodeCount: 6,
      topology: "star",
      edgeStride: 2,
      idPrefix: "item",
      kind: "implements",
    });
    expect(star.edge_count).toBe(2);
    expect([...star.edges]).toEqual([
      { source: "item-0", target: "item-2", kind: "implements" },
      { source: "item-0", target: "item-4", kind: "implements" },
    ]);
    const disconnected = createRelationshipGraphScaleFixture({
      nodeCount: 3,
      topology: "disconnected",
    });
    expect(disconnected.edge_count).toBe(0);
    expect([...disconnected.edges]).toEqual([]);
    expect(
      createRelationshipGraphScaleFixture({
        nodeCount: 1_000_000,
        edgeStride: 100,
      }).edge_count,
    ).toBe(9_999);
  });

  it("rejects invalid scale fixture controls", () => {
    expect(() => createRelationshipGraphScaleFixture({ nodeCount: 0 })).toThrow(
      "nodeCount must be a positive integer",
    );
    expect(() =>
      createRelationshipGraphScaleFixture({ nodeCount: 2, edgeStride: 0 }),
    ).toThrow("edgeStride must be a positive integer");
    expect(() =>
      createRelationshipGraphScaleFixture({
        nodeCount: 2,
        topology: "mesh" as "chain",
      }),
    ).toThrow("Unsupported relationship graph topology");
    expect(() =>
      createRelationshipGraphScaleFixture({ nodeCount: 2, kind: " " }),
    ).toThrow("kind and idPrefix must be non-empty");
    expect(() =>
      createRelationshipGraphScaleFixture({ nodeCount: 2, idPrefix: " " }),
    ).toThrow("kind and idPrefix must be non-empty");
  });
});
