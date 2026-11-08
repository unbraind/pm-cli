/**
 * @module sdk/query/get
 *
 * Implements the SDK-owned item query shared by every surface.
 */
import { collectRegisteredItemFieldNames } from "../../core/extensions/item-fields.js";
import type { PmReadOutputMetadata } from "../read-output-contracts.js";
import { assertInitializedTracker } from "../environment/tracker-preflight.js";
import {
  getActiveExtensionRegistrations,
  toItemRecord,
  resolveItemTypeRegistry,
  resolveRuntimeFieldRegistry,
  resolveRuntimeStatusRegistry,
  EXIT_CODE,
  TYPE_TO_FOLDER,
  type GlobalOptions,
  PmCliError,
  buildItemNotFoundError,
  listAllItemMetadataLight,
  locateItem,
  readLocatedItem,
  getHistoryPath,
  resolvePmRoot,
  readSettings,
  resolveAuthor,
} from "../runtime-primitives.js";
import { readHistoryEntries } from "../history-read.js";
import { hashDocument } from "../../core/history/history.js";
import { renderPmCommand } from "../command-line.js";
import { recordContextUsageTouches } from "../context-usage.js";
import { collectBlockedByIds, type ResolvedBlocker } from "../actionability.js";
import { resolveDeclaredBlockers } from "./declared-blockers.js";
import {
  buildItemChildrenRollup,
  type ChildRollupContext,
} from "../item-children.js";
import {
  buildItemSchedule,
  type ItemScheduleContext,
} from "../item-schedule.js";
import { getItemAt, type GetItemAtResult } from "../history-read.js";
import { parseIntegerLimit } from "./parsers.js";
import type {
  ItemMetadata,
  Dependency,
  LinkedDoc,
  LinkedFile,
  LinkedTest,
} from "../../types/index.js";
import { runList } from "./list.js";
import { registerOutputMaterialFieldGroups } from "../output-projection.js";
import { GET_FACET_ROOTS, GET_NESTED_FACET_ROOTS } from "./get-facet-roots.js";
import {
  GET_DEPTH_INPUT_VALUES,
  GET_DEPTH_VALUES,
  listGetProjectionFields,
} from "./projection-contracts.js";
export {
  GET_DEPTH_INPUT_VALUES,
  GET_DEPTH_VALUES,
  listGetProjectionFields,
} from "./projection-contracts.js";

/** Latest claim or release coordinate exposed without its mutation patch. */
interface ClaimHistoryContext {
  ts: string;
  author: string;
  message: string | null;
}

/** Claim-history fields needed to reconstruct ownership at the selected read boundary. */
interface ClaimHistoryEntry {
  op: string;
  ts: string;
  author: string;
  message?: string;
}

/** Ownership from the selected item snapshot, accompanied by its latest claim and release events. */
interface ClaimStateContext {
  claimed: boolean;
  assignee: string | null;
  last_claim: ClaimHistoryContext | null;
  last_release: ClaimHistoryContext | null;
}

/** Depth or field-selected metadata; identity survives every projection. */
type GetItemProjection = {
  /** Metadata remains field-optional; dependency attribution additionally follows the selected detail mode. */
  [K in keyof ItemMetadata]?: K extends "dependencies"
    ? (Pick<Dependency, "id" | "kind"> & Partial<Dependency>)[]
    : ItemMetadata[K];
} & {
  /** Canonical item identity retained by every depth and field projection. */
  id: string;
  /** Item document body, included inside metadata for CLI/list parity. */
  body?: string;
  /** Number of notes omitted by a token-bounded projection. */
  notes_count?: number;
  /** Number of linked tests omitted by a token-bounded projection. */
  tests_count?: number;
  /** Stable cardinalities for every collection mutation surface. */
  collection_counts?: Readonly<{
    comments: number;
    notes: number;
    learnings: number;
    files: number;
    tests: number;
    docs: number;
    reminders: number;
    events: number;
  }>;
};

