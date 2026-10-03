/**
 * @module sdk/query/get
 *
 * Implements the SDK-owned item query shared by every surface.
 */
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
import { renderPmCommand } from "../command-line.js";
import { recordContextUsageTouches } from "../context-usage.js";
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
  LinkedDoc,
  LinkedFile,
  LinkedTest,
} from "../../types/index.js";
import { runList } from "./list.js";
import { registerOutputMaterialFieldGroups } from "../output-projection.js";
import {
  GET_DEPTH_VALUES,
  listGetProjectionFields,
} from "./projection-contracts.js";
export {
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
type GetItemProjection = Partial<ItemMetadata> & {
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
export interface GetResult {
  // `body` lives inside `item` (alongside `description`/`acceptance_criteria`)
  // for parity with `pm list --include-body`, so agents reliably find it at
  // `.item.body` in JSON output instead of a top-level sibling.
  /** Selected metadata and body; requested empty collections are represented explicitly. */
  item: GetItemProjection;
  /** Requested artifact groups; narrower selectors leave unrequested groups empty. */
  linked?: {
    files: LinkedFile[];
    tests: LinkedTest[];
    docs: LinkedDoc[];
  };
  /** Ownership evidence for the current or selected historical snapshot. */
  claim_state?: ClaimStateContext;
  /** Current child rollup for full or explicit child reads and deep container reads; historical hierarchy is not indexed. */
  children?: ChildRollupContext;
  /** Normalized scheduling data for scheduled item types and metadata. */
  schedule?: Partial<ItemScheduleContext>;
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
    { field: "depth", value: raw, recovery: { allowed_values: [...GET_DEPTH_VALUES, "full"] } },
  );
}

/** Preserve metadata and collection counts while deep reads additionally retain every stored collection. */
function projectItemForDepth(
  item: ItemMetadata,
  depth: GetDepth,
): GetItemProjection {
  const collectionCounts = itemCollectionCounts(item);
  if (depth === "deep") {
    return {
      ...item,
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
  } = item;
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
    if (
      normalized === "body" ||
      normalized === "linked" ||
      normalized.startsWith("linked.") ||
      normalized === "claim_state" ||
      normalized.startsWith("claim_state.") ||
      normalized === "children" ||
      normalized.startsWith("children.") ||
      normalized === "schedule" ||
      normalized.startsWith("schedule.")
    ) {
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
  const runtimeMetadataKeys = resolveRuntimeFieldRegistry(
    settings.schema,
  ).definitions.map((field) => field.metadata_key);
  validateGetFields(fields, runtimeMetadataKeys, id);
  if (historical && fieldsIncludeRoot(fields ?? [], "children")) {
    throw new PmCliError(
      "Get --at cannot project children because workspace-level historical relationships are not yet indexed.",
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

/** Attach only requested artifact groups while preserving the linked envelope's stable three-group shape. */
function attachGetLinked(
  result: GetResult,
  context: GetItemContext,
  fields: string[] | null,
  includeLinked: boolean,
): void {
  const includeLinkedFiles =
    includeLinked || fieldsInclude(fields, "linked.files");
  const includeLinkedTests =
    includeLinked || fieldsInclude(fields, "linked.tests");
  const includeLinkedDocs =
    includeLinked || fieldsInclude(fields, "linked.docs");
  if (
    !includeLinked &&
    !includeLinkedFiles &&
    !includeLinkedTests &&
    !includeLinkedDocs
  ) {
    return;
  }
  result.linked = {
    files: includeLinkedFiles ? (context.metadata.files ?? []) : [],
    tests: includeLinkedTests ? (context.metadata.tests ?? []) : [],
    docs: includeLinkedDocs ? (context.metadata.docs ?? []) : [],
  };
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
      : projectItemForDepth(context.metadata, projection.depth),
  };
  if (includeBody) {
    result.item.body = context.body;
  }
  attachGetLinked(result, context, projection.fields, includeLinked);
  if (claimState) {
    result.claim_state = claimState;
  }
  attachGetSchedule(result, context, projection.fields, includeSchedule);
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
    itemMaterialFieldGroups(context.metadata, context.body, children),
  );
  return result;
}

/** Compatibility access to deep-read container classification; explicit full reads override that classification. */
export const _testOnlyGetCommand = {
  shouldAutoIncludeGetChildren,
};
