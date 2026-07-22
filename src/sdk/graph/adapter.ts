/**
 * @module sdk/graph/adapter
 *
 * Portable relationship-graph snapshots and a storage-neutral adapter
 * protocol for package-owned databases, replicated logs, and remote graph
 * services. Snapshots are immutable, content-addressed, and validated through
 * the same registry and graph kernel as native pm queries.
 */
import { createHash } from "node:crypto";
import { stableStringify } from "../../core/shared/serialization.js";
import {
  RelationshipGraph,
  RelationshipKindRegistry,
  type RelationshipEdge,
  type RelationshipKindDefinition,
} from "../relationships.js";

/** Current portable relationship-graph snapshot format. */
export const RELATIONSHIP_GRAPH_SNAPSHOT_VERSION = 1;

/** Immutable, content-addressed graph state exchanged with an adapter. */
export interface RelationshipGraphSnapshot {
  /** Snapshot format version. */
  version: number;
  /** SHA-256 digest of nodes, edges, and relationship semantics. */
  fingerprint: string;
  /** ISO timestamp describing when this portable projection was created. */
  created_at: string;
  /** Deterministically ordered node identifiers. */
  nodes: readonly string[];
  /** Deterministically ordered normalized relationship edges. */
  edges: readonly RelationshipEdge[];
  /** Complete relationship ontology required to interpret the edges. */
  kinds: readonly RelationshipKindDefinition[];
}

/** Common adapter operation context. */
export interface RelationshipGraphAdapterContext {
  /** Adapter-owned workspace key; it need not be a filesystem path. */
  workspace: string;
  /** Cooperative cancellation signal. */
  signal?: AbortSignal;
}

/** Compare-and-swap replacement context for one complete snapshot. */
export interface RelationshipGraphAdapterReplaceContext extends RelationshipGraphAdapterContext {
  /** Validated snapshot that becomes the complete visible graph state. */
  snapshot: RelationshipGraphSnapshot;
  /** Expected prior fingerprint; null requires an empty workspace. */
  expected_fingerprint?: string | null;
}

/** Storage-neutral graph snapshot adapter implemented by SDK packages. */
export interface RelationshipGraphAdapter {
  /** Stable adapter identifier used in diagnostics. */
  readonly name: string;
  /** Read the current portable snapshot, or null when absent. */
  read(context: RelationshipGraphAdapterContext): Promise<unknown | null>;
  /** Atomically replace the complete snapshot with optional CAS protection. */
  replace(context: RelationshipGraphAdapterReplaceContext): Promise<void>;
  /** Optionally clear a workspace with the same CAS semantics. */
  clear?(
    context: RelationshipGraphAdapterContext & {
      expected_fingerprint?: string | null;
    },
  ): Promise<void>;
}

/** Validated snapshot paired with executable registry and graph views. */
export interface LoadedRelationshipGraphSnapshot {
  /** Portable immutable snapshot. */
  snapshot: RelationshipGraphSnapshot;
  /** Registry reconstructed from the snapshot ontology. */
  registry: RelationshipKindRegistry;
  /** Executable graph reconstructed through the public kernel. */
  graph: RelationshipGraph;
}

/** Result of synchronizing one snapshot into an adapter. */
export interface RelationshipGraphAdapterSyncResult {
  /** Adapter identifier. */
  adapter: string;
  /** Adapter-owned workspace key. */
  workspace: string;
  /** Whether a write was required. */
  disposition: "current" | "written";
  /** New canonical snapshot fingerprint. */
  fingerprint: string;
  /** Prior fingerprint when a snapshot existed. */
  previous_fingerprint?: string;
  /** Portable node count. */
  node_count: number;
  /** Portable edge count. */
  edge_count: number;
}

/** Throw when cooperative cancellation has already been requested. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

/** Validate one non-empty adapter/workspace identifier. */
function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new TypeError(`Relationship graph ${field} must be non-empty`);
  return value.trim();
}

