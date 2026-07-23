/**
 * @module packages/pm-digital-twin/extensions/digital-twin/index
 *
 * Installable production-facility digital-twin exemplar authored exclusively
 * against the published pm SDK and extension command context.
 */
import type {
  CommandDefinition,
  CommandHandlerContext,
  ExtensionApi,
  GetResult,
  ItemMetadata,
  PmClient,
  ProjectProfileDefinition,
  RelationshipEvent,
  RelationshipEventInput,
  RelationshipEventStore,
  SchemaFieldDefinition,
  SchemaItemTypeDefinition,
  WorkspaceTransactionStep,
} from "@unbrained/pm-cli/sdk";
import {
  TWIN_RELATIONSHIP_KINDS,
  TWIN_SCHEMA_VERSION,
  analyzeTwinImpact,
  createTwinCheckpoint,
  evaluateTwinInvariants,
  exportTwinBundle,
  materializeTwinTopology,
  mergeTwinReplicaEvents,
  parseTwinBundle,
  replayTwinEvents,
  validateTwinImport,
  verifyTwinCheckpoint,
  type TwinStatePayload,
} from "./domain.ts";

/** Declarative package manifest consumed by the extension loader. */
export const manifest = {
  name: "builtin-digital-twin-exemplar",
  version: "0.1.0",
  entry: "./index.ts",
  priority: 0,
  capabilities: ["commands", "schema"],
};

/** Digital-twin entity types contributed without changing core item schemas. */
export const TWIN_ITEM_TYPES = [
  {
    name: "TwinFacility",
    folder: "twin-facilities",
    aliases: ["facility", "site"],
    required_create_fields: ["twin_external_id", "twin_entity_kind"],
  },
  {
    name: "TwinAsset",
    folder: "twin-assets",
    aliases: ["asset", "machine", "sensor", "utility"],
    required_create_fields: [
      "twin_external_id",
      "twin_entity_kind",
      "twin_facility",
    ],
  },
] satisfies Array<
  SchemaItemTypeDefinition & { folder: string; aliases: string[] }
>;

/** Domain metadata retained on stable entity identities. */
export const TWIN_ITEM_FIELDS: SchemaFieldDefinition[] = [
  { name: "twin_external_id", type: "string", optional: false },
  { name: "twin_entity_kind", type: "string", optional: false },
  { name: "twin_facility", type: "string", optional: true },
  { name: "twin_schema_version", type: "number", optional: false },
  { name: "twin_replica", type: "string", optional: true },
];

/** Complete foreign-domain profile available through `pm profile apply twin`. */
export const twinProfile: ProjectProfileDefinition = {
  name: "twin",
  title: "Production facility digital twin",
  summary:
    "Temporal assets, observations, topology, invariants, and offline replica reconciliation.",
  types: TWIN_ITEM_TYPES.map((definition) => ({
    name: definition.name,
    folder: definition.folder,
    aliases: [...definition.aliases],
  })),
  statuses: [],
  fields: TWIN_ITEM_FIELDS.map((field) => ({
    key: field.name,
    type: field.type,
    commands: ["create", "update", "list"],
    description: `Digital twin exemplar field ${field.name}.`,
  })),
  workflows: [],
  config: [],
  templates: [],
  packages: [],
};

interface TwinListResult {
  items: Array<Partial<ItemMetadata>>;
}

/** Structured output shared by digital-twin commands. */
export interface TwinCommandResult {
  /** Stable domain action. */
  action: string;
  /** Primary entity identifier. */
  id?: string;
  /** Command-specific bounded details. */
  details?: Record<string, unknown>;
}

function sdkFor(
  context: CommandHandlerContext,
): NonNullable<CommandHandlerContext["sdk"]> {
  if (context.sdk === undefined)
    throw new TypeError(
      "digital twin requires the extension command SDK runtime",
    );
  return context.sdk;
}

function authorFor(context: CommandHandlerContext): string {
  return typeof context.global.author === "string" &&
    context.global.author.trim()
    ? context.global.author.trim()
    : "pm-digital-twin";
}

