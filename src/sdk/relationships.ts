/**
 * @module sdk/relationships
 *
 * Provides the dependency-free relationship ontology and bounded graph-query
 * kernel shared by the SDK, CLI, MCP adapters, extensions, and non-PM apps.
 */
import type { Dependency, ItemMetadata } from "../types/index.js";

/** Direction exposed by a relationship kind. */
export type RelationshipDirection = "directed" | "undirected";
/** Cardinality constraint applied independently to outgoing and incoming edges. */
export type RelationshipCardinality = "one" | "many";
/** Lifecycle policy for a relationship kind. */
export type RelationshipLifecycle = "persistent" | "supersedable" | "ephemeral";

/** Versioned semantic definition for a built-in or application-defined edge kind. */
export interface RelationshipKindDefinition {
  /** Canonical, case-insensitive kind identifier. */
  kind: string;
  /** Whether traversing source to target has distinct meaning from the reverse. */
  direction: RelationshipDirection;
  /** Optional canonical kind used when traversing a directed edge in reverse. */
  inverse?: string;
  /** Whether the kind participates in execution-order cycle checks. */
  ordering: boolean;
  /** Whether the kind contributes to structural ancestry. */
  hierarchy: boolean;
  /** Maximum logical outgoing edges of this kind from one node. */
  outgoing: RelationshipCardinality;
  /** Maximum logical incoming edges of this kind to one node. */
  incoming: RelationshipCardinality;
  /** Edge replacement and retention behavior. */
  lifecycle: RelationshipLifecycle;
  /** JSON Schema for optional application-owned payloads. */
  payloadSchema?: Readonly<Record<string, unknown>>;
  /** Legacy spellings normalized to this definition. */
  aliases?: readonly string[];
  /** Compatibility version of this semantic contract. */
  compatibilityVersion: number;
  /** Whether source and target may be the same node. */
  allowSelf: boolean;
}

/** One normalized relationship edge indexed by the graph kernel. */
export interface RelationshipEdge {
  /** Source node identifier. */
  source: string;
  /** Target node identifier. */
  target: string;
  /** Canonical relationship kind. */
  kind: string;
  /** Optional creation timestamp retained from storage. */
  createdAt?: string;
  /** Optional author retained from storage. */
  author?: string;
  /** Optional application-owned edge payload. */
  payload?: Readonly<Record<string, unknown>>;
}

/** Direction used by adjacency, closure, and path traversal. */
export type RelationshipTraversalDirection = "outgoing" | "incoming" | "both";

/** Shared bounded-query controls. */
export interface RelationshipQueryOptions {
  /** Edge kinds to traverse after alias normalization. */
  kinds?: readonly string[];
  /** Traversal direction relative to each visited node. */
  direction?: RelationshipTraversalDirection;
  /** Maximum number of returned nodes, excluding the starting node. */
  limit?: number;
  /** Maximum traversal depth. */
  maxDepth?: number;
  /** Abort signal checked throughout traversal. */
  signal?: AbortSignal;
}

/** Cost and truncation metadata returned by every graph query. */
export interface RelationshipQueryMeta {
  /** Number of nodes removed from the traversal frontier. */
  visitedNodes: number;
  /** Number of candidate edges inspected. */
  inspectedEdges: number;
  /** Whether a configured bound stopped traversal. */
  truncated: boolean;
  /** Deterministic continuation cursor for the final returned node. */
  nextCursor?: string;
}

/** Generic bounded graph query result. */
export interface RelationshipQueryResult<T> {
  /** Deterministically ordered query value. */
  value: T;
  /** Explicit query work and truncation metadata. */
  meta: RelationshipQueryMeta;
}

/** Induced subgraph returned by bounded traversal. */
export interface RelationshipSubgraph {
  /** Deterministically ordered node identifiers. */
  nodes: string[];
  /** Deterministically ordered edges whose endpoints are both present. */
  edges: RelationshipEdge[];
}

