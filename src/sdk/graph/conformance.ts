/**
 * @module sdk/graph/conformance
 *
 * Public, sandbox-neutral fixtures and adapter conformance checks. Package
 * authors can run the same semantic contract against an in-memory adapter,
 * Neo4j, a remote service, or another durable graph backend.
 */
import {
  MemoryRelationshipGraphAdapter,
  createRelationshipGraphSnapshot,
  loadRelationshipGraphAdapter,
  syncRelationshipGraphAdapter,
  type RelationshipGraphAdapter,
} from "./adapter.js";
import {
  RelationshipGraph,
  createRelationshipKindRegistry,
  type RelationshipEdge,
} from "../relationships.js";

/** Supported deterministic scale-fixture topologies. */
export type RelationshipGraphScaleTopology = "chain" | "star" | "disconnected";

/** Controls for a lazy deterministic graph scale fixture. */
export interface RelationshipGraphScaleFixtureOptions {
  /** Number of nodes yielded by the fixture. */
  nodeCount: number;
  /** Shape of generated edges. */
  topology?: RelationshipGraphScaleTopology;
  /** Registered relationship kind used by generated edges. */
  kind?: string;
  /** Emit one edge per stride; large values model sparse million-node graphs. */
  edgeStride?: number;
  /** Stable node-id prefix. */
  idPrefix?: string;
}

/** Reusable lazy node/edge fixture plus exact cardinalities. */
export interface RelationshipGraphScaleFixture {
  /** Exact node count. */
  node_count: number;
  /** Exact generated edge count. */
  edge_count: number;
  /** Reiterable lazy node identifiers. */
  nodes: Iterable<string>;
  /** Reiterable lazy relationship edges. */
  edges: Iterable<RelationshipEdge>;
}

/** Validate a positive integer fixture bound. */
function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1)
    throw new TypeError(
      `Relationship graph ${field} must be a positive integer`,
    );
  return value;
}

/** Create a lazy deterministic scale fixture without touching tracker storage. */
export function createRelationshipGraphScaleFixture(
  options: RelationshipGraphScaleFixtureOptions,
): RelationshipGraphScaleFixture {
  const nodeCount = positiveInteger(options.nodeCount, "nodeCount");
  const edgeStride = positiveInteger(options.edgeStride ?? 1, "edgeStride");
  const topology = options.topology ?? "chain";
  if (!["chain", "star", "disconnected"].includes(topology))
    throw new TypeError(`Unsupported relationship graph topology: ${topology}`);
  const kind = (options.kind ?? "related").trim();
  const idPrefix = (options.idPrefix ?? "node").trim();
  if (!kind || !idPrefix)
    throw new TypeError(
      "Relationship graph kind and idPrefix must be non-empty",
    );
  const edgeCount =
    topology === "disconnected" ? 0 : Math.floor((nodeCount - 1) / edgeStride);
  return {
    node_count: nodeCount,
    edge_count: edgeCount,
    nodes: {
      *[Symbol.iterator](): Iterator<string> {
        for (let index = 0; index < nodeCount; index += 1)
          yield `${idPrefix}-${index}`;
      },
    },
    edges: {
      *[Symbol.iterator](): Iterator<RelationshipEdge> {
        if (topology === "disconnected") return;
        for (let index = edgeStride; index < nodeCount; index += edgeStride)
          yield {
            source: `${idPrefix}-${topology === "star" ? 0 : index - edgeStride}`,
            target: `${idPrefix}-${index}`,
            kind,
          };
      },
    },
  };
}

/** One named conformance assertion completed against an adapter. */
export interface RelationshipGraphAdapterConformanceCase {
  /** Stable assertion identifier. */
  name: string;
  /** Successful case status. */
  passed: true;
}

/** Compact successful adapter-conformance report. */
export interface RelationshipGraphAdapterConformanceReport {
  /** Adapter identifier. */
  adapter: string;
  /** Isolated workspace key exercised by the run. */
  workspace: string;
  /** Completed semantic assertions. */
  cases: readonly RelationshipGraphAdapterConformanceCase[];
  /** Whether optional clear semantics were tested. */
  clear_supported: boolean;
}