/** Single-item read with optional derived facets; omission materiality is carried separately from its JSON representation. */
export interface GetResult extends Partial<PmReadOutputMetadata> {
  // `body` lives inside `item` (alongside `description`/`acceptance_criteria`)
  // for parity with `pm list --include-body`, so agents reliably find it at
  // `.item.body` in JSON output instead of a top-level sibling.
  /** Selected metadata and body; requested empty collections are represented explicitly. */
  item: GetItemProjection;
  /**
   * Current revision: SHA-256 of the canonical item document, equal to its
   * latest history `after_hash`. Pass it to `--expect-hash` (SDK/MCP
   * `expectHash`) so a later write refuses if the item changed in between.
   * Omitted for historical `--at` reads.
   */
  item_hash?: string;
  /**
   * Requested artifact groups. Depth reads and the whole `linked` selector carry
   * all three groups; `linked.files`, `linked.tests` and `linked.docs` carry only
   * the selected groups, so a present empty array always means the group is empty
   * (GH-1663). Populated groups a nested selector left out are named by the
   * omission receipt as `linked.<group>`.
   */
  linked?: {
    files?: LinkedFile[];
    tests?: LinkedTest[];
    docs?: LinkedDoc[];
  };
  /**
   * Ownership evidence for the current or selected historical snapshot. Depth
   * reads and the whole `claim_state` selector carry every member; a
   * `claim_state.<member>` selector carries only the selected members (GH-1663).
   */
  claim_state?: Partial<ClaimStateContext>;
  /** Current child rollup for full or explicit child reads and deep container reads; historical hierarchy is not indexed. */
  children?: ChildRollupContext;
  /** Normalized scheduling data for scheduled item types and metadata. */
  schedule?: Partial<ItemScheduleContext>;
  /** Current state of forward-declared blockers; reverse graph edges require a corpus query and historical reads omit this current-state facet. */
  blockers?: {
    /** Explicit scope: scalar and blocked_by edges declared by this item. */
    scope: "declared";
    /** Nonterminal, missing and external references that still gate declared prerequisites. */
    open: Omit<ResolvedBlocker, "resolved">[];
    /** Declared references whose targets have terminal runtime statuses. */
    closed_count: number;
  };
  /** True when the item was reconstructed from immutable history. */
  reconstructed?: true;
  /** Durable version, or null when legacy compaction lost the numeric mapping. */
  as_of_version?: number | null;
  /** Timestamp of the last history entry included in a reconstructed read. */
  as_of_timestamp?: string;
  /** Current descendants selected through registered hierarchy semantics and the optional depth bound. */
  tree?: {
    root_id: string;
    root_title: string | null;
    depth_limit: number | null;
    count: number;
    items: Record<string, unknown>[];
  };
}

const AUTOMATIC_CHILD_ROLLUP_TYPES = new Set([
  "epic",
  "feature",
  "milestone",
  "plan",
]);
const BUILTIN_ITEM_TYPES = new Set(
  Object.keys(TYPE_TO_FOLDER).map((type) => type.toLowerCase()),
);

type GetDepth = (typeof GET_DEPTH_VALUES)[number];

/** Preserve stored collection cardinalities even when a projection withholds their contents. */
function itemCollectionCounts(
  item: ItemMetadata,
): NonNullable<GetItemProjection["collection_counts"]> {
  const lengths = Object.fromEntries(
    [
      "comments",
      "notes",
      "learnings",
      "files",
      "tests",
      "docs",
      "reminders",
      "events",
    ].map((key) => [
      key,
      (item[key as keyof ItemMetadata] as readonly unknown[] | undefined)
        ?.length ?? 0,
    ]),
  );
  return lengths as NonNullable<GetItemProjection["collection_counts"]>;
}

/** Report children as withheld until a computed rollup proves there are none. */
function itemMaterialFieldGroups(
  item: ItemMetadata,
  body: string,
  children: ChildRollupContext | undefined,
  currentSnapshot: boolean,
  projection: ResolvedGetProjection,
): string[] {
  const collectionCounts = itemCollectionCounts(item);
  return [
    ...(body.length > 0 ? ["body"] : []),
    ...Object.entries(collectionCounts).flatMap(([name, count]) =>
      count > 0 ? [name] : [],
    ),
    ...(collectionCounts.files +
      collectionCounts.tests +
      collectionCounts.docs >
    0
      ? ["linked"]
      : []),
    ...(children === undefined
      ? ["children"]
      : children.count > 0
        ? ["children"]
        : []),
    ...(typeof item.assignee === "string" && item.assignee.trim().length > 0
      ? ["claim_state"]
      : []),
    ...(buildItemSchedule(item) ? ["schedule"] : []),
    ...(currentSnapshot && collectBlockedByIds(item).length > 0 ? ["blockers"] : []),
    ...(!projection.full && item.dependencies?.some(({ id: _id, kind: _kind, ...provenance }) =>
      Object.values(provenance).some((value) => value !== undefined),
    ) ? ["dependency_provenance"] : []),
  ];
}

