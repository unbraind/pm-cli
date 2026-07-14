/**
 * @module sdk/relationship-history
 *
 * Provides an append-only, storage-independent relationship event ledger with
 * optimistic concurrency, deterministic replay, snapshots, and cursor pages.
 */
import { createQueryFingerprint, paginateQueryRows } from "./pagination.js";
import {
  RelationshipGraph,
  RelationshipKindRegistry,
  createRelationshipKindRegistry,
  type RelationshipEdge,
} from "./relationships.js";

/** Mutation kinds retained in the immutable relationship event stream. */
export type RelationshipEventAction = "add" | "remove" | "supersede";

/** Caller-authored relationship mutation before its sequence is assigned. */
export interface RelationshipEventInput {
  /** Globally unique idempotency key for this event. */
  eventId: string;
  /** Stable logical relationship identifier across superseding events. */
  relationshipId: string;
  /** Append, remove, or replace the logical relationship. */
  action: RelationshipEventAction;
  /** Edge required for add and supersede actions. */
  edge?: RelationshipEdge;
  /** Attributable actor responsible for the mutation. */
  author: string;
  /** Valid event-time timestamp. */
  timestamp: string;
  /** Optional optimistic concurrency precondition. */
  expectedVersion?: number;
  /** Optional human-readable mutation rationale. */
  reason?: string;
}

/** One immutable sequenced relationship mutation. */
export interface RelationshipEvent extends Omit<
  RelationshipEventInput,
  "expectedVersion"
> {
  /** One-based append sequence assigned by the ledger. */
  sequence: number;
}

/** Point-in-time materialized relationship view. */
export interface RelationshipSnapshot {
  /** Final event sequence included in this snapshot. */
  version: number;
  /** Timestamp of the final included event, when one exists. */
  asOf?: string;
  /** Deterministic active edge materialization. */
  edges: readonly RelationshipEdge[];
  /** Immutable graph query view over the active edges. */
  graph: RelationshipGraph;
}

/** Stable cursor page over a fixed relationship event-log version. */
export interface RelationshipEventPage {
  /** Log version against which this page was produced. */
  version: number;
  /** Events in append order. */
  events: RelationshipEvent[];
  /** Whether another event page exists. */
  hasMore: boolean;
  /** Opaque continuation cursor when another page exists. */
  nextCursor?: string;
}

/** Construction controls for the in-memory reference ledger. */
export interface RelationshipEventLogOptions {
  /** Registry defining edge semantics and cardinality. */
  registry?: RelationshipKindRegistry;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new TypeError(`Relationship event ${field} must be non-empty`);
  return value.trim();
}

function edgeIdentity(
  edge: RelationshipEdge,
  registry: RelationshipKindRegistry,
): string {
  const definition = registry.require(edge.kind);
  const endpoints =
    definition.direction === "undirected"
      ? [edge.source, edge.target].sort().join("\u0000")
      : `${edge.source}\u0000${edge.target}`;
  return `${definition.kind}\u0000${endpoints}`;
}

function freezeEdge(edge: RelationshipEdge): RelationshipEdge {
  return Object.freeze({
    ...edge,
    ...(edge.payload === undefined
      ? {}
      : { payload: Object.freeze(structuredClone(edge.payload)) }),
  });
}

function assertCardinality(
  candidate: RelationshipEdge,
  active: ReadonlyMap<string, RelationshipEdge>,
  excludeRelationshipId: string,
  registry: RelationshipKindRegistry,
): void {
  const definition = registry.require(candidate.kind);
  const identity = edgeIdentity(candidate, registry);
  for (const [relationshipId, edge] of active) {
    if (relationshipId === excludeRelationshipId) continue;
    if (registry.require(edge.kind).kind !== definition.kind) continue;
    if (
      definition.outgoing === "one" &&
      edge.source === candidate.source
    )
      throw new TypeError(
        `Relationship outgoing cardinality exceeded for ${definition.kind}`,
      );
    if (definition.incoming === "one" && edge.target === candidate.target)
      throw new TypeError(
        `Relationship incoming cardinality exceeded for ${definition.kind}`,
      );
    if (edgeIdentity(edge, registry) === identity)
      throw new TypeError(`Relationship edge already active: ${identity}`);
  }
}

function replayEvents(
  events: readonly RelationshipEvent[],
): Map<string, RelationshipEdge> {
  const active = new Map<string, RelationshipEdge>();
  for (const event of events) {
    if (event.action === "remove") active.delete(event.relationshipId);
    else active.set(event.relationshipId, event.edge!);
  }
  return active;
}

function normalizeEventHeader(
  input: RelationshipEventInput,
  currentVersion: number,
  eventIds: ReadonlySet<string>,
): {
  eventId: string;
  relationshipId: string;
  author: string;
  timestamp: string;
} {
  if (
    input.expectedVersion !== undefined &&
    input.expectedVersion !== currentVersion
  )
    throw new TypeError(
      `Relationship event version conflict: expected ${input.expectedVersion}, current ${currentVersion}`,
    );
  const eventId = requiredText(input.eventId, "eventId");
  if (eventIds.has(eventId))
    throw new TypeError(`Relationship event already exists: ${eventId}`);
  if (
    input.action !== "add" &&
    input.action !== "remove" &&
    input.action !== "supersede"
  )
    throw new TypeError(`Unknown relationship event action: ${input.action}`);
  if (!Number.isFinite(Date.parse(input.timestamp)))
    throw new TypeError("Relationship event timestamp must be valid");
  return {
    eventId,
    relationshipId: requiredText(input.relationshipId, "relationshipId"),
    author: requiredText(input.author, "author"),
    timestamp: new Date(input.timestamp).toISOString(),
  };
}

