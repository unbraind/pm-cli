import { pathExists } from "../../core/fs/fs-utils.js";
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { toItemRecord } from "../../core/item/item-record.js";
import { isTerminalStatus } from "../../core/item/status.js";
import { parseStatusFilterCsv } from "../../core/item/status-filter.js";
import { resolveItemTypeRegistry, type ItemTypeRegistry } from "../../core/item/type-registry.js";
import { parseIntegerLimit, parsePriority, parseType } from "../shared-parsers.js";
import { collectRuntimeFilterValues, matchesRuntimeFilters } from "../../core/schema/runtime-field-filters.js";
import {
  hasMissingMetadataFilter,
  itemMatchesMissingMetadata,
  lifecycleClassifierFromStatusRegistry,
  type MissingMetadataFilters,
} from "../../core/governance/metadata-coverage.js";
import {
  resolveRuntimeFieldRegistry,
  resolveRuntimeStatusRegistry,
  type RuntimeStatusRegistry,
} from "../../core/schema/runtime-schema.js";
import { EXIT_CODE, FRONT_MATTER_KEY_ORDER } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { compareTimestampStrings, nowIso, resolveIsoOrRelative } from "../../core/shared/time.js";
import { listAllFrontMatter, listAllFrontMatterLight, listAllFrontMatterWithBody } from "../../core/store/item-store.js";
import { HEAVY_METADATA_KEYS } from "../../core/store/front-matter-cache.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type { ItemFrontMatter, ItemStatus, ItemType } from "../../types/index.js";

export interface ListOptions {
  status?: string;
  type?: string;
  tag?: string;
  priority?: string;
  deadlineBefore?: string;
  deadlineAfter?: string;
  updatedAfter?: string;
  updatedBefore?: string;
  createdAfter?: string;
  createdBefore?: string;
  ids?: string;
  assignee?: string;
  assigneeFilter?: string;
  parent?: string;
  sprint?: string;
  release?: string;
  limit?: string;
  offset?: string;
  noTruncate?: boolean;
  includeBody?: boolean;
  compact?: boolean;
  brief?: boolean;
  full?: boolean;
  fields?: string;
  sort?: string;
  order?: string;
  tree?: boolean;
  treeDepth?: string;
  excludeTerminal?: boolean;
  filterAcMissing?: boolean;
  filterEstimatesMissing?: boolean;
  filterResolutionMissing?: boolean;
  filterMetadataMissing?: boolean;
  [key: string]: unknown;
}

/** Extract the missing-metadata selection filters from list/update-many options. */
export function resolveMissingMetadataFilters(options: {
  filterAcMissing?: boolean;
  filterEstimatesMissing?: boolean;
  filterResolutionMissing?: boolean;
  filterMetadataMissing?: boolean;
}): MissingMetadataFilters {
  return {
    acMissing: options.filterAcMissing === true,
    estimatesMissing: options.filterEstimatesMissing === true,
    resolutionMissing: options.filterResolutionMissing === true,
    metadataMissing: options.filterMetadataMissing === true,
  };
}

export type ListedItem = ItemFrontMatter | (ItemFrontMatter & { body: string });

type ListProjectionMode = "full" | "compact" | "fields";

interface ListProjectionConfig {
  mode: ListProjectionMode;
  fields: string[];
}

export const LIST_SORT_FIELDS = ["priority", "deadline", "updated_at", "created_at", "title", "parent"] as const;
export type ListSortField = (typeof LIST_SORT_FIELDS)[number];

export const LIST_SORT_ORDER_VALUES = ["asc", "desc"] as const;
export type ListSortOrder = (typeof LIST_SORT_ORDER_VALUES)[number];

const DEFAULT_COMPACT_LIST_FIELDS = ["id", "title", "status", "type", "priority", "parent", "updated_at"] as const;
const BRIEF_LIST_FIELDS = ["id", "status", "type", "title"] as const;
const TREE_METADATA_FIELDS = ["tree_depth", "tree_parent", "tree_children", "tree_title"] as const;

