import { pathExists } from "../../core/fs/fs-utils.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { compareTimestampStrings, nowIso, resolveIsoOrRelative } from "../../core/shared/time.js";
import { listAllFrontMatter } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type { ItemFrontMatter, ItemStatus, ItemType } from "../../types/index.js";
import { ITEM_TYPE_VALUES, STATUS_VALUES } from "../../types/index.js";

export const CALENDAR_VIEW_VALUES = ["agenda", "day", "week", "month"] as const;
export type CalendarView = (typeof CALENDAR_VIEW_VALUES)[number];

export const CALENDAR_OUTPUT_VALUES = ["markdown", "toon", "json"] as const;
export type CalendarOutputFormat = (typeof CALENDAR_OUTPUT_VALUES)[number];

export interface CalendarOptions {
  view?: string;
  date?: string;
  from?: string;
  to?: string;
  past?: boolean;
  limit?: string;
  type?: string;
  tag?: string;
  priority?: string;
  status?: string;
  assignee?: string;
  sprint?: string;
  release?: string;
  format?: string;
}

export interface CalendarEvent {
  at: string;
  date: string;
  kind: "deadline" | "reminder";
  reminder_text: string | null;
  item_id: string;
  item_title: string;
  item_type: ItemType;
  item_status: ItemStatus;
  item_priority: number;
  item_assignee: string | null;
  item_deadline: string | null;
  item_tags: string[];
}

export interface CalendarDayBucket {
  date: string;
  count: number;
  events: CalendarEvent[];
}

export interface CalendarResult {
  view: CalendarView;
  output_default: "markdown";
  now: string;
  anchor: string;
  range: {
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
    status: string | null;
    assignee: string | null;
    sprint: string | null;
    release: string | null;
    limit: string | null;
  };
  summary: {
    events: number;
    items: number;
    deadlines: number;
    reminders: number;
  };
  events: CalendarEvent[];
  days: CalendarDayBucket[];
}

const ITEM_TYPES_BY_LOWER = new Map<string, ItemType>(ITEM_TYPE_VALUES.map((value) => [value.toLowerCase(), value]));

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new PmCliError("Calendar limit must be a non-negative integer", EXIT_CODE.USAGE);
  }
  return parsed;
}

function parseView(raw: string | undefined): CalendarView {
  if (!raw) return "agenda";
  const normalized = raw.trim().toLowerCase();
  if (!CALENDAR_VIEW_VALUES.includes(normalized as CalendarView)) {
    throw new PmCliError("Calendar view must be one of agenda|day|week|month", EXIT_CODE.USAGE);
  }
  return normalized as CalendarView;
}

function parseOutputFormat(raw: string | undefined): CalendarOutputFormat | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (!CALENDAR_OUTPUT_VALUES.includes(normalized as CalendarOutputFormat)) {
    throw new PmCliError("Calendar format must be one of markdown|toon|json", EXIT_CODE.USAGE);
  }
  return normalized as CalendarOutputFormat;
}

export function resolveCalendarOutputFormat(options: CalendarOptions, global: GlobalOptions): CalendarOutputFormat {
  const commandFormat = parseOutputFormat(options.format);
  if (global.json && commandFormat && commandFormat !== "json") {
    throw new PmCliError("Cannot combine --json with --format markdown|toon", EXIT_CODE.USAGE);
  }
  if (global.json) {
    return "json";
  }
  return commandFormat ?? "markdown";
}

function parsePriority(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 4) {
    throw new PmCliError("Calendar priority filter must be 0..4", EXIT_CODE.USAGE);
  }
  return parsed;
}

function parseType(raw: string | undefined): ItemType | undefined {
  if (raw === undefined) return undefined;
  const parsed = ITEM_TYPES_BY_LOWER.get(raw.trim().toLowerCase());
  if (!parsed) {
    throw new PmCliError("Calendar type filter must be one of Epic|Feature|Task|Chore|Issue", EXIT_CODE.USAGE);
  }
  return parsed;
}

function parseStatus(raw: string | undefined): ItemStatus | undefined {
  if (raw === undefined) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (!STATUS_VALUES.includes(normalized as ItemStatus)) {
    throw new PmCliError(`Calendar status filter must be one of ${STATUS_VALUES.join("|")}`, EXIT_CODE.USAGE);
  }
  return normalized as ItemStatus;
}

function toUtcDayKey(timestamp: string): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function startOfUtcDay(timestamp: string): string {
  const date = new Date(timestamp);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0)).toISOString();
}