function requiredArgument(
  context: CommandHandlerContext,
  label: string,
): string {
  const value = context.args.find((argument) => !argument.startsWith("-"));
  if (!value?.trim()) throw new TypeError(`digital twin requires ${label}`);
  return value.trim();
}

function stringOption(
  context: CommandHandlerContext,
  key: string,
  required = true,
): string | undefined {
  const camel = key.replaceAll(/_([a-z])/g, (_match, letter: string) =>
    letter.toUpperCase(),
  );
  const value = context.options[key] ?? context.options[camel];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (required)
    throw new TypeError(`digital twin requires --${key.replaceAll("_", "-")}`);
  return undefined;
}

function positiveIntegerOption(
  context: CommandHandlerContext,
  key: string,
  fallback?: number,
): number | undefined {
  const camel = key.replaceAll(/_([a-z])/g, (_match, letter: string) =>
    letter.toUpperCase(),
  );
  const candidate = context.options[key] ?? context.options[camel];
  const raw =
    typeof candidate === "number"
      ? String(candidate)
      : stringOption(context, key, false);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1)
    throw new TypeError(
      `digital twin --${key.replaceAll("_", "-")} must be positive`,
    );
  return value;
}

async function listTwinNodes(client: PmClient): Promise<string[]> {
  const results = await Promise.all(
    ["TwinFacility", "TwinAsset"].map(
      async (type) =>
        (await client.list({
          type,
          status: "all",
          noTruncate: true,
        })) as TwinListResult,
    ),
  );
  return results
    .flatMap(({ items }) => items)
    .map(({ id }) => id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .sort();
}

async function openTwinStore(
  context: CommandHandlerContext,
  additionalNodes: readonly string[] = [],
): Promise<RelationshipEventStore> {
  const client = sdkFor(context).client;
  return sdkFor(context).openRelationshipEventStore({
    nodes: [...(await listTwinNodes(client)), ...additionalNodes],
    definitions: TWIN_RELATIONSHIP_KINDS,
    relativePath: "relationships/digital-twin-events.jsonl",
  });
}

async function readTwinEvents(
  store: RelationshipEventStore,
): Promise<RelationshipEvent[]> {
  const events: RelationshipEvent[] = [];
  for await (const batch of store.stream()) events.push(...batch);
  return events;
}

async function getTwinItem(client: PmClient, id: string): Promise<GetResult> {
  const result = await client.get(id, { depth: "deep" });
  if (!["TwinFacility", "TwinAsset"].includes(String(result.item.type)))
    throw new TypeError(`digital twin expected entity ${id}`);
  return result;
}

async function findEvent(
  store: RelationshipEventStore,
  eventId: string,
): Promise<RelationshipEvent | undefined> {
  for await (const batch of store.stream()) {
    const event = batch.find((candidate) => candidate.eventId === eventId);
    if (event !== undefined) return event;
  }
  return undefined;
}

function statePayload(
  context: CommandHandlerContext,
  eventId: string,
): TwinStatePayload {
  const observedAt =
    stringOption(context, "observed_at", false) ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(observedAt)))
    throw new TypeError("digital twin --observed-at must be a timestamp");
  return {
    event_id: eventId,
    state: stringOption(context, "state")!,
    observed_at: new Date(observedAt).toISOString(),
    source: stringOption(context, "source", false) ?? authorFor(context),
    schema_version: positiveIntegerOption(
      context,
      "schema_version",
      TWIN_SCHEMA_VERSION,
    )!,
    replica_id: stringOption(context, "replica", false) ?? "primary",
    counter: positiveIntegerOption(context, "counter", 1)!,
    ...(stringOption(context, "supersedes", false) === undefined
      ? {}
      : { supersedes_event_id: stringOption(context, "supersedes")! }),
  };
}

function stateEventInput(
  context: CommandHandlerContext,
  facilityId: string,
  entityId: string,
  eventId: string,
  action: "add" | "supersede",
  expectedVersion?: number,
): RelationshipEventInput {
  const payload = statePayload(context, eventId);
  return {
    eventId,
    relationshipId: `state:${entityId}`,
    action,
    edge: {
      source: facilityId,
      target: entityId,
      kind: "twin_state",
      payload: { ...payload },
    },
    author: authorFor(context),
    timestamp: payload.observed_at,
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
    reason:
      action === "add"
        ? "Initialize digital twin entity state"
        : "Append digital twin observation",
  };
}

