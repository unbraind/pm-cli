import { pathExists } from "../../core/fs/fs-utils.js";
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { normalizeStatusInput } from "../../core/item/status.js";
import { resolveItemTypeRegistry, resolveTypeName, type ItemTypeRegistry } from "../../core/item/type-registry.js";
import { collectRuntimeFilterValues, matchesRuntimeFilters } from "../../core/schema/runtime-field-filters.js";
import {
  resolveRuntimeFieldRegistry,
  resolveRuntimeStatusRegistry,
  type RuntimeStatusRegistry,
} from "../../core/schema/runtime-schema.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { compareTimestampStrings, nowIso, resolveIsoOrRelative } from "../../core/shared/time.js";
import { listAllFrontMatter, listAllFrontMatterWithBody } from "../../core/store/item-store.js";
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
  assignee?: string;
  assigneeFilter?: string;
  parent?: string;
  sprint?: string;
  release?: string;
  limit?: string;
  offset?: string;
  includeBody?: boolean;
  compact?: boolean;
  fields?: string;
  sort?: string;
  order?: string;
  excludeTerminal?: boolean;
  [key: string]: unknown;
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

export interface ListResult {
  items: ListedItem[];
  count: number;
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
  warnings?: string[];
}

function isTerminal(status: ItemStatus, statusRegistry: RuntimeStatusRegistry): boolean {
  const normalized = normalizeStatusInput(status, statusRegistry) ?? status;
  return statusRegistry.terminal_statuses.has(normalized);
}

function compareDefaultSort(left: ListedItem, right: ListedItem, statusRegistry: RuntimeStatusRegistry): number {
  const leftTerminal = isTerminal(left.status, statusRegistry);
  const rightTerminal = isTerminal(right.status, statusRegistry);
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
  return left.id.localeCompare(right.id);
}

function sortItemsDefault(items: ListedItem[], statusRegistry: RuntimeStatusRegistry): ListedItem[] {
  return [...items].sort((left, right) => compareDefaultSort(left, right, statusRegistry));
}

function parsePriority(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 4) {
    throw new PmCliError("Priority filter must be 0..4", EXIT_CODE.USAGE);
  }
  return parsed;
}

function parseType(raw: string | undefined, typeRegistry: ItemTypeRegistry): ItemType | undefined {
  if (raw === undefined) return undefined;
  const parsed = resolveTypeName(raw, typeRegistry);
  if (!parsed) {
    throw new PmCliError(`Type filter must be one of ${typeRegistry.types.join("|")}`, EXIT_CODE.USAGE);
  }
  return parsed;
}

function parseDeadline(raw: string | undefined, fieldLabel: string): string | undefined {
  if (raw === undefined) return undefined;
  return resolveIsoOrRelative(raw, new Date(), fieldLabel);
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new PmCliError("Limit filter must be a non-negative integer", EXIT_CODE.USAGE);
  }
  return parsed;
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
  const fieldSelectors = parseFieldSelectors(options.fields);
  const enabledModes = Number(compactRequested) + Number(fieldSelectors !== undefined);
  if (enabledModes > 1) {
    throw new PmCliError("List projection options are mutually exclusive. Use one of --compact or --fields.", EXIT_CODE.USAGE);
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

function parseSortField(raw: string | undefined): ListSortField | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (!LIST_SORT_FIELDS.includes(normalized as ListSortField)) {
    throw new PmCliError(`Sort field must be one of ${LIST_SORT_FIELDS.join("|")}`, EXIT_CODE.USAGE);
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

function resolveStatusFilter(status: ItemStatus | undefined, statusRegistry: RuntimeStatusRegistry): ItemStatus | undefined {
  if (status === undefined) {
    return undefined;
  }
  const normalized = normalizeStatusInput(status, statusRegistry);
  const token = status.trim().toLowerCase();
  if (token === "open") {
    return statusRegistry.open_status;
  }
  if (token === "closed") {
    return statusRegistry.close_status;
  }
  if (token === "canceled" || token === "cancelled") {
    return statusRegistry.canceled_status;
  }
  return normalized ?? status;
}

function applyFilters(
  items: ListedItem[],
  status: ItemStatus | undefined,
  options: ListOptions,
  typeRegistry: ItemTypeRegistry,
  statusRegistry: RuntimeStatusRegistry,
  runtimeFieldFilters: Record<string, unknown>,
): ListedItem[] {
  const typeFilter = parseType(options.type, typeRegistry);
  const tagFilter = options.tag?.trim().toLowerCase();
  const priorityFilter = parsePriority(options.priority);
  const deadlineBefore = parseDeadline(options.deadlineBefore, "deadline-before");
  const deadlineAfter = parseDeadline(options.deadlineAfter, "deadline-after");
  const assigneeFilter = options.assignee?.trim();
  const assigneeModeFilter = parseAssigneeFilter(options.assigneeFilter);
  const parentFilter = options.parent?.trim();
  const sprintFilter = options.sprint?.trim();
  const releaseFilter = options.release?.trim();

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
    if (status && item.status !== status) return false;
    if (options.excludeTerminal && isTerminal(item.status, statusRegistry)) return false;
    if (typeFilter && item.type !== typeFilter) return false;
    if (tagFilter && !item.tags.includes(tagFilter)) return false;
    if (priorityFilter !== undefined && item.priority !== priorityFilter) return false;
    if (deadlineBefore && (!item.deadline || compareTimestampStrings(item.deadline, deadlineBefore) > 0)) return false;
    if (deadlineAfter && (!item.deadline || compareTimestampStrings(item.deadline, deadlineAfter) < 0)) return false;
    if (assigneeModeFilter === "assigned" && !item.assignee) return false;
    if (assigneeModeFilter === "unassigned" && item.assignee) return false;
    if (assigneeFilter !== undefined && item.assignee !== assigneeFilter) {
      return false;
    }
    if (parentFilter !== undefined && item.parent !== parentFilter) return false;
    if (sprintFilter !== undefined && item.sprint !== sprintFilter) return false;
    if (releaseFilter !== undefined && item.release !== releaseFilter) return false;
    if (!matchesRuntimeFilters(item as Record<string, unknown>, runtimeFieldFilters)) {
      return false;
    }
    return true;
  });
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
      return left.title.localeCompare(right.title);
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

function readListFieldValue(item: ListedItem, field: string): unknown {
  const normalized = field.trim();
  if (normalized.length === 0) {
    return null;
  }
  if (normalized.startsWith("item.")) {
    const nestedKey = normalized.slice("item.".length);
    if (nestedKey.length === 0) {
      return null;
    }
    const itemRecord = item as unknown as Record<string, unknown>;
    return itemRecord[nestedKey] ?? null;
  }
  const itemRecord = item as unknown as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(itemRecord, normalized)) {
    return itemRecord[normalized] ?? null;
  }
  return null;
}

