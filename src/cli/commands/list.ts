import { pathExists } from "../../core/fs/fs-utils.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { nowIso, resolveIsoOrRelative } from "../../core/shared/time.js";
import { listAllFrontMatter } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type { ItemFrontMatter, ItemStatus, ItemType } from "../../types/index.js";

export interface ListOptions {
  type?: string;
  tag?: string;
  priority?: string;
  deadlineBefore?: string;
  deadlineAfter?: string;
  limit?: string;
}

export interface ListResult {
  items: ItemFrontMatter[];
  count: number;
  filters: Record<string, unknown>;
  now: string;
}

const ITEM_TYPES_BY_LOWER = new Map<string, ItemType>([
  ["epic", "Epic"],
  ["feature", "Feature"],
  ["task", "Task"],
  ["chore", "Chore"],
  ["issue", "Issue"],
]);

function isTerminal(status: ItemStatus): boolean {
  return status === "closed" || status === "canceled";
}

function sortItems(items: ItemFrontMatter[]): ItemFrontMatter[] {
  return [...items].sort((a, b) => {
    const aTerminal = isTerminal(a.status);
    const bTerminal = isTerminal(b.status);
    if (aTerminal !== bTerminal) {
      return aTerminal ? 1 : -1;
    }
    const byPriority = a.priority - b.priority;
    if (byPriority !== 0) return byPriority;
    const byUpdated = b.updated_at.localeCompare(a.updated_at);
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

function parseType(raw: string | undefined): ItemType | undefined {
  if (raw === undefined) return undefined;
  const parsed = ITEM_TYPES_BY_LOWER.get(raw.trim().toLowerCase());
  if (!parsed) {
    throw new PmCliError("Type filter must be one of Epic|Feature|Task|Chore|Issue", EXIT_CODE.USAGE);
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

function applyFilters(items: ItemFrontMatter[], status: ItemStatus | undefined, options: ListOptions): ItemFrontMatter[] {
  const typeFilter = parseType(options.type);
  const tagFilter = options.tag?.trim().toLowerCase();
  const priorityFilter = parsePriority(options.priority);
  const deadlineBefore = parseDeadline(options.deadlineBefore);
  const deadlineAfter = parseDeadline(options.deadlineAfter);

  return items.filter((item) => {
    if (status && item.status !== status) return false;
    if (typeFilter && item.type !== typeFilter) return false;
    if (tagFilter && !item.tags.includes(tagFilter)) return false;
    if (priorityFilter !== undefined && item.priority !== priorityFilter) return false;
    if (deadlineBefore && (!item.deadline || item.deadline > deadlineBefore)) return false;
    if (deadlineAfter && (!item.deadline || item.deadline < deadlineAfter)) return false;
    return true;
  });
}

export async function runList(status: ItemStatus | undefined, options: ListOptions, global: GlobalOptions): Promise<ListResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }
  await readSettings(pmRoot);
  const items = await listAllFrontMatter(pmRoot);
  const filtered = applyFilters(items, status, options);
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
      limit: options.limit ?? null,
    },
    now,
  };
}