async function runEntityCreate(
  context: CommandHandlerContext,
): Promise<TwinCommandResult> {
  const requestedId = requiredArgument(context, "an entity id");
  const kind = stringOption(context, "kind")!;
  if (!["facility", "asset", "machine", "sensor", "utility"].includes(kind))
    throw new TypeError(
      "digital twin --kind must be facility, asset, machine, sensor, or utility",
    );
  const eventId = stringOption(context, "event_id")!;
  const client = sdkFor(context).client;
  const requestedFacilityId =
    kind === "facility" ? requestedId : stringOption(context, "facility")!;
  const facilityId =
    kind === "facility"
      ? requestedFacilityId
      : String((await getTwinItem(client, requestedFacilityId)).item.id);
  const type = kind === "facility" ? "TwinFacility" : "TwinAsset";
  const fields = [
    `twin_external_id=${stringOption(context, "external_id")!}`,
    `twin_entity_kind=${kind}`,
    `twin_schema_version=${TWIN_SCHEMA_VERSION}`,
    `twin_replica=${stringOption(context, "replica", false) ?? "primary"}`,
    ...(kind === "facility" ? [] : [`twin_facility=${facilityId}`]),
  ];
  const steps: WorkspaceTransactionStep[] = [
    {
      id: "create-entity",
      inspect: async () => {
        try {
          const existing = await getTwinItem(client, requestedId);
          return {
            state: "applied",
            result: { id: String(existing.item.id), type },
          };
        } catch (error) {
          if (sdkFor(context).isItemNotFoundError(error))
            return { state: "pending" };
          throw error;
        }
      },
      apply: async () => {
        const result = await client.create({
          id: requestedId,
          title: stringOption(context, "title", false) ?? requestedId,
          type,
          status: "open",
          field: fields,
          body: `# ${requestedId}\n\nDigital twin ${kind}.`,
        });
        return { id: result.item.id, type: result.item.type };
      },
      compensate: async () => {
        await client.close(
          requestedId,
          "Compensate interrupted digital twin create",
          {
            message: "Digital twin create transaction compensation",
          },
        );
      },
    },
    {
      id: "append-initial-state",
      inspect: async () => {
        const store = await openTwinStore(context);
        const existing = await findEvent(store, eventId);
        return existing === undefined
          ? { state: "pending" }
          : { state: "applied", result: { eventId: existing.eventId } };
      },
      apply: async () => {
        const entity = await getTwinItem(client, requestedId);
        const entityId = String(entity.item.id);
        const resolvedFacilityId =
          kind === "facility"
            ? entityId
            : String((await getTwinItem(client, facilityId)).item.id);
        const store = await openTwinStore(context);
        const event = await store.append(
          stateEventInput(
            context,
            resolvedFacilityId,
            entityId,
            eventId,
            "add",
          ),
        );
        return { eventId: event.eventId, sequence: event.sequence };
      },
      compensate: async () => {
        const entity = await getTwinItem(client, requestedId);
        const entityId = String(entity.item.id);
        const store = await openTwinStore(context);
        await store.append({
          eventId: `rollback-${eventId}`,
          relationshipId: `state:${entityId}`,
          action: "remove",
          author: authorFor(context),
          timestamp: new Date().toISOString(),
          reason: "Compensate interrupted digital twin entity create",
        });
      },
    },
  ];
  await sdkFor(context).commitWorkspaceTransaction({
    transactionId: `twin-create-${requestedId}`,
    author: authorFor(context),
    steps,
  });
  const entityId = String((await getTwinItem(client, requestedId)).item.id);
  return {
    action: "twin-entity-create",
    id: entityId,
    details: {
      type,
      facilityId: kind === "facility" ? entityId : facilityId,
    },
  };
}

