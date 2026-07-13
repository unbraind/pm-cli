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
import { isTerminalStatus } from "../../core/item/status.js";
import {
  EXIT_CODE,
  ITEM_METADATA_KEY_ORDER,
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
import { readSettings } from "../../core/store/settings.js";
import { recordContextUsageTouches } from "../../sdk/context-usage.js";
import { parseIntegerLimit } from "../shared-parsers.js";
import type {
  ItemMetadata,
  LinkedDoc,
  LinkedFile,
  LinkedTest,
} from "../../types/index.js";
import { readHistoryEntries } from "./history.js";
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

interface ChildRollupContext {
  count: number;
  active: number;
  by_status: Record<string, number>;
}

// GH-155 (pm-gcm3): only container types get the inline child rollup so leaf
// item reads keep avoiding the corpus scan that the rollup requires.
const CHILD_ROLLUP_TYPES = new Set(["milestone", "epic"]);

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

type GetDepth = (typeof GET_DEPTH_VALUES)[number];

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
  const unknown = fields.filter((field) => {
    const normalized = normalizeGetField(field);
    return (
      !itemFields.has(normalized) &&
      !allowedRootFields.has(normalized) &&
      !allowedLinkedFields.has(normalized) &&
      !allowedClaimStateFields.has(normalized)
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
    const normalized = field.startsWith("item.")
      ? field.slice("item.".length)
      : field;
    if (
      normalized === "body" ||
      normalized === "linked" ||
      normalized.startsWith("linked.")
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
  return fields.some((field) => field === name || field.startsWith(`${name}.`));
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
  field: "body" | "linked" | "claim_state" | "children";
  itemType?: string;
}): boolean {
  const { fieldProjection, depth, fields, field, itemType } = params;
  if (fieldProjection) {
    if (field === "body" || field === "linked") {
      return fieldsInclude(fields, field);
    }
    return fieldsIncludeRoot(fields as string[], field);
  }
  if (field === "children") {
    return depth !== "brief" && CHILD_ROLLUP_TYPES.has(itemType as string);
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
  return resolveClaimStateContext(context.metadata.assignee, history);
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
  const byStatus: Record<string, number> = {};
  let active = 0;
  let count = 0;
  const locatedId = context.locatedId.trim().toLowerCase();
  for (const candidate of corpus) {
    const parentId =
      typeof candidate.parent === "string"
        ? candidate.parent.trim().toLowerCase()
        : "";
    if (parentId !== locatedId) continue;
    const candidateStatus = candidate.status.trim().toLowerCase();
    count += 1;
    byStatus[candidateStatus] = (byStatus[candidateStatus] ?? 0) + 1;
    if (!isTerminalStatus(candidateStatus, statusRegistry)) {
      active += 1;
    }
  }
  return { count, active, by_status: byStatus };
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
  const context = await loadGetItemContext(id, global);
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
  const itemType = context.metadata.type.trim().toLowerCase();
  const includeChildren = shouldIncludeGetField({
    ...projection,
    field: "children",
    itemType,
  });
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
  result.children = await buildGetChildrenRollup(context, includeChildren);
  result.tree = await buildGetTree(
    context,
    options,
    projection.treeDepth,
    global,
  );
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
  return result;
}