/** Decide which item types receive a child rollup during deep reads. */
function shouldAutoIncludeGetChildren(itemType: string): boolean {
  const normalizedType = itemType.trim().toLowerCase();
  return (
    normalizedType.length > 0 &&
    (AUTOMATIC_CHILD_ROLLUP_TYPES.has(normalizedType) ||
      !BUILTIN_ITEM_TYPES.has(normalizedType))
  );
}

/** Select item detail and optional hierarchy or verified historical evidence. Incompatible projections fail before serving the item. */
export interface GetOptions {
  /** Detail depth: brief|standard|deep|full. Full includes current children for every type; standard and brief avoid workspace enumeration. */
  depth?: string;
  /** Comma-separated metadata or facet selectors, including item-prefixed aliases; identity is always retained. */
  fields?: string;
  /** Complete item and current child rollup for every type, mutually exclusive with fields/depth. Historical reads retain child recovery because past hierarchy is not indexed. */
  full?: boolean;
  /** Include current descendants; cannot be combined with a historical read. */
  tree?: boolean;
  /** Non-negative descendant depth limit, valid only when tree is enabled. */
  treeDepth?: string;
  /** One-based history version or ISO timestamp for a mutation-free read. */
  at?: string;
}

/** Expose a stable claim coordinate, normalizing an absent message to null. */
function toClaimHistoryContext(entry: ClaimHistoryEntry): ClaimHistoryContext {
  return {
    ts: entry.ts,
    author: entry.author,
    message: entry.message ?? null,
  };
}

/** Pair snapshot ownership with the latest claim/release in the supplied history prefix. */
function resolveClaimStateContext(
  assigneeValue: string | undefined,
  history: ClaimHistoryEntry[],
): ClaimStateContext {
  const assignee = assigneeValue?.trim();
  const normalizedAssignee = assignee && assignee.length > 0 ? assignee : null;
  const lastClaim = [...history]
    .reverse()
    .find((entry) => entry.op === "claim");
  const lastRelease = [...history]
    .reverse()
    .find((entry) => entry.op === "release");
  return {
    claimed: normalizedAssignee !== null,
    assignee: normalizedAssignee,
    last_claim: lastClaim ? toClaimHistoryContext(lastClaim) : null,
    last_release: lastRelease ? toClaimHistoryContext(lastRelease) : null,
  };
}

/** Default blank depth to standard, normalize the full alias, and refuse unknown modes. */
function parseGetDepth(raw: string | undefined): GetDepth {
  if (raw === undefined || raw.trim().length === 0) {
    return "standard";
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "full") {
    return "deep";
  }
  if (GET_DEPTH_VALUES.includes(normalized as GetDepth)) {
    return normalized as GetDepth;
  }
  throw new PmCliError(
    "Get --depth must be one of brief|standard|deep|full",
    EXIT_CODE.USAGE,
    { field: "depth", value: raw, recovery: { allowed_values: [...GET_DEPTH_INPUT_VALUES] } },
  );
}

/** Preserve relationship identities and collection counts; deep reads retain stored collections, while full reads additionally retain edge attribution. */
function projectItemForDepth(
  item: ItemMetadata,
  depth: GetDepth,
  full: boolean,
): GetItemProjection {
  const collectionCounts = itemCollectionCounts(item);
  const projectedItem = { ...item } as GetItemProjection;
  if (!full && item.dependencies !== undefined) {
    projectedItem.dependencies = item.dependencies.map(({ id, kind }) => ({ id, kind }));
  }
  if (depth === "deep") {
    return {
      ...projectedItem,
      comments: item.comments ?? [],
      notes: item.notes ?? [],
      learnings: item.learnings ?? [],
      files: item.files ?? [],
      tests: item.tests ?? [],
      docs: item.docs ?? [],
      reminders: item.reminders ?? [],
      events: item.events ?? [],
      notes_count: collectionCounts.notes,
      tests_count: collectionCounts.tests,
      collection_counts: collectionCounts,
    };
  }
  const {
    comments: _comments,
    notes: _notes,
    learnings: _learnings,
    files: _files,
    tests: _tests,
    docs: _docs,
    reminders: _reminders,
    events: _events,
    ...projected
  } = projectedItem;
  return {
    ...projected,
    notes_count: item.notes?.length ?? 0,
    tests_count: item.tests?.length ?? 0,
    collection_counts: collectionCounts,
  };
}