async function runObserve(
  context: CommandHandlerContext,
): Promise<TwinCommandResult> {
  const requestedId = requiredArgument(context, "an entity id");
  const entity = await getTwinItem(sdkFor(context).client, requestedId);
  const id = String(entity.item.id);
  const facilityId =
    entity.item.type === "TwinFacility"
      ? id
      : String(entity.item.twin_facility ?? "");
  if (!facilityId)
    throw new TypeError(`digital twin entity ${id} is missing twin_facility`);
  const store = await openTwinStore(context);
  const events = await readTwinEvents(store);
  const active = events
    .filter((event) => event.relationshipId === `state:${id}`)
    .at(-1);
  if (active?.action === "remove")
    throw new TypeError(`digital twin entity ${id} state was retired`);
  const expectedVersion = positiveIntegerOption(
    context,
    "expected_version",
    undefined,
  );
  const eventId = stringOption(context, "event_id")!;
  const event = await store.append(
    stateEventInput(
      context,
      facilityId,
      id,
      eventId,
      active === undefined ? "add" : "supersede",
      expectedVersion,
    ),
  );
  return {
    action: "twin-observe",
    id,
    details: { event, previous_event_id: active?.eventId },
  };
}

const TOPOLOGY_KIND_BY_ALIAS = {
  contains: "twin_contains",
  feeds: "twin_feeds",
  utility: "twin_depends_on_utility",
} as const;

async function runRelate(
  context: CommandHandlerContext,
): Promise<TwinCommandResult> {
  const requestedSource = requiredArgument(context, "a source entity id");
  const requestedTarget = stringOption(context, "target")!;
  const client = sdkFor(context).client;
  const [sourceItem, targetItem] = await Promise.all([
    getTwinItem(client, requestedSource),
    getTwinItem(client, requestedTarget),
  ]);
  const source = String(sourceItem.item.id);
  const target = String(targetItem.item.id);
  const alias = stringOption(context, "kind")!;
  if (!(alias in TOPOLOGY_KIND_BY_ALIAS))
    throw new TypeError(
      "digital twin --kind must be contains, feeds, or utility",
    );
  const kind =
    TOPOLOGY_KIND_BY_ALIAS[alias as keyof typeof TOPOLOGY_KIND_BY_ALIAS];
  const relationshipId =
    stringOption(context, "relationship_id", false) ??
    `${kind}:${source}:${target}`;
  const eventId = stringOption(context, "event_id")!;
  const store = await openTwinStore(context);
  const latest = (await readTwinEvents(store))
    .filter((event) => event.relationshipId === relationshipId)
    .at(-1);
  const observedAt =
    stringOption(context, "observed_at", false) ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(observedAt)))
    throw new TypeError("digital twin --observed-at must be a timestamp");
  const expectedVersion = positiveIntegerOption(
    context,
    "expected_version",
    undefined,
  );
  const event = await store.append({
    eventId,
    relationshipId,
    action:
      latest === undefined || latest.action === "remove" ? "add" : "supersede",
    edge: {
      source,
      target,
      kind,
      payload: {
        observed_at: new Date(observedAt).toISOString(),
        source: stringOption(context, "source", false) ?? authorFor(context),
      },
    },
    author: authorFor(context),
    timestamp: observedAt,
    expectedVersion,
    reason: "Update digital twin topology",
  });
  return {
    action: "twin-relate",
    id: source,
    details: { event, target, kind },
  };
}

async function runQuery(
  context: CommandHandlerContext,
): Promise<TwinCommandResult> {
  const requestedId = requiredArgument(context, "an entity id");
  const id = String(
    (await getTwinItem(sdkFor(context).client, requestedId)).item.id,
  );
  const nodes = await listTwinNodes(sdkFor(context).client);
  const store = await openTwinStore(context);
  const events = await readTwinEvents(store);
  const at = stringOption(context, "at", false);
  const replay = replayTwinEvents(events, {
    ...(at === undefined ? {} : { atTimestamp: at }),
  });
  const graph = materializeTwinTopology(sdkFor(context), nodes, events, at);
  const violations = [
    ...replay.violations,
    ...evaluateTwinInvariants(graph, replay.states),
  ];
  const impact = analyzeTwinImpact(sdkFor(context), graph, id, {
    limit: positiveIntegerOption(context, "limit", 20),
    maxDepth: positiveIntegerOption(context, "max_depth", 8),
  });
  return {
    action: "twin-query",
    id,
    details: {
      state: replay.states[id] ?? null,
      version: replay.version,
      conflicts: replay.conflicts.filter(
        (conflict) =>
          conflict.entity_id === undefined || conflict.entity_id === id,
      ),
      violations: violations.filter(
        (violation) =>
          violation.entity_id === id || violation.related_id === id,
      ),
      topology: graph.neighborEdges(id, { direction: "both", limit: 50 }),
      impact,
    },
  };
}