/** Throw a precise conformance failure. */
function assertConformance(condition: boolean, message: string): void {
  if (!condition)
    throw new Error(`Relationship graph adapter conformance: ${message}`);
}

/**
 * Exercise empty reads, atomic replacement, isolated reads, idempotent sync,
 * compare-and-swap conflicts, replacement visibility, and optional clearing.
 */
export async function assertRelationshipGraphAdapterConformance(
  adapter: RelationshipGraphAdapter,
  options: { workspace?: string } = {},
): Promise<RelationshipGraphAdapterConformanceReport> {
  const workspace = options.workspace?.trim() || "pm-graph-conformance";
  const registry = createRelationshipKindRegistry();
  const first = createRelationshipGraphSnapshot(
    new RelationshipGraph(
      ["a", "b"],
      [{ source: "a", target: "b", kind: "related" }],
      registry,
    ),
    registry,
    { createdAt: "2026-01-01T00:00:00.000Z" },
  );
  const second = createRelationshipGraphSnapshot(
    new RelationshipGraph(
      ["a", "b", "c"],
      [
        { source: "a", target: "b", kind: "related" },
        { source: "b", target: "c", kind: "blocked_by" },
      ],
      registry,
    ),
    registry,
    { createdAt: "2026-01-02T00:00:00.000Z" },
  );
  const cases: RelationshipGraphAdapterConformanceCase[] = [];
  assertConformance(
    (await loadRelationshipGraphAdapter(adapter, { workspace })) === null,
    "workspace must start empty",
  );
  cases.push({ name: "empty-read", passed: true });
  const written = await syncRelationshipGraphAdapter(adapter, {
    workspace,
    snapshot: first,
  });
  assertConformance(written.disposition === "written", "first sync must write");
  cases.push({ name: "atomic-replace", passed: true });
  const isolated = (await adapter.read({ workspace })) as { nodes: string[] };
  isolated.nodes.push("mutated-reader-copy");
  assertConformance(
    (await loadRelationshipGraphAdapter(adapter, { workspace }))?.snapshot.nodes
      .length === 2,
    "reads must not mutate stored state",
  );
  cases.push({ name: "read-isolation", passed: true });
  assertConformance(
    (
      await syncRelationshipGraphAdapter(adapter, {
        workspace,
        snapshot: first,
      })
    ).disposition === "current",
    "identical sync must be idempotent",
  );
  cases.push({ name: "idempotent-sync", passed: true });
  await adapter.replace({
    workspace,
    snapshot: second,
    expected_fingerprint: first.fingerprint,
  });
  assertConformance(
    (await loadRelationshipGraphAdapter(adapter, { workspace }))?.snapshot
      .fingerprint === second.fingerprint,
    "replacement must become visible",
  );
  cases.push({ name: "replacement-visibility", passed: true });
  let conflict = false;
  try {
    await adapter.replace({
      workspace,
      snapshot: first,
      expected_fingerprint: first.fingerprint,
    });
  } catch {
    conflict = true;
  }
  assertConformance(conflict, "stale compare-and-swap must fail");
  cases.push({ name: "stale-cas", passed: true });
  if (adapter.clear) {
    await adapter.clear({
      workspace,
      expected_fingerprint: second.fingerprint,
    });
    assertConformance(
      (await loadRelationshipGraphAdapter(adapter, { workspace })) === null,
      "clear must remove the workspace",
    );
    cases.push({ name: "clear", passed: true });
  }
  return {
    adapter: adapter.name,
    workspace,
    cases: Object.freeze(cases),
    clear_supported: adapter.clear !== undefined,
  };
}

/** Run the public conformance contract against the built-in reference adapter. */
export function assertMemoryRelationshipGraphAdapterConformance(
  workspace?: string,
): Promise<RelationshipGraphAdapterConformanceReport> {
  return assertRelationshipGraphAdapterConformance(
    new MemoryRelationshipGraphAdapter(),
    workspace ? { workspace } : {},
  );
}
