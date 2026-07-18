/**
 * @module sdk/relationship-history
 *
 * Provides an append-only, storage-independent relationship event ledger with
 * optimistic concurrency, deterministic replay, snapshots, and cursor pages.
 */
import {
  createQueryFingerprint,
  decodeQueryCursorState,
  paginateQueryRows,
} from "./pagination.js";
import { constants } from "node:fs";
import { lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { acquireLock } from "../core/lock/lock.js";
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

/** Bounded controls for deterministic relationship-event batch iteration. */
export interface RelationshipEventStreamOptions {
  /** One-based first event version to include. */
  fromVersion?: number;
  /** One-based final event version to include. */
  toVersion?: number;
  /** Maximum number of events yielded in each immutable batch. */
  batchSize?: number;
}

/** Result of folding an immutable relationship-event prefix into domain state. */
export interface RelationshipEventProjection<State> {
  /** Final projected state returned by the caller-owned reducer. */
  state: State;
  /** Final event sequence included in the projection. */
  version: number;
  /** Number of events processed by this projection. */
  processed: number;
  /** Timestamp of the final included event, when one exists. */
  asOf?: string;
}

/** Pure reducer used to derive application state from relationship events. */
export type RelationshipEventReducer<State> = (
  state: State,
  event: RelationshipEvent,
) => State;

/** Construction controls for the in-memory reference ledger. */
export interface RelationshipEventLogOptions {
  /** Registry defining edge semantics and cardinality. */
  registry?: RelationshipKindRegistry;
}

/** Filesystem controls for the durable relationship event store. */
export interface RelationshipEventStoreOptions extends RelationshipEventLogOptions {
  /** Tracker root that owns the relationship history directory. */
  pmRoot: string;
  /** Fixed node universe validated by every replay and append. */
  nodes: Iterable<string>;
  /** Optional JSONL path relative to the tracker root. */
  relativePath?: string;
}

interface RelationshipCardinalityIndexes {
  identities: Map<string, string>;
  outgoingOne: Map<string, string>;
  incomingOne: Map<string, string>;
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
  excludeRelationshipId: string,
  registry: RelationshipKindRegistry,
  indexes: RelationshipCardinalityIndexes,
): void {
  const definition = registry.require(candidate.kind);
  const outgoingOwner = indexes.outgoingOne.get(
    `${definition.kind}\u0000${candidate.source}`,
  );
  if (outgoingOwner !== undefined && outgoingOwner !== excludeRelationshipId)
    throw new TypeError(
      `Relationship outgoing cardinality exceeded for ${definition.kind}`,
    );
  const incomingOwner = indexes.incomingOne.get(
    `${definition.kind}\u0000${candidate.target}`,
  );
  if (incomingOwner !== undefined && incomingOwner !== excludeRelationshipId)
    throw new TypeError(
      `Relationship incoming cardinality exceeded for ${definition.kind}`,
    );
  const identity = edgeIdentity(candidate, registry);
  const identityOwner = indexes.identities.get(identity);
  if (identityOwner !== undefined && identityOwner !== excludeRelationshipId)
    throw new TypeError(`Relationship edge already active: ${identity}`);
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
  indexes: RelationshipCardinalityIndexes,
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
  assertCardinality(canonical, relationshipId, registry, indexes);
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
  readonly #cardinalityIndexes: RelationshipCardinalityIndexes = {
    identities: new Map(),
    outgoingOne: new Map(),
    incomingOne: new Map(),
  };

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

  /**
   * Iterate a stable event prefix in immutable, bounded batches. Consumers can
   * build streaming projections without copying or exposing the mutable ledger.
   * `fromVersion === toVersion + 1` is the intentional empty checkpoint range;
   * larger watermarks are rejected as invalid for the selected prefix.
   */
  public *stream(
    options: RelationshipEventStreamOptions = {},
  ): Generator<readonly RelationshipEvent[]> {
    const fromVersion = options.fromVersion ?? 1;
    const toVersion = options.toVersion ?? this.version;
    const batchSize = options.batchSize ?? 100;
    if (!Number.isInteger(fromVersion) || fromVersion < 1)
      throw new TypeError(
        "Relationship event stream fromVersion must be positive",
      );
    if (
      !Number.isInteger(toVersion) ||
      toVersion < 0 ||
      toVersion > this.version
    )
      throw new TypeError(
        `Relationship event stream toVersion out of range: ${toVersion}`,
      );
    if (!Number.isInteger(batchSize) || batchSize < 1)
      throw new TypeError(
        "Relationship event stream batchSize must be positive",
      );
    if (fromVersion > toVersion + 1)
      throw new TypeError(
        "Relationship event stream fromVersion exceeds the selected prefix",
      );
    for (let offset = fromVersion - 1; offset < toVersion; offset += batchSize) {
      yield Object.freeze(
        this.#events.slice(offset, Math.min(offset + batchSize, toVersion)),
      );
    }
  }

  /** Fold a selected immutable event prefix into caller-owned domain state. */
  public project<State>(
    initialState: State,
    reducer: RelationshipEventReducer<State>,
    options: Omit<RelationshipEventStreamOptions, "batchSize"> = {},
  ): RelationshipEventProjection<State> {
    if (typeof reducer !== "function")
      throw new TypeError("Relationship event projection requires a reducer");
    let state = initialState;
    let processed = 0;
    let finalEvent: RelationshipEvent | undefined;
    for (const batch of this.stream({ ...options, batchSize: 256 })) {
      for (const event of batch) {
        state = reducer(state, event);
        processed += 1;
        finalEvent = event;
      }
    }
    return Object.freeze({
      state,
      version: finalEvent?.sequence ?? Math.max(0, (options.fromVersion ?? 1) - 1),
      processed,
      ...(finalEvent === undefined ? {} : { asOf: finalEvent.timestamp }),
    });
  }

  /** Add one active relationship to constant-time validation indexes. */
  #indexActive(relationshipId: string, edge: RelationshipEdge): void {
    const definition = this.#registry.require(edge.kind);
    this.#cardinalityIndexes.identities.set(
      edgeIdentity(edge, this.#registry),
      relationshipId,
    );
    if (definition.outgoing === "one")
      this.#cardinalityIndexes.outgoingOne.set(
        `${definition.kind}\u0000${edge.source}`,
        relationshipId,
      );
    if (definition.incoming === "one")
      this.#cardinalityIndexes.incomingOne.set(
        `${definition.kind}\u0000${edge.target}`,
        relationshipId,
      );
  }

  /** Remove one superseded or deleted relationship from validation indexes. */
  #unindexActive(edge: RelationshipEdge): void {
    const definition = this.#registry.require(edge.kind);
    this.#cardinalityIndexes.identities.delete(
      edgeIdentity(edge, this.#registry),
    );
    if (definition.outgoing === "one")
      this.#cardinalityIndexes.outgoingOne.delete(
        `${definition.kind}\u0000${edge.source}`,
      );
    if (definition.incoming === "one")
      this.#cardinalityIndexes.incomingOne.delete(
        `${definition.kind}\u0000${edge.target}`,
      );
  }

  /** Validate and append one attributable relationship mutation. */
  public append(input: RelationshipEventInput): RelationshipEvent {
    const header = normalizeEventHeader(input, this.version, this.#eventIds);
    const previous = this.#active.get(header.relationshipId);
    const edge = resolveMutationEdge(
      input,
      header.relationshipId,
      this.#active,
      this.#nodes,
      this.#registry,
      this.#cardinalityIndexes,
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
    if (previous) this.#unindexActive(previous);
    if (input.action === "remove") this.#active.delete(header.relationshipId);
    else {
      this.#active.set(header.relationshipId, edge!);
      this.#indexActive(header.relationshipId, edge!);
    }
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
      let lastIndex = -1;
      for (let index = this.#events.length - 1; index >= 0; index -= 1) {
        if (Date.parse(this.#events[index]!.timestamp) > timestamp) continue;
        lastIndex = index;
        break;
      }
      included = lastIndex === -1 ? [] : this.#events.slice(0, lastIndex + 1);
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
    const fingerprint = createQueryFingerprint("relationship-events", {
      order: "append-sequence",
    });
    const snapshot =
      options.cursor === undefined
        ? this.version
        : Number(decodeQueryCursorState(options.cursor, fingerprint).snapshot);
    if (
      !Number.isSafeInteger(snapshot) ||
      snapshot < 0 ||
      snapshot > this.version
    )
      throw new TypeError(
        "Relationship event cursor snapshot version is invalid",
      );
    const page = paginateQueryRows(this.#events.slice(0, snapshot), {
      cursor: options.cursor,
      fingerprint,
      limit: options.limit,
      readId: (event) => event.eventId,
      snapshot: String(snapshot),
    });
    return {
      version: snapshot,
      events: page.rows,
      hasMore: page.has_more,
      ...(page.next_cursor ? { nextCursor: page.next_cursor } : {}),
    };
  }
}

const RELATIONSHIP_STORE_LOCK_ID = "relationship-event-store";
const RELATIONSHIP_NOFOLLOW_FLAG = constants.O_NOFOLLOW;

function acquireRelationshipStoreLock(
  pmRoot: string,
): Promise<() => Promise<void>> {
  return acquireLock(
    pmRoot,
    RELATIONSHIP_STORE_LOCK_ID,
    30,
    `relationship-store:${process.pid}`,
    false,
    false,
    3_000,
  );
}

async function resolveRelationshipEventStorePath(
  pmRoot: string,
  relativePath = "relationships/events.jsonl",
): Promise<string> {
  const root = path.resolve(pmRoot);
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (relative.length === 0)
    throw new TypeError(
      "Relationship event path must name a file within the tracker root",
    );
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new TypeError(
      "Relationship event path must stay within the tracker root",
    );
  await mkdir(root, { recursive: true });
  const rootStats = await lstat(root);
  if (rootStats.isSymbolicLink())
    throw new TypeError(
      "Relationship event tracker root must not be a symbolic link",
    );
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new TypeError(
          "Relationship event path must not contain symbolic links",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  return target;
}

async function loadRelationshipEventLog(
  target: string,
  nodes: readonly string[],
  registry: RelationshipKindRegistry | undefined,
): Promise<RelationshipEventLog> {
  const log = new RelationshipEventLog(nodes, { registry });
  let raw: string;
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      target,
      constants.O_RDONLY | RELATIONSHIP_NOFOLLOW_FLAG,
    );
    raw = await handle.readFile("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return log;
    throw error;
  } finally {
    await handle?.close();
  }
  const lines = raw.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line) continue;
    let stored: RelationshipEvent;
    try {
      stored = JSON.parse(line) as RelationshipEvent;
    } catch {
      throw new TypeError(
        `Invalid relationship event JSONL at line ${index + 1}`,
      );
    }
    if (stored.sequence !== log.version + 1)
      throw new TypeError(
        `Invalid relationship event sequence at line ${index + 1}`,
      );
    log.append({
      eventId: stored.eventId,
      relationshipId: stored.relationshipId,
      action: stored.action,
      ...(stored.edge === undefined ? {} : { edge: stored.edge }),
      author: stored.author,
      timestamp: stored.timestamp,
      ...(stored.reason === undefined ? {} : { reason: stored.reason }),
      expectedVersion: log.version,
    });
  }
  return log;
}

