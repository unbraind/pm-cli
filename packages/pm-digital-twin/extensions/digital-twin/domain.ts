/**
 * @module packages/pm-digital-twin/extensions/digital-twin/domain
 *
 * Pure temporal projection, checkpoint, invariant, and replica-merge
 * primitives for the public-SDK-only production-facility exemplar.
 */
import { createHash } from "node:crypto";
import type {
  ExtensionCommandSdk,
  RelationshipEdge,
  RelationshipEvent,
  RelationshipEventInput,
  RelationshipGraph,
  RelationshipImpactAnalysis,
  RelationshipKindDefinition,
} from "@unbrained/pm-cli/sdk";

/** Current event payload generation emitted by the exemplar. */
export const TWIN_SCHEMA_VERSION = 2;

/** Package-owned relationship ontology used by state and topology events. */
export const TWIN_RELATIONSHIP_KINDS = [
  {
    kind: "twin_state",
    direction: "directed",
    ordering: false,
    hierarchy: false,
    outgoing: "many",
    incoming: "one",
    lifecycle: "supersedable",
    compatibilityVersion: 1,
    allowSelf: true,
    payloadSchema: {
      type: "object",
      required: [
        "event_id",
        "state",
        "observed_at",
        "source",
        "schema_version",
        "replica_id",
        "counter",
      ],
    },
  },
  {
    kind: "twin_contains",
    direction: "directed",
    inverse: "twin_contained_by",
    ordering: false,
    hierarchy: true,
    hierarchyDirection: "source_parent",
    outgoing: "many",
    incoming: "one",
    lifecycle: "supersedable",
    compatibilityVersion: 1,
    allowSelf: false,
  },
  {
    kind: "twin_feeds",
    direction: "directed",
    inverse: "twin_fed_by",
    ordering: true,
    precedence: "source_before_target",
    hierarchy: false,
    outgoing: "many",
    incoming: "many",
    lifecycle: "supersedable",
    compatibilityVersion: 1,
    allowSelf: false,
  },
  {
    kind: "twin_depends_on_utility",
    direction: "directed",
    inverse: "twin_utility_for",
    ordering: true,
    precedence: "target_before_source",
    hierarchy: false,
    outgoing: "many",
    incoming: "many",
    lifecycle: "supersedable",
    compatibilityVersion: 1,
    allowSelf: false,
  },
] as const satisfies readonly RelationshipKindDefinition[];

/** Application state carried by one immutable `twin_state` event. */
export interface TwinStatePayload {
  /** Globally unique domain event id. */
  event_id: string;
  /** Domain state after applying this event. */
  state: string;
  /** Event-time timestamp, independent of append time. */
  observed_at: string;
  /** Sensor, operator, importer, or service provenance. */
  source: string;
  /** Payload schema generation. */
  schema_version: number;
  /** Offline or federated replica identifier. */
  replica_id: string;
  /** Monotonic counter within one entity and replica. */
  counter: number;
  /** Earlier event corrected by this event. */
  supersedes_event_id?: string;
}

/** Materialized current or point-in-time entity state. */
export interface TwinEntityState extends TwinStatePayload {
  /** Entity whose state was reconstructed. */
  entity_id: string;
  /** Append sequence of the winning immutable event. */
  sequence: number;
  /** Attributable pm actor who appended the event. */
  author: string;
}

/** Explicit deterministic conflict surfaced during replica replay. */
export interface TwinConflict {
  /** Stable conflict classification. */
  code: "replica_counter_collision" | "event_id_collision";
  /** Entity affected when the conflict is state-specific. */
  entity_id?: string;
  /** Event id retained by deterministic tie-breaking. */
  winner_event_id: string;
  /** Event id rejected or shadowed by the winner. */
  loser_event_id: string;
}

/** Domain invariant finding returned without mutating history. */
export interface TwinInvariantViolation {
  /** Stable machine-readable invariant code. */
  code:
    | "counter_gap"
    | "missing_superseded_event"
    | "unsupported_schema_version"
    | "upstream_not_running"
    | "utility_not_running";
  /** Entity whose context violates the invariant. */
  entity_id: string;
  /** Human-readable, bounded explanation. */
  detail: string;
  /** Related entity when topology caused the violation. */
  related_id?: string;
}

/** Deterministic event replay result. */
export interface TwinReplayResult {
  /** State keyed by entity id. */
  states: Record<string, TwinEntityState>;
  /** Explicit replica conflicts. */
  conflicts: TwinConflict[];
  /** Event-level and topology-level invariant findings. */
  violations: TwinInvariantViolation[];
  /** Number of state events included by the time bound. */
  processed: number;
  /** Highest append sequence included, even for non-contiguous event-time reads. */
  version: number;
  /** Point-in-time boundary used by the replay. */
  as_of?: string;
}