function resolveMutationEdge(
  input: RelationshipEventInput,
  relationshipId: string,
  active: ReadonlyMap<string, RelationshipEdge>,
  nodes: ReadonlySet<string>,
  registry: RelationshipKindRegistry,
): RelationshipEdge | undefined {
  const isActive = active.has(relationshipId);
  if (input.action === "add" && isActive)
    throw new TypeError(`Relationship is already active: ${relationshipId}`);
  if (input.action !== "add" && !isActive)
    throw new TypeError(`Relationship is not active: ${relationshipId}`);
  if (input.action === "remove") return undefined;
  if (!input.edge)
    throw new TypeError(`Relationship ${input.action} event requires an edge`);
  const source =
    typeof input.edge.source === "string" ? input.edge.source.trim() : "";
  const target =
    typeof input.edge.target === "string" ? input.edge.target.trim() : "";
  if (!nodes.has(source) || !nodes.has(target))
    throw new TypeError(
      `Relationship endpoint not found: ${source} -> ${target}`,
    );
  const canonical = new RelationshipGraph(
    [source, target],
    [input.edge],
    registry,
  ).edges()[0]!;
  assertCardinality(canonical, active, relationshipId, registry);
  return freezeEdge(canonical);
}

/**
 * Append-only in-memory reference ledger. Durable adapters can persist the
 * returned immutable events while reusing the same replay and validation model.
 */
export class RelationshipEventLog {
  readonly #nodes: ReadonlySet<string>;
  readonly #registry: RelationshipKindRegistry;
  readonly #events: RelationshipEvent[] = [];
  readonly #eventIds = new Set<string>();
  readonly #active = new Map<string, RelationshipEdge>();

  /** Create an empty relationship ledger for a fixed node universe. */
  public constructor(
    nodes: Iterable<string>,
    options: RelationshipEventLogOptions = {},
  ) {
    this.#nodes = new Set(
      [...nodes]
        .filter((node): node is string => typeof node === "string")
        .map((node) => node.trim())
        .filter(Boolean),
    );
    this.#registry = options.registry ?? createRelationshipKindRegistry();
  }

  /** Current append sequence. */
  public get version(): number {
    return this.#events.length;
  }

  /** Return an immutable copy of the full event stream. */
  public events(): readonly RelationshipEvent[] {
    return Object.freeze([...this.#events]);
  }

  /** Validate and append one attributable relationship mutation. */
  public append(input: RelationshipEventInput): RelationshipEvent {
    const header = normalizeEventHeader(input, this.version, this.#eventIds);
    const edge = resolveMutationEdge(
      input,
      header.relationshipId,
      this.#active,
      this.#nodes,
      this.#registry,
    );

    const event = Object.freeze({
      eventId: header.eventId,
      relationshipId: header.relationshipId,
      action: input.action,
      ...(edge === undefined ? {} : { edge }),
      author: header.author,
      timestamp: header.timestamp,
      ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
      sequence: this.version + 1,
    }) satisfies RelationshipEvent;
    this.#events.push(event);
    this.#eventIds.add(header.eventId);
    if (input.action === "remove") this.#active.delete(header.relationshipId);
    else this.#active.set(header.relationshipId, edge!);
    return event;
  }

  /** Materialize an exact point-in-time graph without mutating the ledger. */
  public snapshot(
    options: {
      atVersion?: number;
      atTimestamp?: string;
    } = {},
  ): RelationshipSnapshot {
    if (options.atVersion !== undefined && options.atTimestamp !== undefined)
      throw new TypeError("Relationship snapshot accepts one target");
    let included: RelationshipEvent[];
    if (options.atTimestamp !== undefined) {
      const timestamp = Date.parse(options.atTimestamp);
      if (!Number.isFinite(timestamp))
        throw new TypeError("Relationship snapshot timestamp must be valid");
      included = this.#events.filter(
        (event) => Date.parse(event.timestamp) <= timestamp,
      );
    } else {
      const version = options.atVersion ?? this.version;
      if (!Number.isInteger(version) || version < 0 || version > this.version)
        throw new TypeError(
          `Relationship snapshot version out of range: ${version}`,
        );
      included = this.#events.slice(0, version);
    }
    const active = replayEvents(included);
    const graph = new RelationshipGraph(
      this.#nodes,
      active.values(),
      this.#registry,
    );
    return Object.freeze({
      version: included.length,
      ...(included.at(-1) ? { asOf: included.at(-1)!.timestamp } : {}),
      edges: graph.edges(),
      graph,
    });
  }

  /** Page the immutable event stream with a cursor bound to this log version. */
  public page(options: {
    limit: number;
    cursor?: string;
  }): RelationshipEventPage {
    if (!Number.isInteger(options.limit) || options.limit < 1)
      throw new TypeError("Relationship event page limit must be positive");
    const page = paginateQueryRows(this.#events, {
      cursor: options.cursor,
      fingerprint: createQueryFingerprint("relationship-events", {
        version: this.version,
      }),
      limit: options.limit,
      readId: (event) => event.eventId,
    });
    return {
      version: this.version,
      events: page.rows,
      hasMore: page.has_more,
      ...(page.next_cursor ? { nextCursor: page.next_cursor } : {}),
    };
  }
}