async function runExport(
  context: CommandHandlerContext,
): Promise<TwinCommandResult> {
  const nodes = await listTwinNodes(sdkFor(context).client);
  const events = await readTwinEvents(await openTwinStore(context));
  return {
    action: "twin-export",
    details: {
      bundle: exportTwinBundle(nodes, events, {
        ...(stringOption(context, "at", false) === undefined
          ? {}
          : { atTimestamp: stringOption(context, "at")! }),
        ...(positiveIntegerOption(context, "limit", undefined) === undefined
          ? {}
          : { limit: positiveIntegerOption(context, "limit")! }),
      }),
    },
  };
}

async function runImport(
  context: CommandHandlerContext,
): Promise<TwinCommandResult> {
  const payload = stringOption(context, "payload")!;
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload) as unknown;
  } catch {
    throw new TypeError("digital twin --payload must be valid JSON");
  }
  const bundle = parseTwinBundle(decoded);
  const inputs = bundle.events.map(
    ({ sequence: _sequence, ...event }): RelationshipEventInput => event,
  );
  const merged = mergeTwinReplicaEvents([inputs]);
  if (merged.conflicts.length > 0)
    return {
      action: "twin-import",
      details: { imported: 0, conflicts: merged.conflicts },
    };
  validateTwinImport(sdkFor(context), bundle.nodes, merged.events);
  const store = await sdkFor(context).openRelationshipEventStore({
    nodes: [
      ...new Set([
        ...(await listTwinNodes(sdkFor(context).client)),
        ...bundle.nodes,
      ]),
    ],
    definitions: TWIN_RELATIONSHIP_KINDS,
    relativePath: "relationships/digital-twin-events.jsonl",
  });
  const result = await store.appendBatch(merged.events, {
    existingEventPolicy: "skip_identical",
  });
  return {
    action: "twin-import",
    details: {
      imported: result.appended.length,
      skipped: result.skipped_event_ids,
      version: result.version_after,
    },
  };
}

async function runVerify(
  context: CommandHandlerContext,
): Promise<TwinCommandResult> {
  const nodes = await listTwinNodes(sdkFor(context).client);
  const events = await readTwinEvents(await openTwinStore(context));
  const checkpoint = createTwinCheckpoint(
    events,
    stringOption(context, "at", false),
  );
  const replay = replayTwinEvents(events, {
    ...(checkpoint.as_of === undefined
      ? {}
      : { atTimestamp: checkpoint.as_of }),
  });
  const graph = materializeTwinTopology(
    sdkFor(context),
    nodes,
    events,
    checkpoint.as_of,
  );
  return {
    action: "twin-verify",
    details: {
      checkpoint,
      checkpoint_valid: verifyTwinCheckpoint(events, checkpoint),
      replay,
      violations: [
        ...replay.violations,
        ...evaluateTwinInvariants(graph, replay.states),
      ],
      graph: {
        nodes: graph.nodes().length,
        edges: graph.edges().length,
      },
    },
  };
}

const ENTITY_ARGUMENT = [
  { name: "id", required: true, description: "Digital twin entity id." },
];
const EVENT_FLAGS = [
  {
    long: "--event-id",
    value_name: "id",
    value_type: "string" as const,
    required: true,
  },
  {
    long: "--observed-at",
    value_name: "iso",
    value_type: "string" as const,
  },
  { long: "--source", value_name: "name", value_type: "string" as const },
  { long: "--replica", value_name: "id", value_type: "string" as const },
  { long: "--counter", value_name: "n", value_type: "number" as const },
];