/** Tamper-evident checkpoint over a deterministic immutable event selection. */
export interface TwinCheckpoint {
  /** Highest append sequence included. */
  version: number;
  /** Number of included events. */
  event_count: number;
  /** Optional event-time boundary. */
  as_of?: string;
  /** SHA-256 digest of canonical event content. */
  digest: string;
}

/** Portable bounded export used by offline replicas and backup tooling. */
export interface TwinExportBundle {
  /** Stable bundle format generation. */
  format_version: 1;
  /** Complete node universe required to validate replay. */
  nodes: string[];
  /** Immutable event rows in append order. */
  events: RelationshipEvent[];
  /** Checkpoint proving the exported rows are unchanged. */
  checkpoint: TwinCheckpoint;
  /** Whether a caller-requested limit omitted events. */
  truncated: boolean;
}

/** Deterministic merge plan for several offline replica streams. */
export interface TwinReplicaMerge {
  /** Unique inputs sorted by event time then id. */
  events: RelationshipEventInput[];
  /** Same-id, different-content conflicts requiring explicit disposition. */
  conflicts: TwinConflict[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, field: keyof TwinStatePayload): string {
  if (typeof value !== "string" || !value.trim())
    throw new TypeError(`Digital twin state payload requires ${field}`);
  return value.trim();
}

/** Normalize legacy state vocabulary into the current schema generation. */
export function normalizeTwinState(
  state: string,
  schemaVersion: number,
): string {
  const normalized = state.trim().toLowerCase();
  return schemaVersion === 1 && normalized === "idle" ? "standby" : normalized;
}

/** Parse and validate one package-owned state edge payload. */
export function parseTwinStateEvent(
  event: RelationshipEvent,
): TwinEntityState | undefined {
  if (event.action === "remove" || event.edge?.kind !== "twin_state")
    return undefined;
  const payload = event.edge.payload;
  if (!isRecord(payload))
    throw new TypeError(`Digital twin event ${event.eventId} requires payload`);
  const schemaVersion = payload.schema_version;
  const counter = payload.counter;
  if (!Number.isInteger(schemaVersion) || Number(schemaVersion) < 1)
    throw new TypeError(
      `Digital twin event ${event.eventId} has invalid schema_version`,
    );
  if (!Number.isInteger(counter) || Number(counter) < 1)
    throw new TypeError(
      `Digital twin event ${event.eventId} has invalid counter`,
    );
  const observedAt = requiredString(payload.observed_at, "observed_at");
  if (!Number.isFinite(Date.parse(observedAt)))
    throw new TypeError(
      `Digital twin event ${event.eventId} has invalid observed_at`,
    );
  const supersedes =
    payload.supersedes_event_id === undefined
      ? undefined
      : requiredString(payload.supersedes_event_id, "supersedes_event_id");
  return {
    entity_id: event.edge.target,
    event_id: requiredString(payload.event_id, "event_id"),
    state: normalizeTwinState(
      requiredString(payload.state, "state"),
      Number(schemaVersion),
    ),
    observed_at: new Date(observedAt).toISOString(),
    source: requiredString(payload.source, "source"),
    schema_version: Number(schemaVersion),
    replica_id: requiredString(payload.replica_id, "replica_id"),
    counter: Number(counter),
    ...(supersedes === undefined ? {} : { supersedes_event_id: supersedes }),
    sequence: event.sequence,
    author: event.author,
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

function canonicalEventInput(input: RelationshipEventInput): string {
  const normalized = {
    ...input,
    timestamp: new Date(input.timestamp).toISOString(),
    expectedVersion: undefined,
  };
  return JSON.stringify(canonicalize(normalized));
}

function eventsAt(
  events: readonly RelationshipEvent[],
  atTimestamp?: string,
): RelationshipEvent[] {
  if (atTimestamp === undefined) return [...events];
  const timestamp = Date.parse(atTimestamp);
  if (!Number.isFinite(timestamp))
    throw new TypeError("Digital twin replay timestamp must be valid");
  return events.filter((event) => Date.parse(event.timestamp) <= timestamp);
}

interface TwinReplayAccumulator {
  states: Map<string, TwinEntityState>;
  knownEvents: Set<string>;
  counters: Map<string, { counter: number; eventId: string }>;
  conflicts: TwinConflict[];
  violations: TwinInvariantViolation[];
}

/**
 * Apply one parsed state event to the deterministic replica clocks and
 * materialized entity-state projection.
 */
function applyTwinStateEvent(
  state: TwinEntityState,
  accumulator: TwinReplayAccumulator,
): void {
  if (state.schema_version > TWIN_SCHEMA_VERSION)
    accumulator.violations.push({
      code: "unsupported_schema_version",
      entity_id: state.entity_id,
      detail: `schema ${state.schema_version} exceeds supported ${TWIN_SCHEMA_VERSION}`,
    });
  if (
    state.supersedes_event_id !== undefined &&
    !accumulator.knownEvents.has(state.supersedes_event_id)
  )
    accumulator.violations.push({
      code: "missing_superseded_event",
      entity_id: state.entity_id,
      detail: `correction references missing event ${state.supersedes_event_id}`,
    });
  const counterKey = `${state.entity_id}\u0000${state.replica_id}`;
  const prior = accumulator.counters.get(counterKey);
  if (prior !== undefined && state.counter > prior.counter + 1)
    accumulator.violations.push({
      code: "counter_gap",
      entity_id: state.entity_id,
      detail: `replica ${state.replica_id} advanced from ${prior.counter} to ${state.counter}`,
    });
  if (prior !== undefined && state.counter === prior.counter)
    accumulator.conflicts.push({
      code: "replica_counter_collision",
      entity_id: state.entity_id,
      winner_event_id: [prior.eventId, state.event_id].sort()[0]!,
      loser_event_id: [prior.eventId, state.event_id].sort()[1]!,
    });
  if (
    prior === undefined ||
    state.counter > prior.counter ||
    (state.counter === prior.counter &&
      state.event_id.localeCompare(prior.eventId) < 0)
  ) {
    accumulator.counters.set(counterKey, {
      counter: state.counter,
      eventId: state.event_id,
    });
    accumulator.states.set(state.entity_id, state);
  }
  accumulator.knownEvents.add(state.event_id);
}

/** Replay immutable state events using event time, including late arrivals. */
export function replayTwinEvents(
  events: readonly RelationshipEvent[],
  options: { atTimestamp?: string } = {},
): TwinReplayResult {
  const included = eventsAt(events, options.atTimestamp);
  const accumulator: TwinReplayAccumulator = {
    states: new Map<string, TwinEntityState>(),
    knownEvents: new Set<string>(),
    counters: new Map<string, { counter: number; eventId: string }>(),
    conflicts: [],
    violations: [],
  };
  let processed = 0;
  for (const event of included) {
    if (
      event.action === "remove" &&
      event.relationshipId.startsWith("state:")
    ) {
      accumulator.states.delete(event.relationshipId.slice("state:".length));
      continue;
    }
    const state = parseTwinStateEvent(event);
    if (state === undefined) continue;
    processed += 1;
    applyTwinStateEvent(state, accumulator);
  }
  return {
    states: Object.fromEntries(
      [...accumulator.states].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    conflicts: accumulator.conflicts,
    violations: accumulator.violations,
    processed,
    version: included.at(-1)?.sequence ?? 0,
    ...(options.atTimestamp === undefined
      ? {}
      : { as_of: new Date(options.atTimestamp).toISOString() }),
  };
}

/** Build the exact topology graph effective at one event-time boundary. */
export function materializeTwinTopology(
  runtime: ExtensionCommandSdk,
  nodes: readonly string[],
  events: readonly RelationshipEvent[],
  atTimestamp?: string,
): RelationshipGraph {
  const active = new Map<string, RelationshipEdge>();
  for (const event of eventsAt(events, atTimestamp)) {
    if (event.edge?.kind === "twin_state") continue;
    if (event.action === "remove") active.delete(event.relationshipId);
    else if (event.edge !== undefined)
      active.set(event.relationshipId, event.edge);
  }
  return runtime.createRelationshipGraph({
    nodes,
    edges: active.values(),
    definitions: TWIN_RELATIONSHIP_KINDS,
  });
}

/** Evaluate operational invariants against a reconstructed topology and state. */
export function evaluateTwinInvariants(
  graph: RelationshipGraph,
  states: Readonly<Record<string, TwinEntityState>>,
): TwinInvariantViolation[] {
  const violations: TwinInvariantViolation[] = [];
  for (const edge of graph.edges()) {
    if (
      edge.kind === "twin_depends_on_utility" &&
      states[edge.source]?.state === "running" &&
      states[edge.target]?.state !== "running"
    )
      violations.push({
        code: "utility_not_running",
        entity_id: edge.source,
        related_id: edge.target,
        detail: `running asset depends on non-running utility ${edge.target}`,
      });
    if (
      edge.kind === "twin_feeds" &&
      states[edge.target]?.state === "running" &&
      states[edge.source]?.state !== "running"
    )
      violations.push({
        code: "upstream_not_running",
        entity_id: edge.target,
        related_id: edge.source,
        detail: `running asset is fed by non-running upstream ${edge.source}`,
      });
  }
  return violations;
}

/** Return bounded downstream impact with exact explanation paths. */
export function analyzeTwinImpact(
  runtime: ExtensionCommandSdk,
  graph: RelationshipGraph,
  root: string,
  options: { limit?: number; maxDepth?: number } = {},
): RelationshipImpactAnalysis {
  return runtime.analyzeRelationshipImpact(graph, root, {
    direction: "outgoing",
    kinds: ["twin_feeds"],
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
  });
}

/** Create a canonical tamper-evident checkpoint over one event-time selection. */
export function createTwinCheckpoint(
  events: readonly RelationshipEvent[],
  atTimestamp?: string,
): TwinCheckpoint {
  const included = eventsAt(events, atTimestamp);
  const digest = createHash("sha256")
    .update(JSON.stringify(canonicalize(included)))
    .digest("hex");
  return {
    version: included.at(-1)?.sequence ?? 0,
    event_count: included.length,
    ...(atTimestamp === undefined
      ? {}
      : { as_of: new Date(atTimestamp).toISOString() }),
    digest: `sha256:${digest}`,
  };
}

/** Verify that immutable event content still matches a stored checkpoint. */
export function verifyTwinCheckpoint(
  events: readonly RelationshipEvent[],
  checkpoint: TwinCheckpoint,
): boolean {
  const candidate = createTwinCheckpoint(events, checkpoint.as_of);
  return (
    candidate.version === checkpoint.version &&
    candidate.event_count === checkpoint.event_count &&
    candidate.digest === checkpoint.digest
  );
}

/** Produce a bounded portable event bundle with an integrity checkpoint. */
export function exportTwinBundle(
  nodes: readonly string[],
  events: readonly RelationshipEvent[],
  options: { atTimestamp?: string; limit?: number } = {},
): TwinExportBundle {
  if (
    options.limit !== undefined &&
    (!Number.isInteger(options.limit) || options.limit < 1)
  )
    throw new TypeError("Digital twin export limit must be positive");
  const included = eventsAt(events, options.atTimestamp);
  const selected =
    options.limit === undefined ? included : included.slice(0, options.limit);
  return {
    format_version: 1,
    nodes: [...new Set(nodes)].sort(),
    events: selected,
    checkpoint: createTwinCheckpoint(selected),
    truncated: selected.length < included.length,
  };
}

/** Validate one untrusted portable bundle and its tamper-evident checkpoint. */
export function parseTwinBundle(value: unknown): TwinExportBundle {
  if (!isRecord(value) || value.format_version !== 1)
    throw new TypeError("Digital twin bundle format_version must be 1");
  if (
    !Array.isArray(value.nodes) ||
    value.nodes.some((node) => typeof node !== "string" || !node.trim()) ||
    !Array.isArray(value.events) ||
    !isRecord(value.checkpoint) ||
    typeof value.truncated !== "boolean"
  )
    throw new TypeError("Digital twin bundle structure is invalid");
  const bundle = value as unknown as TwinExportBundle;
  if (!verifyTwinCheckpoint(bundle.events, bundle.checkpoint))
    throw new TypeError("Digital twin bundle checkpoint mismatch");
  return bundle;
}

/** Merge offline replica inputs deterministically without hiding collisions. */
export function mergeTwinReplicaEvents(
  replicas: readonly (readonly RelationshipEventInput[])[],
): TwinReplicaMerge {
  const unique = new Map<
    string,
    { input: RelationshipEventInput; canonical: string }
  >();
  const conflicts: TwinConflict[] = [];
  for (const input of replicas.flat()) {
    const canonical = canonicalEventInput(input);
    const existing = unique.get(input.eventId);
    if (existing === undefined) {
      unique.set(input.eventId, { input, canonical });
      continue;
    }
    if (existing.canonical === canonical) continue;
    const winner =
      canonical.localeCompare(existing.canonical) < 0
        ? { input, canonical }
        : existing;
    const loser = winner === existing ? input : existing.input;
    unique.set(input.eventId, winner);
    conflicts.push({
      code: "event_id_collision",
      winner_event_id: winner.input.eventId,
      loser_event_id: loser.eventId,
    });
  }
  return {
    events: [...unique.values()]
      .map(({ input }) => ({ ...input, expectedVersion: undefined }))
      .sort(
        (left, right) =>
          Date.parse(left.timestamp) - Date.parse(right.timestamp) ||
          left.eventId.localeCompare(right.eventId),
      ),
    conflicts,
  };
}

/** Validate imported events with the same public SDK ledger used at runtime. */
export function validateTwinImport(
  runtime: ExtensionCommandSdk,
  nodes: readonly string[],
  inputs: readonly RelationshipEventInput[],
): RelationshipEvent[] {
  return runtime.validateRelationshipEvents({
    nodes,
    definitions: TWIN_RELATIONSHIP_KINDS,
    events: inputs,
  });
}