const BUILTIN_RELATIONSHIP_KINDS: readonly RelationshipKindDefinition[] = [
  {
    kind: "blocked_by",
    direction: "directed",
    inverse: "blocks",
    ordering: true,
    hierarchy: false,
    outgoing: "many",
    incoming: "many",
    lifecycle: "persistent",
    aliases: ["depends_on"],
    compatibilityVersion: 1,
    allowSelf: false,
  },
  {
    kind: "blocks",
    direction: "directed",
    inverse: "blocked_by",
    ordering: true,
    hierarchy: false,
    outgoing: "many",
    incoming: "many",
    lifecycle: "persistent",
    compatibilityVersion: 1,
    allowSelf: false,
  },
  {
    kind: "parent",
    direction: "directed",
    inverse: "child",
    ordering: false,
    hierarchy: true,
    outgoing: "one",
    incoming: "many",
    lifecycle: "supersedable",
    aliases: ["child_of", "epic"],
    compatibilityVersion: 1,
    allowSelf: false,
  },
  {
    kind: "child",
    direction: "directed",
    inverse: "parent",
    ordering: false,
    hierarchy: true,
    outgoing: "many",
    incoming: "one",
    lifecycle: "supersedable",
    aliases: ["parent_child", "task"],
    compatibilityVersion: 1,
    allowSelf: false,
  },
  {
    kind: "related",
    direction: "undirected",
    ordering: false,
    hierarchy: false,
    outgoing: "many",
    incoming: "many",
    lifecycle: "persistent",
    aliases: ["related_to"],
    compatibilityVersion: 1,
    allowSelf: false,
  },
  {
    kind: "discovered_from",
    direction: "directed",
    ordering: false,
    hierarchy: false,
    outgoing: "many",
    incoming: "many",
    lifecycle: "persistent",
    compatibilityVersion: 1,
    allowSelf: false,
  },
  {
    kind: "incident_from",
    direction: "directed",
    ordering: false,
    hierarchy: false,
    outgoing: "many",
    incoming: "many",
    lifecycle: "persistent",
    compatibilityVersion: 1,
    allowSelf: false,
  },
  {
    kind: "supersedes",
    direction: "directed",
    ordering: false,
    hierarchy: false,
    outgoing: "many",
    incoming: "many",
    lifecycle: "supersedable",
    compatibilityVersion: 1,
    allowSelf: false,
  },
] as const;

function normalizeKind(kind: string): string {
  return kind.trim().toLowerCase().replaceAll("-", "_");
}

function normalizeInverseKind(inverse: string | undefined): string | undefined {
  if (inverse === undefined) return undefined;
  const normalized = normalizeKind(inverse);
  if (!/^[a-z][a-z0-9_]*$/.test(normalized))
    throw new TypeError(`Invalid inverse relationship kind: ${inverse}`);
  return normalized;
}

function freezeValue(value: unknown, visited = new Set<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (visited.has(value)) return value;
  visited.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) freezeValue(entry, visited);
    return Object.freeze(value);
  }
  for (const entry of Object.values(value)) freezeValue(entry, visited);
  return Object.freeze(value);
}

/** Mutable registry with immutable snapshots and collision-safe extension registration. */
export class RelationshipKindRegistry {
  readonly #definitions = new Map<string, RelationshipKindDefinition>();
  readonly #aliases = new Map<string, string>();

  /** Create a registry initialized with the stable built-in ontology by default. */
  public constructor(
    definitions: readonly RelationshipKindDefinition[] = BUILTIN_RELATIONSHIP_KINDS,
  ) {
    for (const definition of definitions) this.register(definition);
  }

