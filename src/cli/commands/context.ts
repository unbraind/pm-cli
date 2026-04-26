import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { compareTimestampStrings } from "../../core/shared/time.js";
import { normalizeStatusInput } from "../../core/item/status.js";
import { resolveRuntimeStatusRegistry, type RuntimeStatusRegistry } from "../../core/schema/runtime-schema.js";
import { resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type { ItemFrontMatter, ItemStatus } from "../../types/index.js";
import { runCalendar, type CalendarOptions, type CalendarRow } from "./calendar.js";
import { runList, type ListOptions } from "./list.js";

export const CONTEXT_OUTPUT_VALUES = ["markdown", "toon", "json"] as const;
export type ContextOutputFormat = (typeof CONTEXT_OUTPUT_VALUES)[number];

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
  [key: string]: unknown;
}

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
}

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
}

export interface ContextResult {
  output_default: "toon";
  now: string;
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
  warnings?: string[];
}

const HIGH_LEVEL_TYPES = new Set<string>(["Epic", "Feature"]);
const DEFAULT_CONTEXT_LIMIT = 10;

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

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_CONTEXT_LIMIT;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new PmCliError("Context limit must be a non-negative integer", EXIT_CODE.USAGE);
  }
  return parsed;
}

function normalizeStatusForRegistry(status: ItemStatus, statusRegistry: RuntimeStatusRegistry): ItemStatus {
  return normalizeStatusInput(status, statusRegistry) ?? status;
}

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

function compareCriticalItems(left: ItemFrontMatter, right: ItemFrontMatter, statusRegistry: RuntimeStatusRegistry): number {
  const byStatus = statusRank(left.status, statusRegistry) - statusRank(right.status, statusRegistry);
  if (byStatus !== 0) return byStatus;
  const byPriority = left.priority - right.priority;
  if (byPriority !== 0) return byPriority;
  const byOrder = compareOptionalOrder(left.order, right.order);
  if (byOrder !== 0) return byOrder;
  const byDeadline = compareOptionalDeadline(left.deadline, right.deadline);
  if (byDeadline !== 0) return byDeadline;
  const byUpdated = compareTimestampStrings(right.updated_at, left.updated_at);
  const byId = left.id.localeCompare(right.id);
  return byUpdated !== 0 ? byUpdated : byId;
}

function toContextFocusItem(item: ItemFrontMatter): ContextFocusItem {
  return {
    id: item.id,
    title: item.title,
    type: item.type,
    status: item.status,
    priority: item.priority,
    order: item.order ?? null,
    deadline: item.deadline ?? null,
    assignee: item.assignee ?? null,
    tags: [...item.tags],
    updated_at: item.updated_at,
  };
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

function formatClock(timestamp: string): string {
  return `${new Date(timestamp).toISOString().slice(11, 16)}Z`;
}

function formatFocusLine(item: ContextFocusItem): string {
  const orderToken = item.order === null ? "-" : String(item.order);
  const deadlineToken = item.deadline ?? "-";
  return `${item.id} p${item.priority} ${item.status} ${item.type} order:${orderToken} deadline:${deadlineToken} ${item.title}`;
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
  lines.push(`- active_items: ${result.summary.active_items} (in_progress: ${result.summary.in_progress}, open: ${result.summary.open})`);
  lines.push(`- agenda_events: ${result.summary.agenda_events}`);
  lines.push(`- blocked_fallback_used: ${result.summary.blocked_fallback_used}`);
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
  return lines.join("\n");
}

export async function runContext(options: ContextOptions, global: GlobalOptions): Promise<ContextResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  const settings = await readSettings(pmRoot);
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const limit = parseLimit(options.limit);
  const listOptions: ListOptions = { ...(options as Record<string, unknown>), excludeTerminal: true };
  const listed = await runList(undefined, listOptions, global);
  const listedFrontMatter = listed.items as ItemFrontMatter[];
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

  const highLevel = activeItems
    .filter((item) => HIGH_LEVEL_TYPES.has(item.type))
    .slice(0, limit)
    .map(toContextFocusItem);
  const lowLevel = activeItems
    .filter((item) => !HIGH_LEVEL_TYPES.has(item.type))
    .slice(0, limit)
    .map(toContextFocusItem);

  const blockedFallbackUsed = activeItems.length === 0;
  const blockedFallback = blockedFallbackUsed ? blockedItems.slice(0, limit).map(toContextFocusItem) : [];

  const calendarOptions: CalendarOptions = {
    ...(options as Record<string, unknown>),
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

  return {
    output_default: "toon",
    now: agenda.now,
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
    },
    high_level: highLevel,
    low_level: lowLevel,
    blocked_fallback: blockedFallback,
    agenda: {
      summary: agendaSummary,
      events: agendaEvents,
    },
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
