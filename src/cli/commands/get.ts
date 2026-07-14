/**
 * @module cli/commands/get
 *
 * Implements the pm get command surface and its agent-facing runtime behavior.
 */
import { pathExists } from "../../core/fs/fs-utils.js";
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { toItemRecord } from "../../core/item/item-record.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import {
  resolveRuntimeFieldRegistry,
  resolveRuntimeStatusRegistry,
} from "../../core/schema/runtime-schema.js";
import {
  EXIT_CODE,
  ITEM_METADATA_KEY_ORDER,
  TYPE_TO_FOLDER,
} from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import {
  buildItemNotFoundError,
  listAllItemMetadataLight,
  locateItem,
  readLocatedItem,
} from "../../core/store/item-store.js";
import {
  getHistoryPath,
  getSettingsPath,
  resolvePmRoot,
} from "../../core/store/paths.js";
import { readHistoryEntries } from "../../sdk/history-read.js";
import { readSettings } from "../../core/store/settings.js";
import { recordContextUsageTouches } from "../../sdk/context-usage.js";
import {
  buildItemChildrenRollup,
  type ChildRollupContext,
} from "../../sdk/item-children.js";
import {
  buildItemSchedule,
  type ItemScheduleContext,
} from "../../sdk/item-schedule.js";
import { getItemAt, type GetItemAtResult } from "../../sdk/history-read.js";
import { parseIntegerLimit } from "../shared-parsers.js";
import type {
  ItemMetadata,
  LinkedDoc,
  LinkedFile,
  LinkedTest,
} from "../../types/index.js";
import { runList } from "./list.js";

interface ClaimHistoryContext {
  ts: string;
  author: string;
  message: string | null;
}

interface ClaimHistoryEntry {
  op: string;
  ts: string;
  author: string;
  message?: string;
}

interface ClaimStateContext {
  claimed: boolean;
  assignee: string | null;
  last_claim: ClaimHistoryContext | null;
  last_release: ClaimHistoryContext | null;
}

/** Documents the get result payload exchanged by command, SDK, and package integrations. */
export interface GetResult {
  // `body` lives inside `item` (alongside `description`/`acceptance_criteria`)
  // for parity with `pm list --include-body`, so agents reliably find it at
  // `.item.body` in JSON output instead of a top-level sibling.
  /** Value that configures or reports item for this contract. */
  item: Partial<ItemMetadata> & { body?: string };
  /** Value that configures or reports linked for this contract. */
  linked?: {
    files: LinkedFile[];
    tests: LinkedTest[];
    docs: LinkedDoc[];
  };
  /** Value that configures or reports claim state for this contract. */
  claim_state?: ClaimStateContext;
  /** Value that configures or reports children for this contract. */
  children?: ChildRollupContext;
  /** Normalized scheduling data for scheduled item types and metadata. */
  schedule?: Partial<ItemScheduleContext>;
  /** True when the item was reconstructed from immutable history. */
  reconstructed?: true;
  /** One-based history version represented by a reconstructed read. */
  as_of_version?: number;
  /** Timestamp of the last history entry included in a reconstructed read. */
  as_of_timestamp?: string;
  /** Value that configures or reports tree for this contract. */
  tree?: {
    root_id: string;
    root_title: string | null;
    depth_limit: number | null;
    count: number;
    items: Record<string, unknown>[];
  };
}

const GET_DEPTH_VALUES = ["brief", "standard", "deep"] as const;

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

/** Decide whether a normal read should pay for a workspace-wide child projection. */
function shouldAutoIncludeGetChildren(itemType: string): boolean {
  const normalizedType = itemType.trim().toLowerCase();
  return (
    normalizedType.length > 0 &&
    (AUTOMATIC_CHILD_ROLLUP_TYPES.has(normalizedType) ||
      !BUILTIN_ITEM_TYPES.has(normalizedType))
  );
}

/** Documents the get options payload exchanged by command, SDK, and package integrations. */
export interface GetOptions {
  /** Value that configures or reports depth for this contract. */
  depth?: string;
  /** Value that configures or reports fields for this contract. */
  fields?: string;
  /** Value that configures or reports full for this contract. */
  full?: boolean;
  /** Value that configures or reports tree for this contract. */
  tree?: boolean;
  /** Value that configures or reports tree depth for this contract. */
  treeDepth?: string;
  /** One-based history version or ISO timestamp for a mutation-free read. */
  at?: string;
}

function toClaimHistoryContext(entry: ClaimHistoryEntry): ClaimHistoryContext {
  return {
    ts: entry.ts,
    author: entry.author,
    message: entry.message ?? null,
  };
}

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
  );
}