  /** Register one definition after validating its identifier, version, and aliases. */
  public register(definition: RelationshipKindDefinition): this {
    const kind = normalizeKind(definition.kind);
    if (!/^[a-z][a-z0-9_]*$/.test(kind))
      throw new TypeError(`Invalid relationship kind: ${definition.kind}`);
    if (
      !Number.isInteger(definition.compatibilityVersion) ||
      definition.compatibilityVersion < 1
    )
      throw new TypeError(`Invalid compatibility version for ${kind}`);
    if (this.#definitions.has(kind) || this.#aliases.has(kind))
      throw new TypeError(`Relationship kind already registered: ${kind}`);
    const inverse = normalizeInverseKind(definition.inverse);
    const aliases = [
      ...new Set((definition.aliases ?? []).map(normalizeKind)),
    ].sort();
    for (const alias of aliases) {
      if (!/^[a-z][a-z0-9_]*$/.test(alias))
        throw new TypeError(`Invalid relationship alias: ${alias}`);
      if (
        alias === kind ||
        this.#definitions.has(alias) ||
        this.#aliases.has(alias)
      )
        throw new TypeError(`Relationship alias already registered: ${alias}`);
    }
    const normalized = Object.freeze({
      ...definition,
      kind,
      inverse,
      aliases: Object.freeze(aliases),
      payloadSchema: definition.payloadSchema
        ? (freezeValue(structuredClone(definition.payloadSchema)) as Readonly<
            Record<string, unknown>
          >)
        : undefined,
    });
    this.#definitions.set(kind, normalized);
    for (const alias of aliases) this.#aliases.set(alias, kind);
    return this;
  }

  /** Resolve a canonical kind or compatibility alias. */
  public resolve(kind: unknown): RelationshipKindDefinition | undefined {
    if (typeof kind !== "string") return undefined;
    const normalized = normalizeKind(kind);
    return this.#definitions.get(this.#aliases.get(normalized) ?? normalized);
  }

  /** Resolve a kind or throw a precise error suitable for command adapters. */
  public require(kind: string): RelationshipKindDefinition {
    const definition = this.resolve(kind);
    if (!definition) throw new TypeError(`Unknown relationship kind: ${kind}`);
    return definition;
  }

  /** Return a deterministic immutable registry snapshot. */
  public list(): readonly RelationshipKindDefinition[] {
    return Object.freeze(
      [...this.#definitions.values()].sort((left, right) =>
        left.kind.localeCompare(right.kind),
      ),
    );
  }
}

/** Create a registry containing the built-in relationship ontology. */
export function createRelationshipKindRegistry(): RelationshipKindRegistry {
  return new RelationshipKindRegistry();
}

const defaultRegistry = createRelationshipKindRegistry();

/** Report whether a kind participates in execution-order cycle detection. */
export function isOrderingRelationshipKind(
  kind: string,
  registry: RelationshipKindRegistry = defaultRegistry,
): boolean {
  return registry.resolve(kind)?.ordering === true;
}

function compareEdges(left: RelationshipEdge, right: RelationshipEdge): number {
  return (
    left.source.localeCompare(right.source) ||
    left.target.localeCompare(right.target) ||
    left.kind.localeCompare(right.kind)
  );
}

function normalizeRelationshipEdge(
  candidate: RelationshipEdge,
  nodes: ReadonlySet<string>,
  registry: RelationshipKindRegistry,
): { edge: RelationshipEdge; identity: string } {
  const source =
    typeof candidate.source === "string" ? candidate.source.trim() : "";
  const target =
    typeof candidate.target === "string" ? candidate.target.trim() : "";
  const definition = registry.require(candidate.kind);
  if (!nodes.has(source) || !nodes.has(target))
    throw new TypeError(`Relationship endpoint not found: ${source} -> ${target}`);
  if (source === target && !definition.allowSelf)
    throw new TypeError(`Self relationship is not allowed for ${definition.kind}`);
  const edge = Object.freeze({
    ...candidate,
    source,
    target,
    kind: definition.kind,
  });
  const endpoints =
    definition.direction === "undirected"
      ? [source, target].sort().join("\u0000")
      : `${source}\u0000${target}`;
  return { edge, identity: `${definition.kind}\u0000${endpoints}` };
}

function appendIndexedEdge(
  index: Map<string, RelationshipEdge[]>,
  node: string,
  edge: RelationshipEdge,
): void {
  const indexed = index.get(node);
  if (indexed) indexed.push(edge);
  else index.set(node, [edge]);
}

function normalizeNodeId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function resolveExistingNodeId(
  value: unknown,
  ids: ReadonlySet<string>,
): string | undefined {
  const id = normalizeNodeId(value);
  return id && ids.has(id) ? id : undefined;
}

function reconstructPath(
  source: string,
  target: string,
  parents: ReadonlyMap<string, string>,
): string[] {
  const path = [target];
  let cursor = target;
  while (cursor !== source) {
    cursor = parents.get(cursor)!;
    path.push(cursor);
  }
  return path.reverse();
}

/** Build an immutable, deterministic in-memory relationship index. */
export class RelationshipGraph {
  readonly #registry: RelationshipKindRegistry;
  readonly #nodes: Set<string>;
  readonly #edges: readonly RelationshipEdge[];
  readonly #outgoing = new Map<string, RelationshipEdge[]>();
  readonly #incoming = new Map<string, RelationshipEdge[]>();