function addUtcDays(timestamp: string, days: number): string {
  const date = new Date(timestamp);
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

function startOfUtcWeekMonday(timestamp: string): string {
  const base = new Date(startOfUtcDay(timestamp));
  const day = base.getUTCDay();
  const delta = day === 0 ? -6 : 1 - day;
  return addUtcDays(base.toISOString(), delta);
}

function startOfUtcMonth(timestamp: string): string {
  const date = new Date(timestamp);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0)).toISOString();
}

function startOfNextUtcMonth(timestamp: string): string {
  const date = new Date(timestamp);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1, 0, 0, 0, 0)).toISOString();
}

function maxTimestamp(left: string, right: string): string {
  return compareTimestampStrings(left, right) >= 0 ? left : right;
}

function sortEvents(values: CalendarEvent[]): CalendarEvent[] {
  return [...values].sort((a, b) => {
    const byAt = compareTimestampStrings(a.at, b.at);
    if (byAt !== 0) return byAt;
    const byPriority = a.item_priority - b.item_priority;
    if (byPriority !== 0) return byPriority;
    const byId = a.item_id.localeCompare(b.item_id);
    if (byId !== 0) return byId;
    const byKind = a.kind.localeCompare(b.kind);
    if (byKind !== 0) return byKind;
    return String(a.reminder_text).localeCompare(String(b.reminder_text));
  });
}

function buildEventSeed(items: ItemFrontMatter[]): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  for (const item of items) {
    if (item.deadline) {
      events.push({
        at: item.deadline,
        date: toUtcDayKey(item.deadline),
        kind: "deadline",
        reminder_text: null,
        item_id: item.id,
        item_title: item.title,
        item_type: item.type,
        item_status: item.status,
        item_priority: item.priority,
        item_assignee: item.assignee ?? null,
        item_deadline: item.deadline,
        item_tags: item.tags,
      });
    }
    for (const reminder of item.reminders ?? []) {
      events.push({
        at: reminder.at,
        date: toUtcDayKey(reminder.at),
        kind: "reminder",
        reminder_text: reminder.text,
        item_id: item.id,
        item_title: item.title,
        item_type: item.type,
        item_status: item.status,
        item_priority: item.priority,
        item_assignee: item.assignee ?? null,
        item_deadline: item.deadline ?? null,
        item_tags: item.tags,
      });
    }
  }
  return sortEvents(events);
}

function filterItems(items: ItemFrontMatter[], options: CalendarOptions): ItemFrontMatter[] {
  const typeFilter = parseType(options.type);
  const tagFilter = options.tag?.trim().toLowerCase();
  const priorityFilter = parsePriority(options.priority);
  const statusFilter = parseStatus(options.status);
  const assigneeFilter = options.assignee?.trim();
  const sprintFilter = options.sprint?.trim();
  const releaseFilter = options.release?.trim();

  return items.filter((item) => {
    if (typeFilter && item.type !== typeFilter) return false;
    if (tagFilter && !item.tags.includes(tagFilter)) return false;
    if (priorityFilter !== undefined && item.priority !== priorityFilter) return false;
    if (statusFilter && item.status !== statusFilter) return false;
    if (assigneeFilter !== undefined) {
      if (assigneeFilter.toLowerCase() === "none") {
        if (item.assignee) return false;
      } else if (item.assignee !== assigneeFilter) {
        return false;
      }
    }
    if (sprintFilter !== undefined && item.sprint !== sprintFilter) return false;
    if (releaseFilter !== undefined && item.release !== releaseFilter) return false;
    return true;
  });
}

function includeEventInWindow(event: CalendarEvent, start: string | undefined, end: string | undefined): boolean {
  if (start && compareTimestampStrings(event.at, start) < 0) {
    return false;
  }
  if (end && compareTimestampStrings(event.at, end) >= 0) {
    return false;
  }
  return true;
}

function buildRange(view: CalendarView, options: CalendarOptions, nowValue: string): { anchor: string; start?: string; end?: string } {
  const anchor = options.date ? resolveIsoOrRelative(options.date, new Date(nowValue)) : nowValue;
  const includePast = options.past === true;

  const from = options.from ? resolveIsoOrRelative(options.from, new Date(nowValue)) : undefined;
  const to = options.to ? resolveIsoOrRelative(options.to, new Date(nowValue)) : undefined;
  if (from && to && compareTimestampStrings(from, to) >= 0) {
    throw new PmCliError("Calendar --from must be before --to", EXIT_CODE.USAGE);
  }

  if (view !== "agenda" && (options.from !== undefined || options.to !== undefined)) {
    throw new PmCliError("--from and --to are only supported for --view agenda", EXIT_CODE.USAGE);
  }

  if (view === "agenda") {
    const start = from ?? (options.date ? anchor : includePast ? undefined : nowValue);
    return {
      anchor,
      start,
      end: to,
    };
  }

  if (view === "day") {
    const dayStart = startOfUtcDay(anchor);
    const start = includePast ? dayStart : maxTimestamp(dayStart, nowValue);
    return {
      anchor,
      start,
      end: addUtcDays(dayStart, 1),
    };
  }

  if (view === "week") {
    const weekStart = startOfUtcWeekMonday(anchor);
    const start = includePast ? weekStart : maxTimestamp(weekStart, nowValue);
    return {
      anchor,
      start,
      end: addUtcDays(weekStart, 7),
    };
  }

  const monthStart = startOfUtcMonth(anchor);
  const start = includePast ? monthStart : maxTimestamp(monthStart, nowValue);
  return {
    anchor,
    start,
    end: startOfNextUtcMonth(anchor),
  };
}