/** Distinguish no field selection from a nonempty comma-separated projection; reject an empty explicit selector. */
function parseGetFields(raw: string | undefined): string[] | null {
  if (raw === undefined) {
    return null;
  }
  const fields = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (fields.length === 0) {
    throw new PmCliError(
      "Get --fields requires a comma-separated list of field names",
      EXIT_CODE.USAGE,
    );
  }
  return fields;
}

/** Remove the optional item prefix before matching a metadata or derived facet selector. */
function normalizeGetField(field: string): string {
  return field.startsWith("item.") ? field.slice("item.".length) : field;
}

/** Validate against current runtime metadata and facet contracts, publishing legal selectors in typed recovery on refusal. */
function validateGetFields(
  fields: string[] | null,
  runtimeMetadataKeys: Iterable<string>,
  id: string,
): void {
  if (fields === null) {
    return;
  }
  const allowedValues = listGetProjectionFields(runtimeMetadataKeys);
  const allowed = new Set(allowedValues);
  const unknown = fields.filter((field) => {
    const normalized = normalizeGetField(field);
    return (
      !allowed.has(field) &&
      !allowed.has(normalized)
    );
  });
  if (unknown.length > 0) {
    const suggestedRetryArguments = [
      "get",
      id,
      "--fields",
      fields.filter((field) => !unknown.includes(field)).join(",") || "id,title,status",
    ];
    throw new PmCliError(
      `Unknown get --fields value(s): ${unknown.join(", ")}`,
      EXIT_CODE.USAGE,
      {
        code: "unknown_field_projection",
        examples: [
          "pm get <id> --fields id,title,status,type,updated_at",
          "pm get <id> --fields id,title,claim_state",
          "pm get <id> --fields id,title,body,linked.files",
        ],
        recovery: {
          allowed_values: allowedValues,
          suggested_retry: renderPmCommand(suggestedRetryArguments),
          suggested_retry_args: suggestedRetryArguments,
        },
      },
    );
  }
}

const EMPTY_PROJECTED_COLLECTION_FIELDS = new Set([
  "comments",
  "notes",
  "learnings",
  "files",
  "tests",
  "test_runs",
  "docs",
  "reminders",
  "events",
  "dependencies",
  "plan_steps",
  "plan_decisions",
  "plan_discoveries",
  "plan_validation",
]);

/** Resolve one projected metadata value while distinguishing an empty requested collection from an omitted field. */
function projectedMetadataValue(
  source: Readonly<Record<string, unknown>>,
  counts: Readonly<Record<string, unknown>>,
  field: string,
): unknown {
  if (Object.hasOwn(counts, field)) return counts[field];
  if (source[field] !== undefined) return source[field];
  return EMPTY_PROJECTED_COLLECTION_FIELDS.has(field) ? [] : undefined;
}

/**
 * Whether a selector names a derived facet whose owner attaches it, rather than a
 * metadata field. The revision facet is the bare `item_hash`: its item-qualified
 * spelling still projects a custom metadata field of that name.
 */
function isGetFacetSelector(field: string, normalized: string): boolean {
  if (field === "item.item_hash") return false;
  const dot = normalized.indexOf(".");
  return dot === -1 ? GET_FACET_ROOTS.has(normalized) : GET_NESTED_FACET_ROOTS.has(normalized.slice(0, dot));
}

/** Select metadata and empty requested collections, retaining identity and deferring derived facets to their owners. */
function projectItemForFields(
  item: ItemMetadata,
  fields: string[],
): GetItemProjection {
  const source = toItemRecord(item);
  const omittedCounts = {
    notes_count: item.notes?.length ?? 0,
    tests_count: item.tests?.length ?? 0,
    collection_counts: itemCollectionCounts(item),
  };
  const projected: Record<string, unknown> = { id: item.id };
  for (const field of fields) {
    const normalized = normalizeGetField(field);
    if (isGetFacetSelector(field, normalized)) {
      continue;
    }
    projected[normalized] = projectedMetadataValue(
      source,
      omittedCounts,
      normalized,
    );
  }
  return projected as GetItemProjection;
}