function projectItemForDepth(
  item: ItemMetadata,
  depth: GetDepth,
): Partial<ItemMetadata> {
  if (depth === "deep") {
    return item;
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
  return projected;
}

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

function normalizeGetField(field: string): string {
  return field.startsWith("item.") ? field.slice("item.".length) : field;
}

function validateGetFields(
  fields: string[] | null,
  runtimeMetadataKeys: Iterable<string>,
): void {
  if (fields === null) {
    return;
  }
  const itemFields = new Set([
    ...ITEM_METADATA_KEY_ORDER,
    ...runtimeMetadataKeys,
  ]);
  const allowedRootFields = new Set([
    "body",
    "linked",
    "claim_state",
    "children",
    "schedule",
  ]);
  const allowedLinkedFields = new Set([
    "linked.files",
    "linked.tests",
    "linked.docs",
  ]);
  const allowedClaimStateFields = new Set([
    "claim_state.claimed",
    "claim_state.assignee",
    "claim_state.last_claim",
    "claim_state.last_release",
  ]);
  const allowedScheduleFields = new Set([
    "schedule.deadline",
    "schedule.start_at",
    "schedule.end_at",
    "schedule.location",
    "schedule.reminders",
    "schedule.events",
  ]);
  const unknown = fields.filter((field) => {
    const normalized = normalizeGetField(field);
    return (
      !itemFields.has(normalized) &&
      !allowedRootFields.has(normalized) &&
      !allowedLinkedFields.has(normalized) &&
      !allowedClaimStateFields.has(normalized) &&
      !allowedScheduleFields.has(normalized)
    );
  });
  if (unknown.length > 0) {
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
      },
    );
  }
}

function projectItemForFields(
  item: ItemMetadata,
  fields: string[],
): Partial<ItemMetadata> {
  const source = toItemRecord(item);
  const projected: Record<string, unknown> = {};
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
    projected[normalized] = source[normalized];
  }
  return projected as Partial<ItemMetadata>;
}

function fieldsInclude(fields: string[] | null, name: string): boolean {
  return (
    fields?.some((field) => field === name || field === `item.${name}`) ?? false
  );
}

function fieldsIncludeRoot(fields: string[], name: string): boolean {
  return fields.some((field) => {
    const normalized = normalizeGetField(field);
    return normalized === name || normalized.startsWith(`${name}.`);
  });
}

interface ResolvedGetProjection {
  depth: GetDepth;
  treeDepth: number | undefined;
  fields: string[] | null;
  fieldProjection: boolean;
}

interface GetItemContext {
  pmRoot: string;
  settings: Awaited<ReturnType<typeof readSettings>>;
  typeToFolder: Record<string, string>;
  locatedId: string;
  metadata: ItemMetadata;
  body: string;
  historical?: GetItemAtResult;
}

function resolveGetProjection(options: GetOptions): ResolvedGetProjection {
  if (
    options.full &&
    (options.fields !== undefined || options.depth !== undefined)
  ) {
    throw new PmCliError(
      "Get projection options are mutually exclusive; remove the extra projection flag and retry.",
      EXIT_CODE.USAGE,
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
    treeDepth:
      options.tree === true
        ? parseIntegerLimit(options.treeDepth, "--tree-depth")
        : undefined,
    fields: parseGetFields(options.fields),
    fieldProjection: options.fields !== undefined,
  };
}

async function loadGetItemContext(
  id: string,
  global: GlobalOptions,
  at?: string,
): Promise<GetItemContext> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(
      `Tracker is not initialized at ${pmRoot}. Run pm init first.`,
      EXIT_CODE.NOT_FOUND,
    );
  }
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

function validateGetProjectionFields(
  fields: string[] | null,
  settings: Awaited<ReturnType<typeof readSettings>>,
): void {
  const runtimeMetadataKeys = resolveRuntimeFieldRegistry(
    settings.schema,
  ).definitions.map((field) => field.metadata_key);
  validateGetFields(fields, runtimeMetadataKeys);
}

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
      ? history.slice(0, context.historical.as_of_version)
      : history,
  );
}

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

async function buildGetChildrenRollup(
  context: GetItemContext,
  includeChildren: boolean,
  includeEmpty: boolean,
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
  const rollup = buildItemChildrenRollup(
    context.locatedId,
    corpus,
    statusRegistry,
  );
  return rollup.count > 0 || includeEmpty ? rollup : undefined;
}

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
      fields.some(
        (field) => normalizeGetField(field) === `schedule.${key}`,
      ),
    ),
  ) as Partial<ItemScheduleContext>;
}

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

/** Implements run get for the public runtime surface of this module. */
export async function runGet(
  id: string,
  global: GlobalOptions,
  options: GetOptions = {},
): Promise<GetResult> {
  const projection = resolveGetProjection(options);
  const context = await loadGetItemContext(id, global, options.at);
  validateGetProjectionFields(projection.fields, context.settings);
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
      : projection.depth !== "brief" &&
        shouldAutoIncludeGetChildren(context.metadata.type));
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
  result.children = await buildGetChildrenRollup(
    context,
    includeChildren,
    projection.fieldProjection,
  );
  result.tree = await buildGetTree(
    context,
    options,
    projection.treeDepth,
    global,
  );
  if (context.historical) {
    result.reconstructed = true;
    result.as_of_version = context.historical.as_of_version;
    result.as_of_timestamp = context.historical.as_of_timestamp;
  }
  if (context.historical === undefined) {
    try {
      await recordContextUsageTouches({
        pmRoot: context.pmRoot,
        author:
          (process.env.PM_AUTHOR ?? context.settings.author_default).trim() ||
          "unknown",
        itemIds: [context.locatedId],
        intent: "get",
      });
    } catch {
      // Derived usage feedback must never make the source-of-truth read fail.
    }
  }
  return result;
}

/** Public contract for test-only get command policy helpers. */
export const _testOnlyGetCommand = {
  shouldAutoIncludeGetChildren,
};