function bucketEventsByDay(events: CalendarEvent[]): CalendarDayBucket[] {
  const dayMap = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    const list = dayMap.get(event.date) ?? [];
    list.push(event);
    dayMap.set(event.date, list);
  }
  return [...dayMap.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, dayEvents]) => ({
      date,
      count: dayEvents.length,
      events: sortEvents(dayEvents),
    }));
}

function summarize(events: CalendarEvent[]): CalendarResult["summary"] {
  const itemIds = new Set<string>();
  let deadlines = 0;
  let reminders = 0;
  for (const event of events) {
    itemIds.add(event.item_id);
    if (event.kind === "deadline") {
      deadlines += 1;
    } else {
      reminders += 1;
    }
  }
  return {
    events: events.length,
    items: itemIds.size,
    deadlines,
    reminders,
  };
}

function formatWindow(range: CalendarResult["range"]): string {
  const start = range.start ?? "none";
  const end = range.end ?? "none";
  return `${start} -> ${end}`;
}

function formatClock(timestamp: string): string {
  return `${new Date(timestamp).toISOString().slice(11, 16)}Z`;
}

function formatEventLine(event: CalendarEvent): string {
  const core = `${formatClock(event.at)} [${event.kind}] ${event.item_id} p${event.item_priority} ${event.item_status} ${event.item_title}`;
  if (event.kind === "reminder") {
    return `${core} — ${event.reminder_text}`;
  }
  return core;
}

export function renderCalendarMarkdown(result: CalendarResult): string {
  const lines: string[] = [];
  lines.push(`# pm calendar (${result.view})`);
  lines.push("");
  lines.push(`- now: ${result.now}`);
  lines.push(`- window: ${formatWindow(result.range)}`);
  lines.push(`- events: ${result.summary.events} (deadlines: ${result.summary.deadlines}, reminders: ${result.summary.reminders})`);
  lines.push(`- items: ${result.summary.items}`);
  lines.push("");

  if (result.events.length === 0) {
    lines.push("No calendar events matched the selected filters.");
    return lines.join("\n");
  }

  for (const day of result.days) {
    lines.push(`## ${day.date} (${day.count})`);
    for (const event of day.events) {
      lines.push(`- ${formatEventLine(event)}`);
    }
    lines.push("");
  }
  return lines.join("\n").replace(/\n+$/, "");
}

export async function runCalendar(options: CalendarOptions, global: GlobalOptions): Promise<CalendarResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }

  const nowValue = nowIso();
  const view = parseView(options.view);
  const rangeBounds = buildRange(view, options, nowValue);
  const limit = parseLimit(options.limit);

  const settings = await readSettings(pmRoot);
  const items = await listAllFrontMatter(pmRoot, settings.item_format);
  const filteredItems = filterItems(items, options);
  const seededEvents = buildEventSeed(filteredItems);
  const rangedEvents = seededEvents.filter((event) => includeEventInWindow(event, rangeBounds.start, rangeBounds.end));
  const limitedEvents = limit === undefined ? rangedEvents : rangedEvents.slice(0, limit);
  const days = bucketEventsByDay(limitedEvents);

  return {
    view,
    output_default: "markdown",
    now: nowValue,
    anchor: rangeBounds.anchor,
    range: {
      start: rangeBounds.start ?? null,
      end: rangeBounds.end ?? null,
      past: options.past === true,
      from: options.from ?? null,
      to: options.to ?? null,
    },
    filters: {
      type: options.type ?? null,
      tag: options.tag ?? null,
      priority: options.priority ?? null,
      status: options.status ?? null,
      assignee: options.assignee ?? null,
      sprint: options.sprint ?? null,
      release: options.release ?? null,
      limit: options.limit ?? null,
    },
    summary: summarize(limitedEvents),
    events: limitedEvents,
    days,
  };
}