/** Match an exact metadata selector in either bare or item-prefixed spelling. */
function fieldsInclude(fields: string[] | null, name: string): boolean {
  return (
    fields?.some((field) => field === name || field === `item.${name}`) ?? false
  );
}

/** Match a facet itself or any nested selector after normalizing the item prefix. */
function fieldsIncludeRoot(fields: string[], name: string): boolean {
  return fields.some((field) => {
    const normalized = normalizeGetField(field);
    return normalized === name || normalized.startsWith(`${name}.`);
  });
}

/** Validated projection plan that distinguishes complete reads from ordinary deep container reads. */
interface ResolvedGetProjection {
  depth: GetDepth;
  full: boolean;
  treeDepth: number | undefined;
  fields: string[] | null;
  fieldProjection: boolean;
}

/** One located or history-reconstructed document plus the registries needed for its derived facets. */
interface GetItemContext {
  pmRoot: string;
  settings: Awaited<ReturnType<typeof readSettings>>;
  typeToFolder: Record<string, string>;
  locatedId: string;
  metadata: ItemMetadata;
  body: string;
  historical?: GetItemAtResult;
}

/** Normalize detail modes and depth limits, refusing incompatible full, field, tree, and historical controls. */
function resolveGetProjection(
  options: GetOptions,
  id: string,
): ResolvedGetProjection {
  if (
    options.full &&
    (options.fields !== undefined || options.depth !== undefined)
  ) {
    throw new PmCliError(
      "Get projection options are mutually exclusive; remove the extra projection flag and retry.",
      EXIT_CODE.USAGE,
      {
        code: "projection_options_mutually_exclusive",
        flag: "--full",
        recovery: {
          suggested_retry: renderPmCommand(["get", id, "--full"]),
          suggested_retry_args: ["get", id, "--full"],
        },
      },
    );
  }
  if (options.tree !== true && options.treeDepth !== undefined) {
    throw new PmCliError("Get --tree-depth requires --tree", EXIT_CODE.USAGE);
  }
  if (options.at !== undefined && options.tree === true) {
    throw new PmCliError(
      "Get --at cannot be combined with --tree because workspace-level historical projections are not yet indexed.",
      EXIT_CODE.USAGE,
    );
  }
  return {
    depth: options.full ? "deep" : parseGetDepth(options.depth),
    full: options.full === true || options.depth?.trim().toLowerCase() === "full",
    treeDepth:
      options.tree === true
        ? parseIntegerLimit(options.treeDepth, "--tree-depth")
        : undefined,
    fields: parseGetFields(options.fields),
    fieldProjection: options.fields !== undefined,
  };
}

/** Require an initialized tracker and resolve one unambiguous current item or verified historical snapshot with active type/schema registrations. */
async function loadGetItemContext(
  id: string,
  global: GlobalOptions,
  at?: string,
): Promise<GetItemContext> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await assertInitializedTracker(pmRoot);
  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(
    settings,
    getActiveExtensionRegistrations(),
  );
  if (at !== undefined) {
    const historical = await getItemAt(id, at, { pmRoot: global.path });
    return {
      pmRoot,
      settings,
      typeToFolder: typeRegistry.type_to_folder,
      locatedId: historical.document.metadata.id,
      metadata: historical.document.metadata,
      body: historical.document.body,
      historical,
    };
  }
  const located = await locateItem(
    pmRoot,
    id,
    settings.id_prefix,
    settings.item_format,
    typeRegistry.type_to_folder,
  );
  if (!located) {
    throw await buildItemNotFoundError(
      pmRoot,
      id,
      settings.id_prefix,
      typeRegistry.type_to_folder,
    );
  }
  const loaded = await readLocatedItem(located, { schema: settings.schema });
  return {
    pmRoot,
    settings,
    typeToFolder: typeRegistry.type_to_folder,
    locatedId: located.id,
    metadata: loaded.document.metadata,
    body: loaded.document.body,
  };
}