/**
 * Lock-serialized durable JSONL adapter for {@link RelationshipEventLog}.
 * Every append replays the current stream while holding the workspace lock, so
 * independent processes share optimistic versions without lost updates.
 */
export class RelationshipEventStore {
  readonly #pmRoot: string;
  readonly #nodes: readonly string[];
  readonly #registry: RelationshipKindRegistry | undefined;
  readonly #path: string;
  #log: RelationshipEventLog;

  private constructor(
    options: RelationshipEventStoreOptions,
    nodes: readonly string[],
    target: string,
    log: RelationshipEventLog,
  ) {
    this.#pmRoot = options.pmRoot;
    this.#nodes = nodes;
    this.#registry = options.registry;
    this.#path = target;
    this.#log = log;
  }

  /** Open and validate an existing stream or create an empty store view. */
  public static async open(
    options: RelationshipEventStoreOptions,
  ): Promise<RelationshipEventStore> {
    const nodes = Object.freeze([...options.nodes]);
    const target = await resolveRelationshipEventStorePath(
      options.pmRoot,
      options.relativePath,
    );
    const release = await acquireRelationshipStoreLock(options.pmRoot);
    try {
      await resolveRelationshipEventStorePath(options.pmRoot, target);
      const log = await loadRelationshipEventLog(
        target,
        nodes,
        options.registry,
      );
      return new RelationshipEventStore(options, nodes, target, log);
    } finally {
      await release();
    }
  }