// A projection that selects any heavy collection field (or `--full`, which returns
// items verbatim) must load the full metadata; everything else takes the light path.
// Sourced from the single HEAVY_METADATA_KEYS definition in the cache layer so the
// light/heavy split can never drift between the cache and the projection routing.
const HEAVY_PROJECTION_FIELDS: ReadonlySet<string> = new Set<string>(HEAVY_METADATA_KEYS);

interface ListResultBase {
  items: ListedItem[];
  count: number;
  // Total rows matched before pagination; only emitted when --limit/--offset
  // omitted rows, so agents know how many remain (GH-154).
  total?: number;
  warnings?: string[];
}

export interface ListCompactResult extends ListResultBase {
  filters: Record<string, unknown>;
  projection?: undefined;
  sorting?: undefined;
  now?: undefined;
}

export interface ListVerboseResult extends ListResultBase {
  filters: Record<string, unknown>;
  projection: {
    mode: ListProjectionMode;
    fields: string[] | null;
  };
  sorting: {
    sort: ListSortField | "default";
    order: ListSortOrder;
  };
  now: string;
}

export type ListResult = ListCompactResult | ListVerboseResult;

function isNonEmptyRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length > 0;
}

function buildCompactListFilterSummary(params: {
  filtersStatus: string | string[] | null;
  options: ListOptions;
  treeEnabled: boolean;
  treeDepth: number | undefined;
  sortField: ListSortField | undefined;
  sortOrder: ListSortOrder;
  runtimeFieldFilters: Record<string, unknown>;
}): Record<string, unknown> {
  const {
    filtersStatus,
    options,
    treeEnabled,
    treeDepth,
    sortField,
    sortOrder,
    runtimeFieldFilters,
  } = params;
  const filters: Record<string, unknown> = {};
  if (filtersStatus !== null) {
    filters.status = filtersStatus;
  }
  if (options.type !== undefined) {
    filters.type = options.type;
  }
  if (options.tag !== undefined) {
    filters.tag = options.tag;
  }
  if (options.priority !== undefined) {
    filters.priority = options.priority;
  }
  if (options.deadlineBefore !== undefined) {
    filters.deadline_before = options.deadlineBefore;
  }
  if (options.deadlineAfter !== undefined) {
    filters.deadline_after = options.deadlineAfter;
  }
  if (options.updatedAfter !== undefined) {
    filters.updated_after = options.updatedAfter;
  }
  if (options.updatedBefore !== undefined) {
    filters.updated_before = options.updatedBefore;
  }
  if (options.createdAfter !== undefined) {
    filters.created_after = options.createdAfter;
  }
  if (options.createdBefore !== undefined) {
    filters.created_before = options.createdBefore;
  }
  if (options.ids !== undefined) {
    filters.ids = options.ids;
  }
  if (options.assignee !== undefined) {
    filters.assignee = options.assignee;
  }
  if (options.assigneeFilter !== undefined) {
    filters.assignee_filter = options.assigneeFilter;
  }
  if (options.parent !== undefined) {
    filters.parent = options.parent;
  }
  if (options.sprint !== undefined) {
    filters.sprint = options.sprint;
  }
  if (options.release !== undefined) {
    filters.release = options.release;
  }
  if (options.filterAcMissing === true) {
    filters.filter_ac_missing = true;
  }
  if (options.filterEstimatesMissing === true) {
    filters.filter_estimates_missing = true;
  }
  if (options.filterResolutionMissing === true) {
    filters.filter_resolution_missing = true;
  }
  if (options.filterMetadataMissing === true) {
    filters.filter_metadata_missing = true;
  }
  if (options.limit !== undefined) {
    filters.limit = options.limit;
  }
  if (options.offset !== undefined) {
    filters.offset = options.offset;
  }
  if (options.includeBody === true) {
    filters.include_body = true;
  }
  if (options.fields !== undefined) {
    filters.fields = options.fields;
  }
  if (treeEnabled) {
    filters.tree = true;
    if (treeDepth !== undefined) {
      filters.tree_depth = treeDepth;
    }
  }
  if (sortField !== undefined) {
    filters.sort = sortField;
    filters.order = sortOrder;
  }
  if (isNonEmptyRecord(runtimeFieldFilters)) {
    filters.runtime_filters = runtimeFieldFilters;
  }
  return filters;
}