/** Validate active metadata selectors and refuse historical child queries because workspace history is not indexed. */
function validateGetProjectionFields(
  fields: string[] | null,
  settings: Awaited<ReturnType<typeof readSettings>>,
  historical: boolean,
  id: string,
): void {
  const runtimeMetadataKeys = [
    ...resolveRuntimeFieldRegistry(settings.schema).definitions.map((field) => field.metadata_key),
    ...collectRegisteredItemFieldNames(getActiveExtensionRegistrations()),
  ];
  validateGetFields(fields, runtimeMetadataKeys, id);
  if (historical && fieldsIncludeRoot(fields ?? [], "children")) {
    throw new PmCliError(
      "Get --at cannot project children because workspace-level historical relationships are not yet indexed.",
      EXIT_CODE.USAGE,
    );
  }
  if (historical && fieldsIncludeRoot(fields ?? [], "blockers")) {
    throw new PmCliError(
      "Get --at cannot project current blocker statuses; read the current item with --fields blockers instead.",
      EXIT_CODE.USAGE,
    );
  }
}

/** Include explicit facet selectors, or retain ordinary body/link/claim facets above brief depth. */
function shouldIncludeGetField(params: {
  fieldProjection: boolean;
  depth: GetDepth;
  fields: string[] | null;
  field: "body" | "linked" | "claim_state";
}): boolean {
  const { fieldProjection, depth, fields, field } = params;
  if (fieldProjection) {
    if (field === "body" || field === "linked") {
      return fieldsInclude(fields, field);
    }
    return fieldsIncludeRoot(fields as string[], field);
  }
  return depth !== "brief";
}

/** Derive claim evidence from the selected physical history prefix, excluding future claims. */
async function resolveGetClaimState(
  context: GetItemContext,
  includeClaimState: boolean,
): Promise<ClaimStateContext | undefined> {
  if (!includeClaimState) {
    return undefined;
  }
  const historyPath = getHistoryPath(context.pmRoot, context.locatedId);
  const history = await readHistoryEntries(historyPath, context.locatedId);
  return resolveClaimStateContext(
    context.metadata.assignee,
    context.historical
      ? history.slice(0, context.historical.target.historyIndex + 1)
      : history,
  );
}

/** Attach the current revision (pm-gh1576) to current reads, and to field projections only when selected. */
function attachGetItemHash(result: GetResult, context: GetItemContext, projection: ResolvedGetProjection): void {
  if (context.historical !== undefined) return;
  if (projection.fieldProjection && !(projection.fields as string[]).includes("item_hash")) return;
  result.item_hash = hashDocument({ metadata: context.metadata, body: context.body });
}

const LINKED_GROUPS = ["files", "tests", "docs"] as const;
const CLAIM_STATE_MEMBERS = ["claimed", "assignee", "last_claim", "last_release"] as const;

/**
 * Attach requested artifact groups. The whole group carries all three arrays;
 * nested selectors carry only their own groups, never an empty placeholder for a
 * group that was not requested (GH-1663).
 */
function attachGetLinked(
  result: GetResult,
  context: GetItemContext,
  fields: string[] | null,
  includeLinked: boolean,
): void {
  const selected = LINKED_GROUPS.filter(
    (group) => includeLinked || fieldsInclude(fields, `linked.${group}`),
  );
  if (selected.length === 0) return;
  result.linked = Object.fromEntries(
    selected.map((group) => [group, context.metadata[group] ?? []]),
  ) as NonNullable<GetResult["linked"]>;
}

/** Keep only the selected claim members unless the whole facet was requested (GH-1663). */
function projectGetClaimState(
  claimState: ClaimStateContext,
  fields: string[] | null,
): Partial<ClaimStateContext> {
  if (fields === null || fieldsInclude(fields, "claim_state")) return claimState;
  return Object.fromEntries(
    CLAIM_STATE_MEMBERS.filter((member) =>
      fields.some((field) => normalizeGetField(field) === `claim_state.${member}`),
    ).map((member) => [member, claimState[member]]),
  );
}

/**
 * Facet members whose same-named item metadata field carries the same facts, so
 * selecting that field (for example `tests` beside `linked.files`) already
 * returns the member. Derived members such as `schedule.start_at` have no alias.
 */
const NESTED_MEMBER_METADATA_ALIASES: Readonly<Record<"linked" | "schedule" | "claim_state", ReadonlySet<string>>> = {
  linked: new Set(LINKED_GROUPS),
  schedule: new Set(["deadline", "reminders", "events"]),
  claim_state: new Set(["assignee"]),
};