/** Build an immutable portable snapshot from a validated graph and registry. */
export function createRelationshipGraphSnapshot(
  graph: RelationshipGraph,
  registry: RelationshipKindRegistry,
  options: { createdAt?: string } = {},
): RelationshipGraphSnapshot {
  const parsedTimestamp = Date.parse(
    options.createdAt ?? new Date().toISOString(),
  );
  if (!Number.isFinite(parsedTimestamp))
    throw new TypeError(
      "Relationship graph createdAt must be a valid timestamp",
    );
  const nodes = graph.nodes();
  const edges = graph.edges();
  const kinds = registry.list();
  return Object.freeze({
    version: RELATIONSHIP_GRAPH_SNAPSHOT_VERSION,
    fingerprint: createHash("sha256")
      .update(stableStringify({ nodes, edges, kinds }))
      .digest("hex"),
    created_at: new Date(parsedTimestamp).toISOString(),
    nodes,
    edges,
    kinds,
  });
}

/** Return whether a decoded value is a plain property-bearing object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Decode and fully validate a portable graph snapshot. */
export function parseRelationshipGraphSnapshot(
  value: unknown,
): LoadedRelationshipGraphSnapshot {
  if (!isRecord(value))
    throw new TypeError("Relationship graph snapshot must be an object");
  if (value.version !== RELATIONSHIP_GRAPH_SNAPSHOT_VERSION)
    throw new TypeError(
      `Unsupported relationship graph snapshot version: ${String(value.version)}`,
    );
  if (
    !Array.isArray(value.nodes) ||
    value.nodes.some((id) => typeof id !== "string")
  )
    throw new TypeError("Relationship graph snapshot nodes must be strings");
  if (!Array.isArray(value.edges) || !Array.isArray(value.kinds))
    throw new TypeError(
      "Relationship graph snapshot edges and kinds must be arrays",
    );
  if (
    typeof value.created_at !== "string" ||
    !Number.isFinite(Date.parse(value.created_at))
  )
    throw new TypeError("Relationship graph snapshot created_at must be valid");
  if (typeof value.fingerprint !== "string")
    throw new TypeError(
      "Relationship graph snapshot fingerprint must be a string",
    );
  const registry = new RelationshipKindRegistry([]);
  for (const definition of value.kinds)
    registry.register(definition as RelationshipKindDefinition);
  const graph = new RelationshipGraph(
    value.nodes,
    value.edges as RelationshipEdge[],
    registry,
  );
  const snapshot = createRelationshipGraphSnapshot(graph, registry, {
    createdAt: value.created_at,
  });
  if (snapshot.fingerprint !== value.fingerprint)
    throw new TypeError("Relationship graph snapshot fingerprint mismatch");
  return { snapshot, registry, graph };
}

/** Read and validate one adapter workspace. */
export async function loadRelationshipGraphAdapter(
  adapter: RelationshipGraphAdapter,
  context: RelationshipGraphAdapterContext,
): Promise<LoadedRelationshipGraphSnapshot | null> {
  requireText(adapter.name, "adapter name");
  const workspace = requireText(context.workspace, "workspace");
  throwIfAborted(context.signal);
  const value = await adapter.read({ ...context, workspace });
  throwIfAborted(context.signal);
  return value === null ? null : parseRelationshipGraphSnapshot(value);
}

/**
 * Synchronize a complete graph snapshot with compare-and-swap protection and
 * verify the adapter's visible read after replacement.
 */
export async function syncRelationshipGraphAdapter(
  adapter: RelationshipGraphAdapter,
  context: RelationshipGraphAdapterContext & {
    snapshot: RelationshipGraphSnapshot;
  },
): Promise<RelationshipGraphAdapterSyncResult> {
  const workspace = requireText(context.workspace, "workspace");
  const validated = parseRelationshipGraphSnapshot(context.snapshot).snapshot;
  const current = await loadRelationshipGraphAdapter(adapter, {
    workspace,
    signal: context.signal,
  });
  if (current?.snapshot.fingerprint === validated.fingerprint)
    return {
      adapter: adapter.name,
      workspace,
      disposition: "current",
      fingerprint: validated.fingerprint,
      previous_fingerprint: current.snapshot.fingerprint,
      node_count: validated.nodes.length,
      edge_count: validated.edges.length,
    };
  throwIfAborted(context.signal);
  await adapter.replace({
    workspace,
    signal: context.signal,
    snapshot: validated,
    expected_fingerprint: current?.snapshot.fingerprint ?? null,
  });
  const visible = await loadRelationshipGraphAdapter(adapter, {
    workspace,
    signal: context.signal,
  });
  if (visible?.snapshot.fingerprint !== validated.fingerprint)
    throw new Error(
      `Relationship graph adapter "${adapter.name}" did not expose the replaced snapshot`,
    );
  return {
    adapter: adapter.name,
    workspace,
    disposition: "written",
    fingerprint: validated.fingerprint,
    ...(current ? { previous_fingerprint: current.snapshot.fingerprint } : {}),
    node_count: validated.nodes.length,
    edge_count: validated.edges.length,
  };
}