function compareDefaultSort(left: ListedItem, right: ListedItem, statusRegistry: RuntimeStatusRegistry): number {
  const leftTerminal = isTerminalStatus(left.status, statusRegistry);
  const rightTerminal = isTerminalStatus(right.status, statusRegistry);
  if (leftTerminal !== rightTerminal) {
    return leftTerminal ? 1 : -1;
  }
  const byPriority = left.priority - right.priority;
  if (byPriority !== 0) {
    return byPriority;
  }
  const byUpdated = compareTimestampStrings(right.updated_at, left.updated_at);
  if (byUpdated !== 0) {
    return byUpdated;
  }
  return (left.id ?? "").localeCompare(right.id ?? "");
}

function sortItemsDefault(items: ListedItem[], statusRegistry: RuntimeStatusRegistry): ListedItem[] {
  return [...items].sort((left, right) => compareDefaultSort(left, right, statusRegistry));
}

function parseDeadline(raw: string | undefined, fieldLabel: string): string | undefined {
  if (raw === undefined) return undefined;
  return resolveIsoOrRelative(raw, new Date(), fieldLabel);
}

// updated/created date-window filters share the deadline ISO+relative resolver
// so agents doing incremental "what changed since my last context window" syncs
// can pass either an ISO timestamp (the common case — feed back the previous
// run's `now`) or a SIGNED relative offset where "-2h"/"-7d" reach into the
// past and "+1d" into the future (units h/d/w/m, m = months — there is no
// minutes unit, matching the deadline resolver).
function parseTimestampWindow(raw: unknown, fieldLabel: string): string | undefined {
  if (raw == null) return undefined;
  const value = String(raw).trim();
  if (value.length === 0) return undefined;
  return resolveIsoOrRelative(value, new Date(), fieldLabel);
}

function parseIdsFilter(raw: unknown): Set<string> | undefined {
  if (raw == null) return undefined;
  const value = String(raw).trim();
  if (value.length === 0) {
    throw new PmCliError("--ids requires at least one non-empty item ID", EXIT_CODE.USAGE);
  }
  const ids = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (ids.length === 0) {
    throw new PmCliError("--ids requires at least one non-empty item ID", EXIT_CODE.USAGE);
  }
  return new Set(ids);
}

function parseOffset(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new PmCliError("Offset filter must be a non-negative integer", EXIT_CODE.USAGE);
  }
  return parsed;
}

function parseFieldSelectors(raw: string | undefined): string[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const selectors = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (selectors.length === 0) {
    throw new PmCliError("List --fields requires a comma-separated list of field names", EXIT_CODE.USAGE);
  }
  return [...new Set(selectors)];
}

function parseProjectionConfig(options: ListOptions): ListProjectionConfig {
  const compactRequested = options.compact === true;
  const briefRequested = options.brief === true;
  const fullRequested = options.full === true;
  const fieldSelectors = parseFieldSelectors(options.fields);
  const enabledModes =
    Number(compactRequested) + Number(briefRequested) + Number(fullRequested) + Number(fieldSelectors !== undefined);
  if (enabledModes > 1) {
    throw new PmCliError(
      "List projection options are mutually exclusive. Use one of --compact, --brief, --full, or --fields.",
      EXIT_CODE.USAGE,
    );
  }
  if (fullRequested) {
    return {
      mode: "full",
      fields: [],
    };
  }
  if (briefRequested) {
    return {
      mode: "compact",
      fields: [...BRIEF_LIST_FIELDS],
    };
  }
  if (compactRequested) {
    return {
      mode: "compact",
      fields: [...DEFAULT_COMPACT_LIST_FIELDS],
    };
  }
  if (fieldSelectors) {
    return {
      mode: "fields",
      fields: fieldSelectors,
    };
  }
  return {
    mode: "full",
    fields: [],
  };
}

