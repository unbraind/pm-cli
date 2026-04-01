import { pathExists } from "../../core/fs/fs-utils.js";
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { resolveItemTypeRegistry, resolveTypeName, type ItemTypeRegistry } from "../../core/item/type-registry.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { compareTimestampStrings, nowIso, resolveIsoOrRelative } from "../../core/shared/time.js";
import { listAllFrontMatter, listAllFrontMatterWithBody } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type { ItemFrontMatter, ItemStatus, ItemType } from "../../types/index.js";

export interface ListOptions {
  type?: string;
  tag?: string;
  priority?: string;
  deadlineBefore?: string;
  deadlineAfter?: string;
  assignee?: string;
  sprint?: string;
  release?: string;
  limit?: string;
  includeBody?: boolean;
  excludeTerminal?: boolean;
}

export type ListedItem = ItemFrontMatter | (ItemFrontMatter & { body: string });

export interface ListResult {
  items: ListedItem[];
  count: number;
  filters: Record<string, unknown>;
  now: string;
}

function isTerminal(status: ItemStatus): boolean {
  return status === "closed" || status === "canceled";
}

function sortItems(items: ListedItem[]): ListedItem[] {
  return [...items].sort((a, b) => {
    const aTerminal = isTerminal(a.status);
    const bTerminal = isTerminal(b.status);
    if (aTerminal !== bTerminal) {
      return aTerminal ? 1 : -1;
    }
    const byPriority = a.priority - b.priority;
    if (byPriority !== 0) return byPriority;
    const byUpdated = compareTimestampStrings(b.updated_at, a.updated_at);
    if (byUpdated !== 0) return byUpdated;
    return a.id.localeCompare(b.id);
  });
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

function parseDeadline(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  return resolveIsoOrRelative(raw);
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new PmCliError("Limit filter must be a non-negative integer", EXIT_CODE.USAGE);
  }
  return parsed;
}

function applyFilters(
  items: ListedItem[],
  status: ItemStatus | undefined,
  options: ListOptions,
  typeRegistry: ItemTypeRegistry,
): ListedItem[] {
  const typeFilter = parseType(options.type, typeRegistry);
  const tagFilter = options.tag?.trim().toLowerCase();
  const priorityFilter = parsePriority(options.priority);
  const deadlineBefore = parseDeadline(options.deadlineBefore);
  const deadlineAfter = parseDeadline(options.deadlineAfter);
  const assigneeFilter = options.assignee?.trim();
  const sprintFilter = options.sprint?.trim();
  const releaseFilter = options.release?.trim();

  return items.filter((item) => {
    if (status && item.status !== status) return false;
    if (options.excludeTerminal && isTerminal(item.status)) return false;
    if (typeFilter && item.type !== typeFilter) return false;
    if (tagFilter && !item.tags.includes(tagFilter)) return false;
    if (priorityFilter !== undefined && item.priority !== priorityFilter) return false;
    if (deadlineBefore && (!item.deadline || compareTimestampStrings(item.deadline, deadlineBefore) > 0)) return false;
    if (deadlineAfter && (!item.deadline || compareTimestampStrings(item.deadline, deadlineAfter) < 0)) return false;
    if (assigneeFilter !== undefined) {
      if (assigneeFilter.toLowerCase() === "none") {
        if (item.assignee) return false;
      } else {
        if (item.assignee !== assigneeFilter) return false;
      }
    }
    if (sprintFilter !== undefined && item.sprint !== sprintFilter) return false;
    if (releaseFilter !== undefined && item.release !== releaseFilter) return false;
    return true;
  });
}

export async function runList(status: ItemStatus | undefined, options: ListOptions, global: GlobalOptions): Promise<ListResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }
  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const items = options.includeBody
    ? await listAllFrontMatterWithBody(pmRoot, settings.item_format, typeRegistry.type_to_folder)
    : await listAllFrontMatter(pmRoot, settings.item_format, typeRegistry.type_to_folder);
  const filtered = applyFilters(items, status, options, typeRegistry);
  const sorted = sortItems(filtered);
  const limit = parseLimit(options.limit);
  const limited = limit === undefined ? sorted : sorted.slice(0, limit);
  const now = nowIso();
  return {
    items: limited,
    count: limited.length,
    filters: {
      status: status ?? null,
      type: options.type ?? null,
      tag: options.tag ?? null,
      priority: options.priority ?? null,
      deadline_before: options.deadlineBefore ?? null,
      deadline_after: options.deadlineAfter ?? null,
      assignee: options.assignee ?? null,
      sprint: options.sprint ?? null,
      release: options.release ?? null,
      limit: options.limit ?? null,
      include_body: options.includeBody ?? null,
    },
    now,
  };
}