  /** Absolute JSONL path, exposed for diagnostics and backup tooling. */
  public get path(): string {
    return this.#path;
  }

  /** Refresh from durable history and return the current validated append sequence. */
  public async currentVersion(): Promise<number> {
    this.#log = await this.#refreshFromDurableHistory();
    return this.#log.version;
  }

  /** Append one event after refreshing under the shared workspace lock. */
  public async append(
    input: RelationshipEventInput,
  ): Promise<RelationshipEvent> {
    const release = await acquireRelationshipStoreLock(this.#pmRoot);
    try {
      const target = await resolveRelationshipEventStorePath(
        this.#pmRoot,
        this.#path,
      );
      const refreshed = await loadRelationshipEventLog(
        target,
        this.#nodes,
        this.#registry,
      );
      const event = refreshed.append(input);
      await mkdir(path.dirname(target), { recursive: true });
      await resolveRelationshipEventStorePath(this.#pmRoot, target);
      const handle = await open(
        target,
        constants.O_APPEND |
          constants.O_CREAT |
          constants.O_WRONLY |
          RELATIONSHIP_NOFOLLOW_FLAG,
      );
      try {
        await handle.appendFile(`${JSON.stringify(event)}\n`, "utf8");
      } finally {
        await handle.close();
      }
      this.#log = refreshed;
      return event;
    } finally {
      await release();
    }
  }

  /** Refresh from durable history and materialize an exact validated snapshot. */
  public async snapshot(
    options: Parameters<RelationshipEventLog["snapshot"]>[0] = {},
  ): Promise<RelationshipSnapshot> {
    this.#log = await this.#refreshFromDurableHistory();
    return this.#log.snapshot(options);
  }

  /** Refresh from durable history and page immutable events. */
  public async page(
    options: Parameters<RelationshipEventLog["page"]>[0],
  ): Promise<RelationshipEventPage> {
    this.#log = await this.#refreshFromDurableHistory();
    return this.#log.page(options);
  }

  /**
   * Refresh once under the shared store lock, then stream a coherent immutable
   * prefix without holding the writer lock while the consumer processes batches.
   */
  public async *stream(
    options: RelationshipEventStreamOptions = {},
  ): AsyncGenerator<readonly RelationshipEvent[]> {
    this.#log = await this.#refreshFromDurableHistory();
    yield* this.#log.stream(options);
  }

  /** Refresh once and fold a coherent durable prefix into application state. */
  public async project<State>(
    initialState: State,
    reducer: RelationshipEventReducer<State>,
    options: Omit<RelationshipEventStreamOptions, "batchSize"> = {},
  ): Promise<RelationshipEventProjection<State>> {
    this.#log = await this.#refreshFromDurableHistory();
    return this.#log.project(initialState, reducer, options);
  }

  /** Serialize a durable refresh with writers so readers never observe a torn JSONL tail. */
  async #refreshFromDurableHistory(): Promise<RelationshipEventLog> {
    const release = await acquireRelationshipStoreLock(this.#pmRoot);
    try {
      const target = await resolveRelationshipEventStorePath(
        this.#pmRoot,
        this.#path,
      );
      return await loadRelationshipEventLog(
        target,
        this.#nodes,
        this.#registry,
      );
    } finally {
      await release();
    }
  }
}