function normalizeProjectionField(field: string): string {
  return field.startsWith("item.") ? field.slice("item.".length) : field;
}

function validateListProjectionFields(projection: ListProjectionConfig, runtimeMetadataKeys: Iterable<string>): void {
  if (projection.mode !== "fields") {
    return;
  }
  const allowed = new Set([...FRONT_MATTER_KEY_ORDER, "body", ...TREE_METADATA_FIELDS, ...runtimeMetadataKeys]);
  const unknown = projection.fields.filter((field) => !allowed.has(normalizeProjectionField(field)));
  if (unknown.length > 0) {
    throw new PmCliError(`Unknown list --fields value(s): ${unknown.join(", ")}`, EXIT_CODE.USAGE, {
      code: "unknown_field_projection",
      examples: [
        "pm list-open --fields id,title,status,type,updated_at",
        "pm list --fields id,title,parent,priority --limit 10",
        "pm list-all --fields id,title,body --limit 5",
      ],
    });
  }
}

// Convenience aliases so agents/humans who reach for the bare verb form
// (e.g. `--sort updated`) land on the canonical timestamp fields instead of an error.
// A Map (not a plain object) avoids prototype-chain lookups for keys like "__proto__".
const LIST_SORT_FIELD_ALIASES: ReadonlyMap<string, ListSortField> = new Map<string, ListSortField>([
  ["updated", "updated_at"],
  ["update", "updated_at"],
  ["modified", "updated_at"],
  ["created", "created_at"],
  ["create", "created_at"],
]);

function parseSortField(raw: string | undefined): ListSortField | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  const aliased = LIST_SORT_FIELD_ALIASES.get(normalized);
  if (aliased) {
    return aliased;
  }
  if (!LIST_SORT_FIELDS.includes(normalized as ListSortField)) {
    throw new PmCliError(
      `Sort field must be one of ${LIST_SORT_FIELDS.join("|")} (aliases: updated->updated_at, created->created_at)`,
      EXIT_CODE.USAGE,
    );
  }
  return normalized as ListSortField;
}

function parseSortOrder(raw: string | undefined): ListSortOrder | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (!LIST_SORT_ORDER_VALUES.includes(normalized as ListSortOrder)) {
    throw new PmCliError(`Sort order must be one of ${LIST_SORT_ORDER_VALUES.join("|")}`, EXIT_CODE.USAGE);
  }
  return normalized as ListSortOrder;
}

function parseTreeDepth(raw: string | undefined): number | undefined {
  return parseIntegerLimit(raw, "--tree-depth");
}

function parseAssigneeFilter(raw: string | undefined): "assigned" | "unassigned" | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    throw new PmCliError("Assignee filter must be one of assigned|unassigned", EXIT_CODE.USAGE);
  }
  if (normalized !== "assigned" && normalized !== "unassigned") {
    throw new PmCliError(`Invalid assignee filter "${raw}". Allowed: assigned|unassigned`, EXIT_CODE.USAGE);
  }
  return normalized;
}

// `pm list` keeps lenient status parsing (an unknown token is passed through
// verbatim and simply matches nothing) so custom/unknown statuses never error;
// the shared CSV parser resolves the open/closed/canceled workflow-group aliases.
function resolveStatusFilter(
  status: ItemStatus | undefined,
  statusRegistry: RuntimeStatusRegistry,
): ItemStatus[] | undefined {
  return parseStatusFilterCsv(status, statusRegistry, { strict: false });
}

