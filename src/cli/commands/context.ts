import { SETTINGS_DEFAULTS, EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { compareTimestampStrings, nowIso } from "../../core/shared/time.js";
import { isTerminalStatus, normalizeStatusForRegistry, normalizeStatusInput } from "../../core/item/status.js";
import { resolveRuntimeStatusRegistry, type RuntimeStatusRegistry } from "../../core/schema/runtime-schema.js";
import { resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type {
  ContextDepth,
  ContextSectionName,
  ContextSettings,
  ItemFrontMatter,
  ItemStatus,
  PmSettings,
} from "../../types/index.js";
import { CONTEXT_DEPTH_VALUES, CONTEXT_SECTION_VALUES } from "../../types/index.js";
import { parseIntegerLimit } from "../shared-parsers.js";
import { runCalendar, type CalendarOptions, type CalendarRow } from "./calendar.js";
import { runList, type ListOptions } from "./list.js";
import { runActivity, type CompactActivityEntry } from "./activity.js";

// ---------------------------------------------------------------------------
// Output format
// ---------------------------------------------------------------------------

export const CONTEXT_OUTPUT_VALUES = ["markdown", "toon", "json"] as const;
export type ContextOutputFormat = (typeof CONTEXT_OUTPUT_VALUES)[number];

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ContextOptions {
  date?: string;
  from?: string;
  to?: string;
  past?: boolean;
  type?: string;
  tag?: string;
  priority?: string;
  assignee?: string;
  assigneeFilter?: string;
  sprint?: string;
  release?: string;
  limit?: string;
  format?: string;
  depth?: string;
  section?: string[];
  activityLimit?: string;
  staleThreshold?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Focus item (unchanged from original)
// ---------------------------------------------------------------------------

export interface ContextFocusItem {
  id: string;
  title: string;
  type: string;
  status: ItemStatus;
  priority: number;
  order: number | null;
  deadline: string | null;
  assignee: string | null;
  tags: string[];
  updated_at: string;
  parent: string | null;
  children_total?: number;
  children_closed?: number;
  completion_pct?: number;
}

// ---------------------------------------------------------------------------
// Section data types
// ---------------------------------------------------------------------------

export interface HierarchyChild {
  id: string;
  title: string;
  type: string;
  status: ItemStatus;
  children_total: number;
  children_closed: number;
}

export interface HierarchyNode {
  id: string;
  title: string;
  type: string;
  status: ItemStatus;
  children_total: number;
  children_closed: number;
  children_open: number;
  children_in_progress: number;
  children_blocked: number;
  children: HierarchyChild[];
}

export interface ProgressEntry {
  id: string;
  title: string;
  type: string;
  total: number;
  closed: number;
  open: number;
  in_progress: number;
  blocked: number;
  completion_pct: number;
}

export interface BlockerEntry {
  id: string;
  title: string;
  blocked_by: string | null;
  blocked_by_title: string | null;
  blocked_by_status: ItemStatus | null;
  blocked_reason: string | null;
  unblock_note: string | null;
}

export interface HotFile {
  path: string;
  references: number;
  items: string[];
}

export interface WorkloadEntry {
  assignee: string | null;
  active: number;
  in_progress: number;
  items: string[];
}

export interface StaleEntry {
  id: string;
  title: string;
  status: ItemStatus;
  updated_at: string;
  stale_days: number;
}

export interface RecentContextItem extends ContextFocusItem {
  created_at?: string;
}

export interface TestHealthSummary {
  items_with_tests: number;
  items_with_recent_runs: number;
  recent_runs: {
    passed: number;
    failed: number;
    skipped: number;
  };
  items_failing: string[];
}

// ---------------------------------------------------------------------------
// Agenda / summary (unchanged)
// ---------------------------------------------------------------------------

interface ContextAgendaSummary {
  events: number;
  items: number;
  deadlines: number;
  reminders: number;
  scheduled: number;
}

interface ContextSummary {
  active_items: number;
  in_progress: number;
  open: number;
  blocked: number;
  blocked_fallback_used: boolean;
  high_level: number;
  low_level: number;
  agenda_events: number;
  total_items?: number;
  closed?: number;
  canceled?: number;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface ContextResult {
  output_default: "toon";
  now: string;
  depth: ContextDepth;
  sections_included: ContextSectionName[];
  window: {
    anchor: string;
    start: string | null;
    end: string | null;
    past: boolean;
    from: string | null;
    to: string | null;
  };
  filters: {
    type: string | null;
    tag: string | null;
    priority: string | null;
    assignee: string | null;
    assignee_filter: string | null;
    sprint: string | null;
    release: string | null;
    limit: string | null;
    runtime_filters?: Record<string, unknown>;
  };
  summary: ContextSummary;
  high_level: ContextFocusItem[];
  low_level: ContextFocusItem[];
  blocked_fallback: ContextFocusItem[];
  agenda: {
    summary: ContextAgendaSummary;
    events: CalendarRow[];
  };
  hierarchy?: HierarchyNode[];
  activity?: CompactActivityEntry[];
  progress?: ProgressEntry[];
  blockers?: BlockerEntry[];
  recently_created?: RecentContextItem[];
  unparented?: ContextFocusItem[];
  files?: HotFile[];
  workload?: WorkloadEntry[];
  staleness?: StaleEntry[];
  tests?: TestHealthSummary;
  suggestions?: string[];
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HIGH_LEVEL_TYPES = new Set<string>(["Epic", "Feature"]);
const DEFAULT_CONTEXT_LIMIT = 10;

const STANDARD_SECTIONS: ContextSectionName[] = ["hierarchy", "activity", "progress", "recently_created", "unparented", "workload"];
const DEEP_SECTIONS: ContextSectionName[] = [
  ...STANDARD_SECTIONS,
  "blockers",
  "files",
  "staleness",
  "tests",
];
const LEADING_HYPHEN_DATE = /^(\d{4})-(\d{2})-(\d{2})/;
const LEADING_COMPACT_DATE = /^(\d{4})(\d{2})(\d{2})(?:[T ]?\d{2}|$)/;
const COMPACT_DATE = /^(\d{4})(\d{2})(\d{2})$/;
const COMPACT_DATETIME = /^(\d{4})(\d{2})(\d{2})(?:[T\s]?)(\d{2})(\d{2})(\d{2})?(Z|[+-]\d{2}:?\d{2})?$/i;

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function parseOutputFormat(raw: string | undefined): ContextOutputFormat | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (!CONTEXT_OUTPUT_VALUES.includes(normalized as ContextOutputFormat)) {
    throw new PmCliError("Context format must be one of markdown|toon|json", EXIT_CODE.USAGE);
  }
  return normalized as ContextOutputFormat;
}

export function resolveContextOutputFormat(options: ContextOptions, global: GlobalOptions): ContextOutputFormat {
  const commandFormat = parseOutputFormat(options.format);
  if (global.json && commandFormat && commandFormat !== "json") {
    throw new PmCliError("Cannot combine --json with --format markdown|toon", EXIT_CODE.USAGE);
  }
  if (global.json) {
    return "json";
  }
  return commandFormat ?? "toon";
}

function parseContextLimit(raw: string | undefined): number {
  return parseIntegerLimit(raw, "--limit") ?? DEFAULT_CONTEXT_LIMIT;
}

export function parseContextDepth(raw: string | undefined, settings: ContextSettings): ContextDepth {
  if (!raw) return settings.default_depth;
  const normalized = raw.trim().toLowerCase();
  if (!CONTEXT_DEPTH_VALUES.includes(normalized as ContextDepth)) {
    throw new PmCliError(`Context --depth must be one of ${CONTEXT_DEPTH_VALUES.join("|")}`, EXIT_CODE.USAGE);
  }
  return normalized as ContextDepth;
}

export function parseContextSections(
  raw: string[] | undefined,
  depth: ContextDepth,
  settings: ContextSettings,
): ContextSectionName[] {
  if (raw && raw.length > 0) {
    const sections: ContextSectionName[] = [];
    for (const value of raw) {
      const normalized = value.trim().toLowerCase();
      if (!CONTEXT_SECTION_VALUES.includes(normalized as ContextSectionName)) {
        throw new PmCliError(
          `Context --section must be one of ${CONTEXT_SECTION_VALUES.join("|")}`,
          EXIT_CODE.USAGE,
        );
      }
      if (!sections.includes(normalized as ContextSectionName)) {
        sections.push(normalized as ContextSectionName);
      }
    }
    return sections;
  }
  if (depth === "brief") return [];
  const pool = depth === "deep" ? DEEP_SECTIONS : STANDARD_SECTIONS;
  return pool.filter((section) => settings.sections[section]);
}

function parseActivityLimit(raw: string | undefined, settings: ContextSettings): number {
  if (!raw) return settings.activity_limit;
  return parseIntegerLimit(raw, "--activity-limit") ?? settings.activity_limit;
}

function parseStaleThresholdDays(raw: string | undefined, settings: ContextSettings): number {
  if (!raw) return settings.stale_threshold_days;
  const trimmed = raw.trim().toLowerCase();
  const match = /^(\d+)d?$/.exec(trimmed);
  if (!match) {
    throw new PmCliError("--stale-threshold must be a number of days (e.g. 7 or 7d)", EXIT_CODE.USAGE);
  }
  const days = parseInt(match[1], 10);
  if (days <= 0) {
    throw new PmCliError("--stale-threshold must be positive", EXIT_CODE.USAGE);
  }
  return days;
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

function statusRank(status: ItemStatus, statusRegistry: RuntimeStatusRegistry): number {
  const normalizedStatus = normalizeStatusForRegistry(status, statusRegistry);
  const inProgressStatus = normalizeStatusInput("in_progress", statusRegistry);
  const openStatus = normalizeStatusInput("open", statusRegistry) ?? statusRegistry.open_status;
  const blockedStatus = normalizeStatusInput("blocked", statusRegistry);
  const draftStatus = normalizeStatusInput("draft", statusRegistry);
  if (inProgressStatus && normalizedStatus === inProgressStatus) return 0;
  if (openStatus && normalizedStatus === openStatus) return 1;
  if (blockedStatus && normalizedStatus === blockedStatus) return 2;
  if (draftStatus && normalizedStatus === draftStatus) return 3;
  if (statusRegistry.active_statuses.has(normalizedStatus)) return 4;
  if (statusRegistry.blocked_statuses.has(normalizedStatus)) return 5;
  if (statusRegistry.terminal_statuses.has(normalizedStatus)) return 7;
  return 6;
}

function isClosedStatus(status: ItemStatus, statusRegistry: RuntimeStatusRegistry): boolean {
  const closeStatus = normalizeStatusInput("closed", statusRegistry);
  return closeStatus ? normalizeStatusForRegistry(status, statusRegistry) === closeStatus : false;
}

function isInProgressStatus(status: ItemStatus, statusRegistry: RuntimeStatusRegistry): boolean {
  const inProgressStatus = normalizeStatusInput("in_progress", statusRegistry);
  return inProgressStatus ? normalizeStatusForRegistry(status, statusRegistry) === inProgressStatus : false;
}

function isOpenStatus(status: ItemStatus, statusRegistry: RuntimeStatusRegistry): boolean {
  const openStatus = normalizeStatusInput("open", statusRegistry) ?? statusRegistry.open_status;
  return normalizeStatusForRegistry(status, statusRegistry) === openStatus;
}

function isBlockedStatus(status: ItemStatus, statusRegistry: RuntimeStatusRegistry): boolean {
  return statusRegistry.blocked_statuses.has(normalizeStatusForRegistry(status, statusRegistry));
}

// Projection flags belong to list/calendar/activity output shaping and must not
// leak into runContext's downstream calls, which need full ItemFrontMatter rows.
const LIST_PROJECTION_FLAGS = ["compact", "brief", "fields", "includeBody", "include_body"] as const;

function stripListProjectionFlags(options: ContextOptions): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...(options as Record<string, unknown>) };
  for (const key of LIST_PROJECTION_FLAGS) {
    delete copy[key];
  }
  return copy;
}

// ---------------------------------------------------------------------------
// Sorting / mapping helpers (unchanged from original)
// ---------------------------------------------------------------------------

function compareOptionalOrder(left: number | null | undefined, right: number | null | undefined): number {
  const leftValue = left ?? null;
  const rightValue = right ?? null;
  if (leftValue === null && rightValue === null) return 0;
  if (leftValue === null) return 1;
  if (rightValue === null) return -1;
  return leftValue - rightValue;
}

function compareOptionalDeadline(left: string | null | undefined, right: string | null | undefined): number {
  const leftValue = left ?? null;
  const rightValue = right ?? null;
  if (leftValue === null && rightValue === null) return 0;
  if (leftValue === null) return 1;
  if (rightValue === null) return -1;
  return compareTimestampStrings(leftValue, rightValue);
}

function daysInUtcMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function hasNoInvalidDatePrefix(value: string): boolean {
  const match = LEADING_HYPHEN_DATE.exec(value) ?? LEADING_COMPACT_DATE.exec(value);
  if (!match) {
    return true;
  }
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInUtcMonth(year, month - 1);
}

function normalizeTimestampCandidate(value: string): string {
  const compactDate = COMPACT_DATE.exec(value);
  if (compactDate) {
    return `${compactDate[1]}-${compactDate[2]}-${compactDate[3]}`;
  }
  const compactDateTime = COMPACT_DATETIME.exec(value);
  if (compactDateTime) {
    const [, year, month, day, hour, minute, secondRaw, offsetRaw] = compactDateTime;
    const second = secondRaw ? `:${secondRaw}` : "";
    const offset = offsetRaw && offsetRaw.length === 5 && offsetRaw !== "Z" ? `${offsetRaw.slice(0, 3)}:${offsetRaw.slice(3)}` : offsetRaw ?? "";
    return `${year}-${month}-${day}T${hour}:${minute}${second}${offset}`;
  }
  return value;
}

function parseContextTimestampMs(value: unknown): number {
  if (typeof value !== "string") {
    return Number.NaN;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || !hasNoInvalidDatePrefix(trimmed)) {
    return Number.NaN;
  }
  const parsed = Date.parse(normalizeTimestampCandidate(trimmed));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function sortableTimestamp(value: unknown): string {
  const parsed = parseContextTimestampMs(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function dateTokenForTimestamp(value: unknown): string {
  const parsed = parseContextTimestampMs(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : "unknown";
}

function normalizedParentId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function compareCriticalItems(left: ItemFrontMatter, right: ItemFrontMatter, statusRegistry: RuntimeStatusRegistry): number {
  const byStatus = statusRank(left.status, statusRegistry) - statusRank(right.status, statusRegistry);
  if (byStatus !== 0) return byStatus;
  const byPriority = left.priority - right.priority;
  if (byPriority !== 0) return byPriority;
  const byOrder = compareOptionalOrder(left.order, right.order);
  if (byOrder !== 0) return byOrder;
  const byDeadline = compareOptionalDeadline(left.deadline, right.deadline);
  if (byDeadline !== 0) return byDeadline;
  const byUpdated = compareTimestampStrings(sortableTimestamp(right.updated_at), sortableTimestamp(left.updated_at));
  const byId = left.id.localeCompare(right.id);
  return byUpdated !== 0 ? byUpdated : byId;
}

function completionPct(closed: number, total: number): number {
  return total > 0 ? Math.round((closed / total) * 100) : 0;
}

function buildChildrenByParent(allItems: ItemFrontMatter[]): Map<string, ItemFrontMatter[]> {
  const childrenByParent = new Map<string, ItemFrontMatter[]>();
  for (const item of allItems) {
    const parent = normalizedParentId(item.parent);
    if (!parent) continue;
    const children = childrenByParent.get(parent) ?? [];
    children.push(item);
    childrenByParent.set(parent, children);
  }
  return childrenByParent;
}

function toContextFocusItem(
  item: ItemFrontMatter,
  statusRegistry?: RuntimeStatusRegistry,
  childrenByParent?: Map<string, ItemFrontMatter[]>,
): ContextFocusItem {
  const focus: ContextFocusItem = {
    id: item.id,
    title: item.title,
    type: item.type,
    status: item.status,
    priority: item.priority,
    order: item.order ?? null,
    deadline: item.deadline ?? null,
    assignee: item.assignee ?? null,
    tags: Array.isArray(item.tags) ? [...item.tags] : [],
    updated_at: item.updated_at,
    parent: normalizedParentId(item.parent),
  };
  if (statusRegistry && childrenByParent) {
    const descendants = collectDescendants(item.id, childrenByParent);
    const total = descendants.length;
    if (total > 0) {
      const closed = descendants.filter((desc) => isClosedStatus(desc.status, statusRegistry)).length;
      focus.children_total = total;
      focus.children_closed = closed;
      focus.completion_pct = completionPct(closed, total);
    }
  }
  return focus;
}

function summarizeAgenda(events: CalendarRow[]): ContextAgendaSummary {
  let deadlines = 0;
  let reminders = 0;
  let scheduled = 0;
  const itemIds = new Set<string>();
  for (const event of events) {
    itemIds.add(event.item_id);
    if (event.kind === "deadline") {
      deadlines += 1;
      continue;
    }
    if (event.kind === "reminder") {
      reminders += 1;
      continue;
    }
    scheduled += 1;
  }
  return {
    events: events.length,
    items: itemIds.size,
    deadlines,
    reminders,
    scheduled,
  };
}

function filterTerminalCalendarEvents(events: CalendarRow[], statusRegistry: RuntimeStatusRegistry): CalendarRow[] {
  return events.filter((event) => !statusRegistry.terminal_statuses.has(normalizeStatusForRegistry(event.item_status, statusRegistry)));
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

function buildHierarchy(
  allItems: ItemFrontMatter[],
  activeItems: ItemFrontMatter[],
  statusRegistry: RuntimeStatusRegistry,
  limit: number,
): HierarchyNode[] {
  const itemMap = new Map<string, ItemFrontMatter>();
  for (const item of allItems) {
    itemMap.set(item.id, item);
  }

  const childrenByParent = buildChildrenByParent(allItems);

  const activeHighLevelIds = new Set(
    activeItems.filter((item) => HIGH_LEVEL_TYPES.has(item.type)).map((item) => item.id),
  );

  const nodes: HierarchyNode[] = [];
  for (const parentId of activeHighLevelIds) {
    const parent = itemMap.get(parentId);
    if (!parent) continue;
    const allDescendants = collectDescendants(parentId, childrenByParent);
    const childItems = childrenByParent.get(parentId) ?? [];

    let closedCount = 0;
    let openCount = 0;
    let inProgressCount = 0;
    let blockedCount = 0;
    for (const desc of allDescendants) {
      if (isClosedStatus(desc.status, statusRegistry)) closedCount++;
      else if (isInProgressStatus(desc.status, statusRegistry)) inProgressCount++;
      else if (isBlockedStatus(desc.status, statusRegistry)) blockedCount++;
      else if (isOpenStatus(desc.status, statusRegistry)) openCount++;
    }

    const children: HierarchyChild[] = childItems
      .sort((a, b) => compareCriticalItems(a, b, statusRegistry))
      .slice(0, limit)
      .map((child) => {
        const grandchildren = collectDescendants(child.id, childrenByParent);
        const gcClosed = grandchildren.filter((gc) => isClosedStatus(gc.status, statusRegistry)).length;
        return {
          id: child.id,
          title: child.title,
          type: child.type,
          status: child.status,
          children_total: grandchildren.length,
          children_closed: gcClosed,
        };
      });

    nodes.push({
      id: parent.id,
      title: parent.title,
      type: parent.type,
      status: parent.status,
      children_total: allDescendants.length,
      children_closed: closedCount,
      children_open: openCount,
      children_in_progress: inProgressCount,
      children_blocked: blockedCount,
      children,
    });
  }

  return nodes
    .sort((a, b) => {
      const aParent = itemMap.get(a.id)!;
      const bParent = itemMap.get(b.id)!;
      return compareCriticalItems(aParent, bParent, statusRegistry);
    })
    .slice(0, limit);
}

function collectDescendants(
  parentId: string,
  childrenByParent: Map<string, ItemFrontMatter[]>,
): ItemFrontMatter[] {
  const result: ItemFrontMatter[] = [];
  const stack = [parentId];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const children = childrenByParent.get(current) ?? [];
    for (const child of children) {
      result.push(child);
      stack.push(child.id);
    }
  }
  return result;
}

async function buildActivity(
  activityLimit: number,
  global: GlobalOptions,
): Promise<CompactActivityEntry[]> {
  const result = await runActivity({ compact: true, limit: String(activityLimit) }, global);
  return result.compact_activity ?? [];
}

function buildProgress(
  allItems: ItemFrontMatter[],
  activeItems: ItemFrontMatter[],
  statusRegistry: RuntimeStatusRegistry,
  limit: number,
): ProgressEntry[] {
  const childrenByParent = new Map<string, ItemFrontMatter[]>();
  for (const item of allItems) {
    if (!item.parent) continue;
    const children = childrenByParent.get(item.parent) ?? [];
    children.push(item);
    childrenByParent.set(item.parent, children);
  }

  const activeHighLevel = activeItems.filter((item) => HIGH_LEVEL_TYPES.has(item.type));
  const entries: ProgressEntry[] = [];
  for (const parent of activeHighLevel) {
    const descendants = collectDescendants(parent.id, childrenByParent);
    const total = descendants.length;
    if (total === 0) continue;

    let closed = 0;
    let open = 0;
    let inProgress = 0;
    let blocked = 0;
    for (const desc of descendants) {
      if (isClosedStatus(desc.status, statusRegistry)) closed++;
      else if (isInProgressStatus(desc.status, statusRegistry)) inProgress++;
      else if (isBlockedStatus(desc.status, statusRegistry)) blocked++;
      else if (isOpenStatus(desc.status, statusRegistry)) open++;
    }

    entries.push({
      id: parent.id,
      title: parent.title,
      type: parent.type,
      total,
      closed,
      open,
      in_progress: inProgress,
      blocked,
      completion_pct: completionPct(closed, total),
    });
  }

  return entries
    .sort((a, b) => a.completion_pct - b.completion_pct)
    .slice(0, limit);
}

function buildBlockers(
  blockedItems: ItemFrontMatter[],
  itemMap: Map<string, ItemFrontMatter>,
  limit: number,
): BlockerEntry[] {
  return blockedItems.slice(0, limit).map((item) => {
    const blockerItem = item.blocked_by ? itemMap.get(item.blocked_by) : undefined;
    return {
      id: item.id,
      title: item.title,
      blocked_by: item.blocked_by ?? null,
      blocked_by_title: blockerItem?.title ?? null,
      blocked_by_status: blockerItem?.status ?? null,
      blocked_reason: item.blocked_reason ?? null,
      unblock_note: item.unblock_note ?? null,
    };
  });
}

function buildHotFiles(
  activeItems: ItemFrontMatter[],
  limit: number,
): HotFile[] {
  const fileMap = new Map<string, Set<string>>();
  for (const item of activeItems) {
    for (const file of item.files ?? []) {
      const existing = fileMap.get(file.path) ?? new Set<string>();
      existing.add(item.id);
      fileMap.set(file.path, existing);
    }
  }

  return [...fileMap.entries()]
    .map(([filePath, itemIds]) => ({
      path: filePath,
      references: itemIds.size,
      items: [...itemIds].sort(),
    }))
    .sort((a, b) => b.references - a.references)
    .slice(0, limit);
}

function buildWorkload(
  activeItems: ItemFrontMatter[],
  statusRegistry: RuntimeStatusRegistry,
  limit: number,
): WorkloadEntry[] {
  const groups = new Map<string | null, ItemFrontMatter[]>();
  for (const item of activeItems) {
    const key = item.assignee ?? null;
    const existing = groups.get(key) ?? [];
    existing.push(item);
    groups.set(key, existing);
  }

  return [...groups.entries()]
    .map(([assignee, items]) => ({
      assignee,
      active: items.length,
      in_progress: items.filter((item) => isInProgressStatus(item.status, statusRegistry)).length,
      items: items.map((item) => item.id).sort(),
    }))
    .sort((a, b) => b.active - a.active)
    .slice(0, limit);
}

function buildStaleness(
  allNonTerminal: ItemFrontMatter[],
  staleThresholdDays: number,
  now: string,
  limit: number,
): StaleEntry[] {
  const cutoffMs = new Date(now).getTime() - staleThresholdDays * 24 * 60 * 60 * 1000;

  return allNonTerminal
    .filter((item) => new Date(item.updated_at).getTime() < cutoffMs)
    .map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      updated_at: item.updated_at,
      stale_days: Math.floor((new Date(now).getTime() - new Date(item.updated_at).getTime()) / (24 * 60 * 60 * 1000)),
    }))
    .sort((a, b) => b.stale_days - a.stale_days)
    .slice(0, limit);
}

function buildRecentlyCreated(
  allNonTerminal: ItemFrontMatter[],
  statusRegistry: RuntimeStatusRegistry,
  childrenByParent: Map<string, ItemFrontMatter[]>,
  limit: number,
): RecentContextItem[] {
  return allNonTerminal
    .map((item) => ({ item, sortKey: sortableTimestamp(item.created_at) }))
    .sort((left, right) => {
      const byCreated = compareTimestampStrings(right.sortKey, left.sortKey);
      return byCreated !== 0 ? byCreated : left.item.id.localeCompare(right.item.id);
    })
    .slice(0, limit)
    .map(({ item }) => ({
      ...toContextFocusItem(item, statusRegistry, childrenByParent),
      created_at: item.created_at,
    }));
}

function buildUnparented(
  allNonTerminal: ItemFrontMatter[],
  statusRegistry: RuntimeStatusRegistry,
  childrenByParent: Map<string, ItemFrontMatter[]>,
  limit: number,
): ContextFocusItem[] {
  return allNonTerminal
    .filter((item) => !normalizedParentId(item.parent) && !HIGH_LEVEL_TYPES.has(item.type))
    .sort((left, right) => compareCriticalItems(left, right, statusRegistry))
    .slice(0, limit)
    .map((item) => toContextFocusItem(item, statusRegistry, childrenByParent));
}

function buildTestHealth(
  activeItems: ItemFrontMatter[],
): TestHealthSummary {
  let itemsWithTests = 0;
  let itemsWithRecentRuns = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const itemsFailing: string[] = [];

  for (const item of activeItems) {
    if ((item.tests ?? []).length > 0) {
      itemsWithTests++;
    }
    const runs = item.test_runs ?? [];
    if (runs.length > 0) {
      itemsWithRecentRuns++;
      let itemHasFailure = false;
      for (const run of runs) {
        passed += run.passed ?? 0;
        failed += run.failed ?? 0;
        skipped += run.skipped ?? 0;
        if ((run.failed ?? 0) > 0) {
          itemHasFailure = true;
        }
      }
      if (itemHasFailure) {
        itemsFailing.push(item.id);
      }
    }
  }

  return {
    items_with_tests: itemsWithTests,
    items_with_recent_runs: itemsWithRecentRuns,
    recent_runs: { passed, failed, skipped },
    items_failing: itemsFailing.sort(),
  };
}

// ---------------------------------------------------------------------------
// Markdown formatting
// ---------------------------------------------------------------------------

function formatClock(timestamp: string): string {
  return `${new Date(timestamp).toISOString().slice(11, 16)}Z`;
}

function formatFocusLine(item: ContextFocusItem): string {
  const orderToken = item.order === null ? "-" : String(item.order);
  const deadlineToken = item.deadline ?? "-";
  const parentToken = item.parent ? ` parent:${item.parent}` : "";
  const progressToken =
    item.children_total !== undefined && item.children_closed !== undefined && item.completion_pct !== undefined
      ? ` children:${item.children_closed}/${item.children_total} done:${item.completion_pct}%`
      : "";
  return `${item.id} p${item.priority} ${item.status} ${item.type} order:${orderToken} deadline:${deadlineToken}${parentToken}${progressToken} ${item.title}`;
}

function formatAgendaLine(event: CalendarRow): string {
  const base = `${formatClock(event.at)} [${event.kind}] ${event.item_id} p${event.item_priority} ${event.item_status} ${event.item_title}`;
  if (event.kind === "reminder") {
    return `${base} — ${event.reminder_text}`;
  }
  if (event.kind === "event") {
    const recurringSuffix = event.event_recurring ? " (recurring)" : "";
    const title = event.event_title ?? event.item_title;
    return `${base} — ${title}${recurringSuffix}`;
  }
  return base;
}

export function renderContextMarkdown(result: ContextResult): string {
  const lines: string[] = [];
  lines.push("# pm context");
  lines.push("");
  lines.push(`- now: ${result.now}`);
  lines.push(`- depth: ${result.depth}`);
  lines.push(`- active_items: ${result.summary.active_items} (in_progress: ${result.summary.in_progress}, open: ${result.summary.open})`);
  if (result.summary.total_items !== undefined) {
    lines.push(`- total_items: ${result.summary.total_items} (closed: ${result.summary.closed ?? 0}, canceled: ${result.summary.canceled ?? 0})`);
  }
  lines.push(`- agenda_events: ${result.summary.agenda_events}`);
  lines.push(`- blocked_fallback_used: ${result.summary.blocked_fallback_used}`);
  if (result.sections_included.length > 0) {
    lines.push(`- sections: ${result.sections_included.join(", ")}`);
  }
  lines.push("");

  lines.push("## High-level focus");
  if (result.high_level.length === 0) {
    lines.push("No high-level active items.");
  } else {
    for (const item of result.high_level) {
      lines.push(`- ${formatFocusLine(item)}`);
    }
  }
  lines.push("");

  lines.push("## Low-level focus");
  if (result.low_level.length === 0) {
    lines.push("No low-level active items.");
  } else {
    for (const item of result.low_level) {
      lines.push(`- ${formatFocusLine(item)}`);
    }
  }
  lines.push("");

  if (result.blocked_fallback.length > 0) {
    lines.push("## Blocked fallback");
    for (const item of result.blocked_fallback) {
      lines.push(`- ${formatFocusLine(item)}`);
    }
    lines.push("");
  }

  lines.push("## Agenda");
  lines.push(
    `- events: ${result.agenda.summary.events} (deadlines: ${result.agenda.summary.deadlines}, reminders: ${result.agenda.summary.reminders}, scheduled: ${result.agenda.summary.scheduled})`,
  );
  if (result.agenda.events.length === 0) {
    lines.push("No agenda events matched the selected filters.");
  } else {
    for (const event of result.agenda.events) {
      lines.push(`- ${formatAgendaLine(event)}`);
    }
  }
  lines.push("");

  if (result.hierarchy && result.hierarchy.length > 0) {
    lines.push("## Hierarchy");
    for (const node of result.hierarchy) {
      const pct = node.children_total > 0 ? Math.round((node.children_closed / node.children_total) * 100) : 0;
      lines.push(`- ${node.id} ${node.type} ${node.status} "${node.title}" [${node.children_closed}/${node.children_total} done ${pct}%]`);
      for (const child of node.children) {
        const cpct = child.children_total > 0 ? Math.round((child.children_closed / child.children_total) * 100) : 0;
        lines.push(`  - ${child.id} ${child.type} ${child.status} "${child.title}" [${child.children_closed}/${child.children_total} done ${cpct}%]`);
      }
    }
    lines.push("");
  }

  if (result.progress && result.progress.length > 0) {
    lines.push("## Progress");
    for (const entry of result.progress) {
      lines.push(`- ${entry.id} "${entry.title}" ${entry.completion_pct}% (${entry.closed}/${entry.total} closed, ${entry.in_progress} wip, ${entry.open} open, ${entry.blocked} blocked)`);
    }
    lines.push("");
  }

  if (result.recently_created && result.recently_created.length > 0) {
    lines.push("## Recently created");
    for (const item of result.recently_created) {
      lines.push(`- ${dateTokenForTimestamp(item.created_at)} ${formatFocusLine(item)}`);
    }
    lines.push("");
  }

  if (result.unparented && result.unparented.length > 0) {
    lines.push("## Unparented");
    for (const item of result.unparented) {
      lines.push(`- ${formatFocusLine(item)}`);
    }
    lines.push("");
  }

  if (result.activity && result.activity.length > 0) {
    lines.push("## Recent activity");
    for (const entry of result.activity) {
      const msg = entry.msg ? ` ${entry.msg}` : "";
      lines.push(`- ${entry.ts.slice(0, 16)}Z ${entry.id} ${entry.op} by:${entry.author}${msg}`);
    }
    lines.push("");
  }

  if (result.blockers && result.blockers.length > 0) {
    lines.push("## Blockers");
    for (const entry of result.blockers) {
      const by = entry.blocked_by ? `blocked_by:${entry.blocked_by}(${entry.blocked_by_status ?? "?"})` : "blocked_by:-";
      const reason = entry.blocked_reason ? ` reason:"${entry.blocked_reason}"` : "";
      const note = entry.unblock_note ? ` unblock:"${entry.unblock_note}"` : "";
      lines.push(`- ${entry.id} "${entry.title}" ${by}${reason}${note}`);
    }
    lines.push("");
  }

  if (result.files && result.files.length > 0) {
    lines.push("## Hot files");
    for (const file of result.files) {
      lines.push(`- ${file.path} refs:${file.references} items:[${file.items.join(",")}]`);
    }
    lines.push("");
  }

  if (result.workload && result.workload.length > 0) {
    lines.push("## Workload");
    for (const entry of result.workload) {
      const who = entry.assignee ?? "(unassigned)";
      lines.push(`- ${who} active:${entry.active} wip:${entry.in_progress} items:[${entry.items.join(",")}]`);
    }
    lines.push("");
  }

  if (result.staleness && result.staleness.length > 0) {
    lines.push("## Stale items");
    for (const entry of result.staleness) {
      lines.push(`- ${entry.id} ${entry.status} stale:${entry.stale_days}d last:${entry.updated_at.slice(0, 10)} "${entry.title}"`);
    }
    lines.push("");
  }

  if (result.tests) {
    lines.push("## Test health");
    lines.push(`- items_with_tests: ${result.tests.items_with_tests}`);
    lines.push(`- items_with_recent_runs: ${result.tests.items_with_recent_runs}`);
    lines.push(`- passed: ${result.tests.recent_runs.passed}, failed: ${result.tests.recent_runs.failed}, skipped: ${result.tests.recent_runs.skipped}`);
    if (result.tests.items_failing.length > 0) {
      lines.push(`- items_failing: [${result.tests.items_failing.join(",")}]`);
    }
    lines.push("");
  }

  const isEmpty =
    result.summary.active_items === 0 &&
    result.summary.blocked === 0 &&
    result.agenda.summary.events === 0;
  if (isEmpty) {
    lines.push("## Suggestions");
    lines.push("No active work items or upcoming events. Consider:");
    lines.push("- `pm create --type Task --title \"...\"` to add a new work item");
    lines.push("- `pm list --status closed --limit 5` to review recent completions");
    lines.push("- `pm search <keywords>` to find related past work");
    lines.push("- `pm aggregate` for a full project status overview");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

export async function runContext(options: ContextOptions, global: GlobalOptions): Promise<ContextResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  const settings = await readSettings(pmRoot);
  const contextSettings = settings.context ?? SETTINGS_DEFAULTS.context;
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const limit = parseContextLimit(options.limit);

  const depth = parseContextDepth(options.depth, contextSettings);
  const sectionsIncluded = parseContextSections(options.section, depth, contextSettings);
  const activityLimit = parseActivityLimit(options.activityLimit, contextSettings);
  const staleThresholdDays = parseStaleThresholdDays(options.staleThreshold, contextSettings);

  const needsAllItems = sectionsIncluded.some((s) =>
    ["hierarchy", "progress", "blockers", "staleness", "recently_created", "unparented"].includes(s),
  );

  const baseListOptions = stripListProjectionFlags(options);
  const listOptions: ListOptions = { ...baseListOptions, excludeTerminal: true };
  const listed = await runList(undefined, listOptions, global);
  const listedFrontMatter = listed.items as ItemFrontMatter[];

  let allItems: ItemFrontMatter[] = listedFrontMatter;
  if (needsAllItems) {
    const allListOptions: ListOptions = { ...baseListOptions, excludeTerminal: false };
    const allListed = await runList(undefined, allListOptions, global);
    allItems = allListed.items as ItemFrontMatter[];
  }

  const ranked = [...listedFrontMatter].sort((left, right) => compareCriticalItems(left, right, statusRegistry));
  const activeStatuses =
    statusRegistry.active_statuses.size > 0
      ? statusRegistry.active_statuses
      : new Set<ItemStatus>([statusRegistry.open_status]);
  const blockedStatuses = statusRegistry.blocked_statuses;
  const activeItems = ranked.filter((item) => activeStatuses.has(normalizeStatusForRegistry(item.status, statusRegistry)));
  const blockedItems = ranked.filter((item) =>
    blockedStatuses.has(normalizeStatusForRegistry(item.status, statusRegistry)),
  );

  const childrenByParent = buildChildrenByParent(allItems);
  const focusChildrenByParent = needsAllItems ? childrenByParent : undefined;

  const highLevel = activeItems
    .filter((item) => HIGH_LEVEL_TYPES.has(item.type))
    .slice(0, limit)
    .map((item) => toContextFocusItem(item, statusRegistry, focusChildrenByParent));
  const lowLevel = activeItems
    .filter((item) => !HIGH_LEVEL_TYPES.has(item.type))
    .slice(0, limit)
    .map((item) => toContextFocusItem(item, statusRegistry, focusChildrenByParent));

  const blockedFallbackUsed = activeItems.length === 0;
  const blockedFallback = blockedFallbackUsed
    ? blockedItems.slice(0, limit).map((item) => toContextFocusItem(item, statusRegistry, focusChildrenByParent))
    : [];

  const calendarOptions: CalendarOptions = {
    ...baseListOptions,
    view: "agenda",
    include: "all",
    limit: String(limit),
  };
  const agenda = await runCalendar(calendarOptions, global);
  const agendaEvents = filterTerminalCalendarEvents(agenda.events, statusRegistry).slice(0, limit);
  const agendaSummary = summarizeAgenda(agendaEvents);
  const warnings = [...new Set([...(listed.warnings ?? []), ...(agenda.warnings ?? [])])].sort((left, right) =>
    left.localeCompare(right),
  );

  const inProgressStatus = normalizeStatusInput("in_progress", statusRegistry);
  const openStatus = normalizeStatusInput("open", statusRegistry) ?? statusRegistry.open_status;
  const inProgressCount = inProgressStatus
    ? activeItems.filter((item) => normalizeStatusForRegistry(item.status, statusRegistry) === inProgressStatus).length
    : 0;
  const openCount = activeItems.filter((item) => normalizeStatusForRegistry(item.status, statusRegistry) === openStatus).length;

  const now = agenda.now;

  const itemMap = new Map<string, ItemFrontMatter>();
  for (const item of allItems) {
    itemMap.set(item.id, item);
  }

  const allNonTerminal = allItems.filter((item) => !isTerminalStatus(item.status, statusRegistry));

  const has = (section: ContextSectionName) => sectionsIncluded.includes(section);

  const hierarchy = has("hierarchy") ? buildHierarchy(allItems, activeItems, statusRegistry, limit) : undefined;
  const activity = has("activity") ? await buildActivity(activityLimit, global) : undefined;
  const progress = has("progress") ? buildProgress(allItems, activeItems, statusRegistry, limit) : undefined;
  const blockersSection = has("blockers") ? buildBlockers(blockedItems, itemMap, limit) : undefined;
  const recentlyCreated = has("recently_created")
    ? buildRecentlyCreated(allNonTerminal, statusRegistry, childrenByParent, limit)
    : undefined;
  const unparented = has("unparented")
    ? buildUnparented(allNonTerminal, statusRegistry, childrenByParent, limit)
    : undefined;
  const filesSection = has("files") ? buildHotFiles(activeItems, limit) : undefined;
  const workload = has("workload") ? buildWorkload(activeItems, statusRegistry, limit) : undefined;
  const staleness = has("staleness") ? buildStaleness(allNonTerminal, staleThresholdDays, now, limit) : undefined;
  const tests = has("tests") ? buildTestHealth(activeItems) : undefined;

  const summaryExtras: Pick<ContextSummary, "total_items" | "closed" | "canceled"> =
    needsAllItems
      ? {
          total_items: allItems.length,
          closed: allItems.filter((i) => isClosedStatus(i.status, statusRegistry)).length,
          canceled: allItems.filter((i) => {
            const canceledStatus = normalizeStatusInput("canceled", statusRegistry);
            return canceledStatus ? normalizeStatusForRegistry(i.status, statusRegistry) === canceledStatus : false;
          }).length,
        }
      : {};

  const result: ContextResult = {
    output_default: "toon",
    now,
    depth,
    sections_included: sectionsIncluded,
    window: {
      anchor: agenda.anchor,
      start: agenda.range.start,
      end: agenda.range.end,
      past: agenda.range.past,
      from: agenda.range.from,
      to: agenda.range.to,
    },
    filters: {
      type: options.type ?? null,
      tag: options.tag ?? null,
      priority: options.priority ?? null,
      assignee: options.assignee ?? null,
      assignee_filter: options.assigneeFilter ?? null,
      sprint: options.sprint ?? null,
      release: options.release ?? null,
      limit: options.limit ?? null,
      runtime_filters: (listed.filters.runtime_filters ?? agenda.filters.runtime_filters ?? {}) as Record<string, unknown>,
    },
    summary: {
      active_items: activeItems.length,
      in_progress: inProgressCount,
      open: openCount,
      blocked: blockedItems.length,
      blocked_fallback_used: blockedFallbackUsed,
      high_level: highLevel.length,
      low_level: lowLevel.length,
      agenda_events: agendaSummary.events,
      ...summaryExtras,
    },
    high_level: highLevel,
    low_level: lowLevel,
    blocked_fallback: blockedFallback,
    agenda: {
      summary: agendaSummary,
      events: agendaEvents,
    },
  };

  if (hierarchy) result.hierarchy = hierarchy;
  if (activity) result.activity = activity;
  if (progress) result.progress = progress;
  if (blockersSection) result.blockers = blockersSection;
  if (recentlyCreated) result.recently_created = recentlyCreated;
  if (unparented) result.unparented = unparented;
  if (filesSection) result.files = filesSection;
  if (workload) result.workload = workload;
  if (staleness) result.staleness = staleness;
  if (tests) result.tests = tests;
  if (warnings.length > 0) result.warnings = warnings;
  if (activeItems.length === 0 && blockedItems.length === 0 && agendaEvents.length === 0) {
    result.suggestions = [
      'pm create --type Task --title "..." to add a new work item',
      "pm list --status closed --limit 5 to review recent completions",
      "pm search <keywords> to find related past work",
      "pm aggregate for a full project status overview",
    ];
  }

  return result;
}