/**
 * Name the populated members a nested selector left out, as `<facet>.<member>`,
 * so the omission receipt can disclose them with a narrow restoration. Selecting
 * the whole facet, or none of its members, withholds nothing inside it, and a
 * member returned through its item metadata alias is not withheld either.
 */
function nestedFieldSiblingGroups(
  fields: readonly string[],
  facet: keyof typeof NESTED_MEMBER_METADATA_ALIASES,
  members: object,
): string[] {
  const normalized = fields.map(normalizeGetField);
  if (normalized.includes(facet)) return [];
  const prefix = `${facet}.`;
  if (!normalized.some((field) => field.startsWith(prefix))) return [];
  const aliases = NESTED_MEMBER_METADATA_ALIASES[facet];
  return Object.entries(members).flatMap(([member, value]) =>
    !normalized.includes(`${prefix}${member}`) &&
    !(aliases.has(member) && normalized.includes(member)) &&
    isMaterialFacetMember(value)
      ? [`${prefix}${member}`]
      : [],
  );
}

/** Treat null, false and empty arrays as carrying no withheld evidence. */
function isMaterialFacetMember(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false &&
    !(Array.isArray(value) && value.length === 0);
}

/** Material siblings withheld by nested linked, claim_state and schedule selectors. */
function getFieldProjectionMaterialGroups(
  context: GetItemContext,
  fields: readonly string[],
  claimState: ClaimStateContext | undefined,
): string[] {
  return [
    ...nestedFieldSiblingGroups(fields, "linked", {
      files: context.metadata.files,
      tests: context.metadata.tests,
      docs: context.metadata.docs,
    }),
    ...(claimState ? nestedFieldSiblingGroups(fields, "claim_state", claimState) : []),
    ...nestedFieldSiblingGroups(fields, "schedule", buildItemSchedule(context.metadata) ?? {}),
  ];
}

/** Enumerate hierarchy metadata only when the caller explicitly requested a child rollup. */
async function buildGetChildrenRollup(
  context: GetItemContext,
  includeChildren: boolean,
): Promise<ChildRollupContext | undefined> {
  if (!includeChildren) {
    return undefined;
  }
  const statusRegistry = resolveRuntimeStatusRegistry(context.settings.schema);
  const corpus = await listAllItemMetadataLight(
    context.pmRoot,
    context.settings.item_format,
    context.typeToFolder,
    undefined,
    context.settings.schema,
  );
  return buildItemChildrenRollup(
    context.locatedId,
    corpus,
    statusRegistry,
  );
}

/** Attach current forward-declared targets only when requested, retaining unsafe/unknown/external references as unresolved and avoiding unrelated item scans or historical status claims. */
async function attachGetBlockers(
  result: GetResult,
  context: GetItemContext,
  projection: ResolvedGetProjection,
): Promise<void> {
  if (context.historical !== undefined) return;
  if (!(projection.fieldProjection
    ? fieldsIncludeRoot(projection.fields as string[], "blockers")
    : projection.depth !== "brief")) return;
  if (collectBlockedByIds(context.metadata).length === 0) return;
  const resolved = await resolveDeclaredBlockers({
    pmRoot: context.pmRoot,
    settings: context.settings,
    typeToFolder: context.typeToFolder,
    metadata: context.metadata,
  });
  result.blockers = {
    scope: "declared",
    open: resolved.filter((blocker) => !blocker.resolved).map(({ resolved: _resolved, ...blocker }) => blocker),
    closed_count: resolved.filter((blocker) => blocker.resolved).length,
  };
  if (!projection.fieldProjection && !projection.full) delete result.item.blocked_by;
}

/** Derive scheduling from the selected snapshot and retain only requested schedule members when field-projected. */
function attachGetSchedule(
  result: GetResult,
  context: GetItemContext,
  fields: string[] | null,
  includeSchedule: boolean,
): void {
  if (!includeSchedule) {
    return;
  }
  const schedule = buildItemSchedule(context.metadata);
  if (!schedule) {
    return;
  }
  if (fields === null || fieldsInclude(fields, "schedule")) {
    result.schedule = schedule;
    return;
  }
  result.schedule = Object.fromEntries(
    Object.entries(schedule).filter(([key]) =>
      fields.some((field) => normalizeGetField(field) === `schedule.${key}`),
    ),
  ) as Partial<ItemScheduleContext>;
}