function applyFilters(
  items: ListedItem[],
  status: ItemStatus[] | undefined,
  options: ListOptions,
  typeRegistry: ItemTypeRegistry,
  statusRegistry: RuntimeStatusRegistry,
  runtimeFieldFilters: Record<string, unknown>,
): ListedItem[] {
  const statusSet = status && status.length > 0 ? new Set<ItemStatus>(status) : undefined;
  const typeFilter = parseType(options.type, typeRegistry);
  const tagFilter = options.tag?.trim().toLowerCase();
  const priorityFilter = parsePriority(options.priority);
  const deadlineBefore = parseDeadline(options.deadlineBefore, "deadline-before");
  const deadlineAfter = parseDeadline(options.deadlineAfter, "deadline-after");
  const updatedAfter = parseTimestampWindow(options.updatedAfter, "updated-after");
  const updatedBefore = parseTimestampWindow(options.updatedBefore, "updated-before");
  const createdAfter = parseTimestampWindow(options.createdAfter, "created-after");
  const createdBefore = parseTimestampWindow(options.createdBefore, "created-before");
  const idsFilter = parseIdsFilter(options.ids);
  const assigneeFilter = options.assignee?.trim();
  const assigneeModeFilter = parseAssigneeFilter(options.assigneeFilter);
  const parentFilter = options.parent?.trim();
  const sprintFilter = options.sprint?.trim();
  const releaseFilter = options.release?.trim();
  const missingMetadataFilters = resolveMissingMetadataFilters(options);
  const missingMetadataActive = hasMissingMetadataFilter(missingMetadataFilters);
  const lifecycleClassifier = lifecycleClassifierFromStatusRegistry(statusRegistry);

  if (assigneeFilter && (assigneeFilter.toLowerCase() === "none" || assigneeFilter.toLowerCase() === "null")) {
    throw new PmCliError(
      '--assignee no longer accepts "none" or "null". Use --assignee-filter unassigned.',
      EXIT_CODE.USAGE,
    );
  }
  if (assigneeFilter !== undefined && assigneeModeFilter === "unassigned") {
    throw new PmCliError("Cannot combine --assignee with --assignee-filter unassigned", EXIT_CODE.USAGE);
  }

  return items.filter((item) => {
    if (idsFilter && !idsFilter.has(item.id)) return false;
    if (statusSet && !statusSet.has(item.status)) return false;
    if (options.excludeTerminal && isTerminalStatus(item.status, statusRegistry)) return false;
    if (typeFilter && item.type !== typeFilter) return false;
    if (tagFilter && !item.tags.includes(tagFilter)) return false;
    if (priorityFilter !== undefined && item.priority !== priorityFilter) return false;
    if (deadlineBefore && (!item.deadline || compareTimestampStrings(item.deadline, deadlineBefore) > 0)) return false;
    if (deadlineAfter && (!item.deadline || compareTimestampStrings(item.deadline, deadlineAfter) < 0)) return false;
    if (updatedAfter && compareTimestampStrings(item.updated_at, updatedAfter) < 0) return false;
    if (updatedBefore && compareTimestampStrings(item.updated_at, updatedBefore) > 0) return false;
    if (createdAfter && compareTimestampStrings(item.created_at, createdAfter) < 0) return false;
    if (createdBefore && compareTimestampStrings(item.created_at, createdBefore) > 0) return false;
    if (assigneeModeFilter === "assigned" && !item.assignee) return false;
    if (assigneeModeFilter === "unassigned" && item.assignee) return false;
    if (assigneeFilter !== undefined && item.assignee !== assigneeFilter) {
      return false;
    }
    if (parentFilter !== undefined && options.tree !== true && item.parent !== parentFilter) return false;
    if (sprintFilter !== undefined && item.sprint !== sprintFilter) return false;
    if (releaseFilter !== undefined && item.release !== releaseFilter) return false;
    if (missingMetadataActive && !itemMatchesMissingMetadata(item, missingMetadataFilters, lifecycleClassifier)) {
      return false;
    }
    if (!matchesRuntimeFilters(item as Record<string, unknown>, runtimeFieldFilters)) {
      return false;
    }
    return true;
  });
}

function trimNonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function withTreeMetadata(item: ListedItem, depth: number, childCount: number): ListedItem {
  const itemRecord = toItemRecord(item);
  const title = typeof itemRecord.title === "string" ? itemRecord.title : "";
  const parent = trimNonEmpty(typeof itemRecord.parent === "string" ? itemRecord.parent : undefined) ?? null;
  return {
    ...item,
    tree_depth: depth,
    tree_parent: parent,
    tree_children: childCount,
    tree_title: `${"  ".repeat(depth)}${title}`,
  } as ListedItem;
}

function orderItemsAsTree(
  sortedItems: ListedItem[],
  parentRoot: string | undefined,
  maxDepth: number | undefined,
): ListedItem[] {
  const byId = new Map<string, ListedItem>();
  const childrenByParent = new Map<string, ListedItem[]>();
  for (const item of sortedItems) {
    byId.set(item.id, item);
    const parentId = trimNonEmpty(item.parent);
    if (!parentId) {
      continue;
    }
    const bucket = childrenByParent.get(parentId);
    if (bucket) {
      bucket.push(item);
    } else {
      childrenByParent.set(parentId, [item]);
    }
  }

  const roots = parentRoot
    ? [...(childrenByParent.get(parentRoot) ?? [])]
    : sortedItems.filter((item) => {
        const parentId = trimNonEmpty(item.parent);
        return !parentId || !byId.has(parentId);
      });
  const ordered: ListedItem[] = [];
  const visited = new Set<string>();
  const pushNode = (node: ListedItem, depth: number): void => {
    if (visited.has(node.id)) {
      return;
    }
    visited.add(node.id);
    const children = childrenByParent.get(node.id) ?? [];
    ordered.push(withTreeMetadata(node, depth, children.length));
    if (maxDepth !== undefined && depth >= maxDepth) {
      return;
    }
    for (const child of children) {
      pushNode(child, depth + 1);
    }
  };
  for (const root of roots) {
    pushNode(root, 0);
  }
  return ordered;
}