  /** Validate and index nodes and edges without reading tracker storage. */
  public constructor(
    nodes: Iterable<string>,
    edges: Iterable<RelationshipEdge>,
    registry: RelationshipKindRegistry = defaultRegistry,
  ) {
    this.#registry = registry;
    this.#nodes = new Set(
      [...nodes]
        .filter((id): id is string => typeof id === "string")
        .map((id) => id.trim())
        .filter(Boolean),
    );
    const deduped = new Map<string, RelationshipEdge>();
    for (const candidate of edges) {
      const { edge, identity } = normalizeRelationshipEdge(
        candidate,
        this.#nodes,
        registry,
      );
      deduped.set(identity, edge);
    }
    this.#edges = Object.freeze([...deduped.values()].sort(compareEdges));
    for (const edge of this.#edges) {
      appendIndexedEdge(this.#outgoing, edge.source, edge);
      appendIndexedEdge(this.#incoming, edge.target, edge);
      if (registry.require(edge.kind).direction === "undirected") {
        appendIndexedEdge(this.#outgoing, edge.target, edge);
        appendIndexedEdge(this.#incoming, edge.source, edge);
      }
    }
  }

  /** Build the graph directly from item metadata, including hierarchy and legacy blocker fields. */
  public static fromItems(
    items: readonly Pick<
      ItemMetadata,
      "id" | "parent" | "blocked_by" | "dependencies"
    >[],
    registry: RelationshipKindRegistry = defaultRegistry,
  ): RelationshipGraph {
    const ids = new Set(
      items.map((item) => normalizeNodeId(item.id)).filter(Boolean),
    );
    const edges: RelationshipEdge[] = [];
    for (const item of items) {
      const source = normalizeNodeId(item.id);
      if (!source) continue;
      const parent = resolveExistingNodeId(item.parent, ids);
      if (parent)
        edges.push({ source, target: parent, kind: "parent" });
      const blockedBy = resolveExistingNodeId(item.blocked_by, ids);
      if (blockedBy)
        edges.push({
          source,
          target: blockedBy,
          kind: "blocked_by",
        });
      for (const dependency of item.dependencies ?? []) {
        const dependencyId = resolveExistingNodeId(dependency.id, ids);
        if (dependencyId && registry.resolve(dependency.kind))
          edges.push({
            source,
            target: dependencyId,
            kind: dependency.kind,
            createdAt: dependency.created_at,
            author: dependency.author,
          });
      }
    }
    return new RelationshipGraph(ids, edges, registry);
  }

  /** Return the deterministic immutable edge snapshot. */
  public edges(): readonly RelationshipEdge[] {
    return this.#edges;
  }

  #assertNode(id: string): void {
    if (!this.#nodes.has(id))
      throw new TypeError(`Relationship node not found: ${id}`);
  }

  #matchesKinds(
    edge: RelationshipEdge,
    kinds: ReadonlySet<string> | undefined,
  ): boolean {
    if (!kinds) return true;
    const definition = this.#registry.require(edge.kind);
    return (
      kinds.has(edge.kind) ||
      (definition.inverse !== undefined && kinds.has(definition.inverse))
    );
  }

  #neighbors(
    id: string,
    direction: RelationshipTraversalDirection,
    kinds: ReadonlySet<string> | undefined,
  ): { id: string; edge: RelationshipEdge }[] {
    const candidates = [
      ...(direction === "incoming" ? [] : (this.#outgoing.get(id) ?? [])),
      ...(direction === "outgoing" ? [] : (this.#incoming.get(id) ?? [])),
    ];
    return [...new Set(candidates)]
      .filter((edge) => this.#matchesKinds(edge, kinds))
      .map((edge) => ({
        id: edge.source === id ? edge.target : edge.source,
        edge,
      }))
      .sort(
        (left, right) =>
          left.id.localeCompare(right.id) ||
          compareEdges(left.edge, right.edge),
      );
  }

  /** Return one-hop adjacent node identifiers. */
  public adjacency(
    id: string,
    options: RelationshipQueryOptions = {},
  ): RelationshipQueryResult<string[]> {
    this.#assertNode(id);
    options.signal?.throwIfAborted();
    const kinds = options.kinds
      ? new Set(options.kinds.map((kind) => this.#registry.require(kind).kind))
      : undefined;
    const rows = this.#neighbors(id, options.direction ?? "outgoing", kinds);
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    const uniqueNeighbors = [...new Set(rows.map((row) => row.id))];
    const value = uniqueNeighbors.slice(0, limit);
    return {
      value,
      meta: {
        visitedNodes: 1,
        inspectedEdges: rows.length,
        truncated: value.length < uniqueNeighbors.length,
        nextCursor: value.at(-1),
      },
    };
  }

  /** Return bounded transitive closure in breadth-first discovery order. */
  public closure(
    id: string,
    options: RelationshipQueryOptions = {},
  ): RelationshipQueryResult<string[]> {
    this.#assertNode(id);
    const kinds = options.kinds
      ? new Set(options.kinds.map((kind) => this.#registry.require(kind).kind))
      : undefined;
    const direction = options.direction ?? "outgoing";
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
    const seen = new Set([id]);
    const value: string[] = [];
    const queue = [{ id, depth: 0 }];
    let visitedNodes = 0;
    let inspectedEdges = 0;
    let truncated = false;
    traversal: for (let index = 0; index < queue.length; index += 1) {
      options.signal?.throwIfAborted();
      const current = queue[index]!;
      visitedNodes += 1;
      const neighbors = this.#neighbors(current.id, direction, kinds);
      inspectedEdges += neighbors.length;
      if (current.depth >= maxDepth) {
        if (neighbors.some((neighbor) => !seen.has(neighbor.id)))
          truncated = true;
        continue;
      }
      for (const neighbor of neighbors) {
        if (seen.has(neighbor.id)) continue;
        if (value.length >= limit) {
          truncated = true;
          break traversal;
        }
        seen.add(neighbor.id);
        value.push(neighbor.id);
        queue.push({ id: neighbor.id, depth: current.depth + 1 });
      }
    }
    return {
      value,
      meta: {
        visitedNodes,
        inspectedEdges,
        truncated,
        nextCursor: value.at(-1),
      },
    };
  }

  /** Return a deterministic shortest path, or an empty array when disconnected. */
  public shortestPath(
    source: string,
    target: string,
    options: RelationshipQueryOptions = {},
  ): RelationshipQueryResult<string[]> {
    this.#assertNode(source);
    this.#assertNode(target);
    if (source === target)
      return {
        value: [source],
        meta: { visitedNodes: 1, inspectedEdges: 0, truncated: false },
      };
    const kinds = options.kinds
      ? new Set(options.kinds.map((kind) => this.#registry.require(kind).kind))
      : undefined;
    const direction = options.direction ?? "outgoing";
    const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
    const queue = [{ id: source, depth: 0 }];
    const parents = new Map<string, string>();
    const seen = new Set([source]);
    let visitedNodes = 0;
    let inspectedEdges = 0;
    let truncated = false;
    for (let index = 0; index < queue.length; index += 1) {
      options.signal?.throwIfAborted();
      const current = queue[index]!;
      visitedNodes += 1;
      const neighbors = this.#neighbors(current.id, direction, kinds);
      inspectedEdges += neighbors.length;
      if (current.depth >= maxDepth) {
        if (neighbors.some((neighbor) => !seen.has(neighbor.id)))
          truncated = true;
        continue;
      }
      for (const neighbor of neighbors) {
        if (seen.has(neighbor.id)) continue;
        parents.set(neighbor.id, current.id);
        if (neighbor.id === target)
          return {
            value: reconstructPath(source, target, parents),
            meta: { visitedNodes, inspectedEdges, truncated: false },
          };
        seen.add(neighbor.id);
        queue.push({ id: neighbor.id, depth: current.depth + 1 });
      }
    }
    return {
      value: [],
      meta: { visitedNodes, inspectedEdges, truncated },
    };
  }

  /** Return the induced subgraph over a bounded closure including the root. */
  public subgraph(
    id: string,
    options: RelationshipQueryOptions = {},
  ): RelationshipQueryResult<RelationshipSubgraph> {
    const closure = this.closure(id, options);
    const nodes = [id, ...closure.value].sort();
    const included = new Set(nodes);
    const kinds = options.kinds
      ? new Set(options.kinds.map((kind) => this.#registry.require(kind).kind))
      : undefined;
    const edges = new Set<RelationshipEdge>();
    for (const node of nodes) {
      for (const edge of this.#outgoing.get(node) ?? []) {
        if (
          included.has(edge.source) &&
          included.has(edge.target) &&
          this.#matchesKinds(edge, kinds)
        )
          edges.add(edge);
      }
    }
    return {
      value: {
        nodes,
        edges: [...edges].sort(compareEdges),
      },
      meta: closure.meta,
    };
  }
}

/** Convert one stored dependency into the public relationship edge contract. */
export function dependencyToRelationship(
  source: string,
  dependency: Dependency,
  registry: RelationshipKindRegistry = defaultRegistry,
): RelationshipEdge {
  return {
    source,
    target: dependency.id,
    kind: registry.require(dependency.kind).kind,
    createdAt: dependency.created_at,
    author: dependency.author,
  };
}