/** Build every digital-twin command from one contract table. */
export function buildTwinCommands(): CommandDefinition[] {
  return [
    {
      name: "twin entity-create",
      action: "twin-entity-create",
      description:
        "Create a stable facility or asset identity and its first immutable state event.",
      arguments: ENTITY_ARGUMENT,
      flags: [
        { long: "--title", value_name: "text", value_type: "string" },
        {
          long: "--external-id",
          value_name: "id",
          value_type: "string",
          required: true,
        },
        {
          long: "--kind",
          value_name: "kind",
          value_type: "string",
          required: true,
        },
        { long: "--facility", value_name: "id", value_type: "string" },
        {
          long: "--state",
          value_name: "state",
          value_type: "string",
          required: true,
        },
        ...EVENT_FLAGS,
      ],
      run: runEntityCreate,
    },
    {
      name: "twin observe",
      action: "twin-observe",
      description:
        "Append an attributable observation or correction with optimistic concurrency.",
      arguments: ENTITY_ARGUMENT,
      flags: [
        {
          long: "--state",
          value_name: "state",
          value_type: "string",
          required: true,
        },
        ...EVENT_FLAGS,
        {
          long: "--schema-version",
          value_name: "n",
          value_type: "number",
        },
        { long: "--supersedes", value_name: "event-id", value_type: "string" },
        {
          long: "--expected-version",
          value_name: "n",
          value_type: "number",
        },
      ],
      run: runObserve,
    },
    {
      name: "twin relate",
      action: "twin-relate",
      description:
        "Append or supersede one typed containment, flow, or utility relationship.",
      arguments: ENTITY_ARGUMENT,
      flags: [
        {
          long: "--target",
          value_name: "id",
          value_type: "string",
          required: true,
        },
        {
          long: "--kind",
          value_name: "contains|feeds|utility",
          value_type: "string",
          required: true,
        },
        {
          long: "--relationship-id",
          value_name: "id",
          value_type: "string",
        },
        ...EVENT_FLAGS.slice(0, 3),
        {
          long: "--expected-version",
          value_name: "n",
          value_type: "number",
        },
      ],
      run: runRelate,
    },
    {
      name: "twin query",
      action: "twin-query",
      description:
        "Query point-in-time state, topology, provenance, conflicts, invariants, and impact.",
      arguments: ENTITY_ARGUMENT,
      flags: [
        { long: "--at", value_name: "iso", value_type: "string" },
        { long: "--limit", value_name: "n", value_type: "number" },
        { long: "--max-depth", value_name: "n", value_type: "number" },
      ],
      run: runQuery,
    },
    {
      name: "twin export",
      action: "twin-export",
      description:
        "Export a bounded shell-friendly event bundle with a tamper-evident checkpoint.",
      flags: [
        { long: "--at", value_name: "iso", value_type: "string" },
        { long: "--limit", value_name: "n", value_type: "number" },
      ],
      run: runExport,
    },
    {
      name: "twin import",
      action: "twin-import",
      description:
        "Validate and idempotently merge a portable offline replica bundle.",
      flags: [
        {
          long: "--payload",
          value_name: "json",
          value_type: "string",
          required: true,
        },
      ],
      run: runImport,
    },
    {
      name: "twin verify",
      action: "twin-verify",
      description:
        "Verify checkpoint integrity, deterministic replay, topology, and invariants.",
      flags: [{ long: "--at", value_name: "iso", value_type: "string" }],
      run: runVerify,
    },
  ];
}

/** Register the package-owned schema, ontology, profile, and commands. */
export function activate(api: ExtensionApi): void {
  api.registerItemFields(TWIN_ITEM_FIELDS);
  api.registerItemTypes(TWIN_ITEM_TYPES);
  api.registerRelationshipKinds([...TWIN_RELATIONSHIP_KINDS]);
  api.registerProfile(twinProfile);
  for (const command of buildTwinCommands()) api.registerCommand(command);
}

/** No process-global resources are retained by the package. */
export function deactivate(): void {}

export default { manifest, activate, deactivate };