function compareNullableString(left: string | null, right: string | null): number {
  if (left === right) {
    return 0;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  return left.localeCompare(right);
}

function compareNullableTimestamp(left: string | null, right: string | null): number {
  if (left === right) {
    return 0;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  return compareTimestampStrings(left, right);
}

function compareBySortField(left: ListedItem, right: ListedItem, field: ListSortField): number {
  switch (field) {
    case "priority":
      return left.priority - right.priority;
    case "deadline":
      return compareNullableTimestamp(left.deadline ?? null, right.deadline ?? null);
    case "updated_at":
      return compareTimestampStrings(left.updated_at, right.updated_at);
    case "created_at":
      return compareTimestampStrings(left.created_at, right.created_at);
    case "title":
      return (left.title ?? "").localeCompare(right.title ?? "");
    case "parent":
      return compareNullableString(left.parent ?? null, right.parent ?? null);
    default:
      return 0;
  }
}

function sortItems(
  items: ListedItem[],
  sortField: ListSortField | undefined,
  sortOrder: ListSortOrder,
  statusRegistry: RuntimeStatusRegistry,
): ListedItem[] {
  if (!sortField) {
    return sortItemsDefault(items, statusRegistry);
  }
  return [...items].sort((left, right) => {
    const byField = compareBySortField(left, right, sortField);
    if (byField !== 0) {
      return sortOrder === "desc" ? -byField : byField;
    }
    const fallback = compareDefaultSort(left, right, statusRegistry);
    return sortOrder === "desc" ? -fallback : fallback;
  });
}

function readListFieldValue(item: ListedItem, field: string, treeMode = false): unknown {
  const normalized = normalizeProjectionField(field.trim());
  if (normalized.length === 0) {
    return null;
  }
  const itemRecord = toItemRecord(item);
  if (treeMode && normalized === "title" && typeof itemRecord.tree_title === "string") {
    return itemRecord.tree_title;
  }
  if (Object.prototype.hasOwnProperty.call(itemRecord, normalized)) {
    return itemRecord[normalized] ?? null;
  }
  return null;
}

function projectListItems(items: ListedItem[], projection: ListProjectionConfig, treeMode = false): ListedItem[] {
  if (projection.mode === "full") {
    return items;
  }
  return items.map((item) => {
    const projected: Record<string, unknown> = {};
    for (const field of projection.fields) {
      projected[field] = readListFieldValue(item, field, treeMode);
    }
    return projected as unknown as ListedItem;
  });
}

export async function runList(status: ItemStatus | undefined, options: ListOptions, global: GlobalOptions): Promise<ListResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }
  const settings = await readSettings(pmRoot);
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const runtimeFieldRegistry = resolveRuntimeFieldRegistry(settings.schema);
  const runtimeFieldFilters = collectRuntimeFilterValues(options as Record<string, unknown>, runtimeFieldRegistry, "list");
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const projection = parseProjectionConfig(options);
  validateListProjectionFields(projection, runtimeFieldRegistry.definitions.map((field) => field.metadata_key));
  const listWarnings: string[] = [];
  const projectionNeedsBody = projection.fields.some((field) => normalizeProjectionField(field) === "body");
  // The heavy collection fields are only emitted by `--full` (verbatim items) or an
  // explicit `--fields <heavy>` selection. Every other projection (default brief,
  // `--compact`, light `--fields`) reads only light scalar fields, so it takes the
  // light path that skips the large collections cache (the hot-path JSON.parse win).
  const projectionNeedsCollections =
    projection.mode === "full" ||
    projection.fields.some((field) => HEAVY_PROJECTION_FIELDS.has(normalizeProjectionField(field)));
  let items: ListedItem[];
  if (options.includeBody || projectionNeedsBody) {
    items = await listAllFrontMatterWithBody(pmRoot, settings.item_format, typeRegistry.type_to_folder, listWarnings, settings.schema);
  } else if (projectionNeedsCollections) {
    items = await listAllFrontMatter(pmRoot, settings.item_format, typeRegistry.type_to_folder, listWarnings, settings.schema);
  } else {
    items = await listAllFrontMatterLight(pmRoot, settings.item_format, typeRegistry.type_to_folder, listWarnings, settings.schema);
  }
  const sortField = parseSortField(options.sort);
  const sortOrder = parseSortOrder(options.order) ?? "asc";
  const treeEnabled = options.tree === true;
  if (!treeEnabled && options.treeDepth !== undefined) {
    throw new PmCliError("List --tree-depth requires --tree", EXIT_CODE.USAGE);
  }
  const treeDepth = treeEnabled ? parseTreeDepth(options.treeDepth) : undefined;
  const parentRoot = treeEnabled ? trimNonEmpty(options.parent) : undefined;
  if (!sortField && options.order !== undefined) {
    throw new PmCliError("List --order requires --sort", EXIT_CODE.USAGE);
  }
  const explicitStatus = resolveStatusFilter(options.status as ItemStatus | undefined, statusRegistry);
  const resolvedStatus = explicitStatus ?? resolveStatusFilter(status, statusRegistry);
  const effectiveOptions = explicitStatus ? { ...options, excludeTerminal: false } : options;
  const filtered = applyFilters(items, resolvedStatus, effectiveOptions, typeRegistry, statusRegistry, runtimeFieldFilters);
  const filtersStatus =
    resolvedStatus === undefined
      ? null
      : resolvedStatus.length === 1
        ? resolvedStatus[0]
        : resolvedStatus;
  const sorted = sortItems(filtered, sortField, sortOrder, statusRegistry);
  const ordered = treeEnabled ? orderItemsAsTree(sorted, parentRoot, treeDepth) : sorted;
  // --no-truncate (alias --all) forces full results, overriding any --limit so an
  // agent can pull the entire matched set in one call (GH-154).
  const noTruncate = options.noTruncate === true;
  const limit = noTruncate ? undefined : parseIntegerLimit(options.limit);
  const offset = parseOffset(options.offset) ?? 0;
  const limited = limit === undefined ? ordered.slice(offset) : ordered.slice(offset, offset + limit);
  const projected = projectListItems(limited, projection, treeEnabled);
  const totalMatched = ordered.length;
  // Surface the pre-pagination total only when rows were actually omitted.
  const truncationExtras = projected.length < totalMatched ? { total: totalMatched } : {};
  const now = nowIso();
  const warnings = [...new Set(listWarnings)].sort((left, right) => left.localeCompare(right));
  const projectionFields = projection.mode === "full" ? null : [...projection.fields];
  // pm-vhx6: compact-mode list output is primarily consumed by agents. Keep the
  // metadata trailer token-light by returning only active/user-supplied filters
  // and omitting projection/sorting/now boilerplate in this path.
  const compactSummaryMode = projection.mode === "compact" && options.compact === true;
  if (compactSummaryMode) {
    const compactFilters = buildCompactListFilterSummary({
      filtersStatus,
      options,
      treeEnabled,
      treeDepth,
      sortField,
      sortOrder,
      runtimeFieldFilters,
    });
    return {
      items: projected,
      count: projected.length,
      ...truncationExtras,
      filters: compactFilters,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }
  return {
    items: projected,
    count: projected.length,
    ...truncationExtras,
    filters: {
      status: filtersStatus,
      type: options.type ?? null,
      tag: options.tag ?? null,
      priority: options.priority ?? null,
      deadline_before: options.deadlineBefore ?? null,
      deadline_after: options.deadlineAfter ?? null,
      updated_after: options.updatedAfter ?? null,
      updated_before: options.updatedBefore ?? null,
      created_after: options.createdAfter ?? null,
      created_before: options.createdBefore ?? null,
      ids: options.ids ?? null,
      assignee: options.assignee ?? null,
      assignee_filter: options.assigneeFilter ?? null,
      parent: options.parent ?? null,
      sprint: options.sprint ?? null,
      release: options.release ?? null,
      ...(options.filterAcMissing === true ? { filter_ac_missing: true } : {}),
      ...(options.filterEstimatesMissing === true ? { filter_estimates_missing: true } : {}),
      ...(options.filterResolutionMissing === true ? { filter_resolution_missing: true } : {}),
      ...(options.filterMetadataMissing === true ? { filter_metadata_missing: true } : {}),
      limit: options.limit ?? null,
      offset: options.offset ?? null,
      ...(noTruncate ? { no_truncate: true } : {}),
      include_body: options.includeBody ?? null,
      compact: options.compact ?? null,
      fields: options.fields ?? null,
      ...(treeEnabled ? { tree: true, tree_depth: treeDepth ?? null } : {}),
      sort: sortField ?? null,
      order: sortField ? sortOrder : null,
      runtime_filters: runtimeFieldFilters,
    },
    projection: {
      mode: projection.mode,
      fields: projectionFields,
    },
    sorting: {
      sort: sortField ?? "default",
      order: sortField ? sortOrder : "asc",
    },
    now,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export const _testOnly = {
  buildCompactListFilterSummary,
  compareBySortField,
  compareDefaultSort,
  compareNullableString,
  compareNullableTimestamp,
  normalizeProjectionField,
  parseAssigneeFilter,
  parseFieldSelectors,
  parseIdsFilter,
  parseOffset,
  parseProjectionConfig,
  parseSortField,
  parseSortOrder,
  orderItemsAsTree,
  projectListItems,
  readListFieldValue,
  sortItems,
  trimNonEmpty,
  withTreeMetadata,
};