/** Build current descendants through the shared list hierarchy query, retaining its depth limit and row count. */
async function buildGetTree(
  context: GetItemContext,
  options: GetOptions,
  treeDepth: number | undefined,
  global: GlobalOptions,
): Promise<GetResult["tree"] | undefined> {
  if (options.tree !== true) {
    return undefined;
  }
  const subtree = await runList(
    undefined,
    {
      parent: context.locatedId,
      tree: true,
      treeDepth: treeDepth === undefined ? undefined : String(treeDepth),
      full: true,
    },
    global,
  );
  return {
    root_id: context.locatedId,
    root_title: context.metadata.title,
    depth_limit: treeDepth ?? null,
    count: subtree.count,
    items: subtree.items.map((entry) => toItemRecord(entry)),
  };
}

/** Read one authoritative item and selected facets. Full current reads compute children for every type; ordinary Task reads avoid corpus enumeration. Historical reads exclude current hierarchy, and failed derived usage recording never invalidates the item read. */
export async function runGet(
  id: string,
  global: GlobalOptions,
  options: GetOptions = {},
): Promise<GetResult> {
  const projection = resolveGetProjection(options, id);
  const context = await loadGetItemContext(id, global, options.at);
  validateGetProjectionFields(
    projection.fields,
    context.settings,
    context.historical !== undefined,
    context.locatedId,
  );
  const includeBody = shouldIncludeGetField({ ...projection, field: "body" });
  const includeLinked = shouldIncludeGetField({
    ...projection,
    field: "linked",
  });
  const includeClaimState = shouldIncludeGetField({
    ...projection,
    field: "claim_state",
  });
  const includeChildren =
    context.historical === undefined &&
    (projection.fieldProjection
      ? fieldsIncludeRoot(projection.fields as string[], "children")
      : projection.depth === "deep" &&
        (projection.full ||
          shouldAutoIncludeGetChildren(context.metadata.type)));
  const includeSchedule = projection.fieldProjection
    ? fieldsIncludeRoot(projection.fields as string[], "schedule")
    : projection.depth !== "brief";
  const claimState = await resolveGetClaimState(context, includeClaimState);
  const result: GetResult = {
    item: projection.fieldProjection
      ? projectItemForFields(context.metadata, projection.fields as string[])
      : projectItemForDepth(context.metadata, projection.depth, projection.full),
  };
  if (includeBody) {
    result.item.body = context.body;
  }
  attachGetItemHash(result, context, projection);
  attachGetLinked(result, context, projection.fields, includeLinked);
  if (claimState) {
    result.claim_state = projectGetClaimState(claimState, projection.fields);
  }
  attachGetSchedule(result, context, projection.fields, includeSchedule);
  await attachGetBlockers(result, context, projection);
  const children = await buildGetChildrenRollup(
    context,
    includeChildren,
  );
  if (children !== undefined) {
    result.children = children;
  }
  const tree = await buildGetTree(
    context,
    options,
    projection.treeDepth,
    global,
  );
  if (tree !== undefined) {
    result.tree = tree;
  }
  if (context.historical) {
    result.reconstructed = true;
    result.as_of_version = context.historical.as_of_version;
    result.as_of_timestamp = context.historical.as_of_timestamp;
  }
  if (context.historical === undefined) {
    try {
      await recordContextUsageTouches({
        pmRoot: context.pmRoot,
        author: resolveAuthor(undefined, context.settings.author_default),
        itemIds: [context.locatedId],
        intent: "get",
      });
    } catch {
      // Derived usage feedback must never make the source-of-truth read fail.
    }
  }
  registerOutputMaterialFieldGroups(
    result,
    // Explicit selectors define the requested answer, except that a nested
    // selector discloses the populated siblings it left out (GH-1663).
    // Default/depth reads still disclose material groups; budget truncation has
    // its own shared receipt.
    projection.fieldProjection
      ? getFieldProjectionMaterialGroups(context, projection.fields as string[], claimState)
      : itemMaterialFieldGroups(context.metadata, context.body, children, context.historical === undefined, projection),
  );
  return result;
}

/** Compatibility access to deep-read container classification; explicit full reads override that classification. */
export const _testOnlyGetCommand = {
  shouldAutoIncludeGetChildren,
};