function projectListItems(items: ListedItem[], projection: ListProjectionConfig): ListedItem[] {
  if (projection.mode === "full") {
    return items;
  }
  return items.map((item) => {
    const projected: Record<string, unknown> = {};
    for (const field of projection.fields) {
      projected[field] = readListFieldValue(item, field);
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
  const listWarnings: string[] = [];
  const items = options.includeBody
    ? await listAllFrontMatterWithBody(pmRoot, settings.item_format, typeRegistry.type_to_folder, listWarnings, settings.schema)
    : await listAllFrontMatter(pmRoot, settings.item_format, typeRegistry.type_to_folder, listWarnings, settings.schema);
  const projection = parseProjectionConfig(options);
  const sortField = parseSortField(options.sort);
  const sortOrder = parseSortOrder(options.order) ?? "asc";
  if (!sortField && options.order !== undefined) {
    throw new PmCliError("List --order requires --sort", EXIT_CODE.USAGE);
  }
  const explicitStatus = resolveStatusFilter(options.status as ItemStatus | undefined, statusRegistry);
  const resolvedStatus = explicitStatus ?? resolveStatusFilter(status, statusRegistry);
  const effectiveOptions = explicitStatus ? { ...options, excludeTerminal: false } : options;
  const filtered = applyFilters(items, resolvedStatus, effectiveOptions, typeRegistry, statusRegistry, runtimeFieldFilters);
  const sorted = sortItems(filtered, sortField, sortOrder, statusRegistry);
  const limit = parseLimit(options.limit);
  const offset = parseOffset(options.offset) ?? 0;
  const limited = limit === undefined ? sorted.slice(offset) : sorted.slice(offset, offset + limit);
  const projected = projectListItems(limited, projection);
  const now = nowIso();
  const warnings = [...new Set(listWarnings)].sort((left, right) => left.localeCompare(right));
  const projectionFields = projection.mode === "full" ? null : [...projection.fields];
  return {
    items: projected,
    count: projected.length,
    filters: {
      status: resolvedStatus ?? null,
      type: options.type ?? null,
      tag: options.tag ?? null,
      priority: options.priority ?? null,
      deadline_before: options.deadlineBefore ?? null,
      deadline_after: options.deadlineAfter ?? null,
      assignee: options.assignee ?? null,
      assignee_filter: options.assigneeFilter ?? null,
      parent: options.parent ?? null,
      sprint: options.sprint ?? null,
      release: options.release ?? null,
      limit: options.limit ?? null,
      offset: options.offset ?? null,
      include_body: options.includeBody ?? null,
      compact: options.compact ?? null,
      fields: options.fields ?? null,
      sort: sortField ?? null,
      order: sortField ? sortOrder : null,
      projection: projection.mode,
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