/** Merge portable snapshots while rejecting semantic kind collisions. */
export function federateRelationshipGraphSnapshots(
  values: readonly unknown[],
  options: { createdAt?: string } = {},
): RelationshipGraphSnapshot {
  const loaded = values.map(parseRelationshipGraphSnapshot);
  const definitions = new Map<string, RelationshipKindDefinition>();
  for (const entry of loaded) {
    for (const definition of entry.snapshot.kinds) {
      const prior = definitions.get(definition.kind);
      if (prior && stableStringify(prior) !== stableStringify(definition))
        throw new TypeError(
          `Conflicting federated relationship kind: ${definition.kind}`,
        );
      definitions.set(definition.kind, definition);
    }
  }
  const registry = new RelationshipKindRegistry(
    [...definitions.values()].sort((left, right) =>
      left.kind.localeCompare(right.kind),
    ),
  );
  const graph = new RelationshipGraph(
    new Set(loaded.flatMap((entry) => [...entry.snapshot.nodes])),
    loaded.flatMap((entry) => [...entry.snapshot.edges]),
    registry,
  );
  return createRelationshipGraphSnapshot(graph, registry, options);
}

/** In-memory reference adapter with atomic CAS behavior for tests and packages. */
export class MemoryRelationshipGraphAdapter implements RelationshipGraphAdapter {
  /** Stable adapter identifier used in diagnostics and conformance reports. */
  public readonly name: string;
  readonly #snapshots = new Map<string, RelationshipGraphSnapshot>();

  /** Create a reference adapter with a stable diagnostic name. */
  public constructor(name = "memory") {
    this.name = requireText(name, "adapter name");
  }

  /** Read an isolated clone of the current workspace snapshot. */
  public async read(
    context: RelationshipGraphAdapterContext,
  ): Promise<RelationshipGraphSnapshot | null> {
    throwIfAborted(context.signal);
    const snapshot = this.#snapshots.get(
      requireText(context.workspace, "workspace"),
    );
    return snapshot ? structuredClone(snapshot) : null;
  }

  /** Atomically replace one workspace after enforcing its expected fingerprint. */
  public async replace(
    context: RelationshipGraphAdapterReplaceContext,
  ): Promise<void> {
    throwIfAborted(context.signal);
    const workspace = requireText(context.workspace, "workspace");
    const current = this.#snapshots.get(workspace);
    if (
      context.expected_fingerprint !== undefined &&
      (current?.fingerprint ?? null) !== context.expected_fingerprint
    )
      throw new Error(`Relationship graph adapter conflict for ${workspace}`);
    this.#snapshots.set(
      workspace,
      structuredClone(
        parseRelationshipGraphSnapshot(context.snapshot).snapshot,
      ),
    );
  }

  /** Clear one workspace after enforcing its expected fingerprint. */
  public async clear(
    context: RelationshipGraphAdapterContext & {
      expected_fingerprint?: string | null;
    },
  ): Promise<void> {
    throwIfAborted(context.signal);
    const workspace = requireText(context.workspace, "workspace");
    const current = this.#snapshots.get(workspace);
    if (
      context.expected_fingerprint !== undefined &&
      (current?.fingerprint ?? null) !== context.expected_fingerprint
    )
      throw new Error(`Relationship graph adapter conflict for ${workspace}`);
    this.#snapshots.delete(workspace);
  }
}
