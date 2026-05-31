import { encode as encodeToon } from "@toon-format/toon";
import { pathExists } from "../../core/fs/fs-utils.js";
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { resolveItemTypeRegistry, type ItemTypeRegistry } from "../../core/item/type-registry.js";
import { parseIntegerLimit, parsePriority, parseType } from "../shared-parsers.js";
import { normalizeStatusInput } from "../../core/item/status.js";
import { collectRuntimeFilterValues, matchesRuntimeFilters } from "../../core/schema/runtime-field-filters.js";
import {
  resolveRuntimeFieldRegistry,
  resolveRuntimeStatusRegistry,
  type RuntimeStatusRegistry,
} from "../../core/schema/runtime-schema.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { levenshteinDistanceWithinLimit } from "../../core/shared/levenshtein.js";
import { compareTimestampStrings, nowIso, resolveIsoOrRelative } from "../../core/shared/time.js";
import { listAllFrontMatterLight } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type { ItemFrontMatter, ItemStatus, ItemType, RecurrenceRule } from "../../types/index.js";
import { RECURRENCE_WEEKDAY_VALUES, weekdayOrderIndex } from "../../types/index.js";

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
  fullPeriod?: boolean;
  limit?: string;
  type?: string;
  tag?: string;
  priority?: string;
  status?: string;
  assignee?: string;
  assigneeFilter?: string;
  sprint?: string;
  release?: string;
  include?: string;
  recurrenceLookaheadDays?: string;
  recurrenceLookbackDays?: string;
  occurrenceLimit?: string;
  format?: string;
  [key: string]: unknown;
}

export interface CalendarRow {
  at: string;
  date: string;
  kind: "deadline" | "reminder" | "event";
  reminder_text: string | null;
  event_title: string | null;
  event_end: string | null;
  event_location: string | null;
  event_all_day: boolean | null;
  event_timezone: string | null;
  event_recurring: boolean | null;
  event_recurrence_rule: string | null;
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
  events: CalendarRow[];
}

export interface CalendarResult {
  view: CalendarView;
  output_default: "markdown";
  now: string;
  anchor: string;
  range: {
    start: string | null;
    end: string | null;
    period_start: string | null;
    period_end: string | null;
    full_period: boolean;
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
    assignee_filter: string | null;
    sprint: string | null;
    release: string | null;
    runtime_filters?: Record<string, unknown>;
    limit: string | null;
    include: string | null;
    full_period: string | null;
    recurrence_lookahead_days: string | null;
    recurrence_lookback_days: string | null;
    occurrence_limit: string | null;
  };
  summary: {
    events: number;
    items: number;
    deadlines: number;
    reminders: number;
    scheduled: number;
    by_kind: {
      deadline: number;
      reminder: number;
      event: number;
    };
    by_type: Record<string, number>;
    by_status: Record<string, number>;
    recurring_events: number;
  };
  events: CalendarRow[];
  days: CalendarDayBucket[];
  warnings?: string[];
}

const UTC_DAY_TO_WEEKDAY = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const DEFAULT_RECURRENCE_LOOKAHEAD_DAYS = 365;
const DEFAULT_RECURRENCE_LOOKBACK_DAYS = 365;
const DEFAULT_EVENTS_ONLY_LOOKAHEAD_DAYS = 28;
const MAX_RECURRENCE_OCCURRENCES = 1000;

function parseNonNegativeInteger(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new PmCliError(`${label} must be a non-negative integer`, EXIT_CODE.USAGE);
  }
  return parsed;
}

type CalendarIncludeKind = "deadlines" | "reminders" | "events";

function parseIncludeSources(raw: string | undefined): Set<CalendarIncludeKind> {
  if (!raw) {
    return new Set(["deadlines", "reminders", "events"]);
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "all") {
    return new Set(["deadlines", "reminders", "events"]);
  }
  const values = normalized
    .split(/[\|,]/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (values.length === 0) {
    throw new PmCliError("Calendar include filter must not be empty", EXIT_CODE.USAGE);
  }
  const include = new Set<CalendarIncludeKind>();
  for (const value of values) {
    if (value === "deadlines" || value === "deadline") {
      include.add("deadlines");
      continue;
    }
    if (value === "reminders" || value === "reminder") {
      include.add("reminders");
      continue;
    }
    if (value === "events" || value === "event" || value === "scheduled") {
      include.add("events");
      continue;
    }
    throw new PmCliError("Calendar include filter must be deadlines|reminders|events|scheduled|all", EXIT_CODE.USAGE);
  }
  return include;
}

/**
 * Suggest the closest valid choice for a mistyped enum value (within edit
 * distance 2) so an agent gets an actionable "did you mean" hint instead of just
 * a list of choices (never-block UX).
 */
function suggestClosestChoice(value: string, choices: readonly string[]): string | undefined {
  let best: { choice: string; distance: number } | undefined;
  for (const choice of choices) {
    const distance = levenshteinDistanceWithinLimit(value, choice, 2);
    if (distance !== null && (best === undefined || distance < best.distance)) {
      best = { choice, distance };
    }
  }
  return best?.choice;
}

function parseView(raw: string | undefined): CalendarView {
  if (!raw) return "agenda";
  const normalized = raw.trim().toLowerCase();
  if (!CALENDAR_VIEW_VALUES.includes(normalized as CalendarView)) {
    const suggestion = suggestClosestChoice(normalized, CALENDAR_VIEW_VALUES);
    throw new PmCliError(
      `Calendar view must be one of ${CALENDAR_VIEW_VALUES.join("|")}${suggestion ? `. Did you mean "${suggestion}"?` : "."}`,
      EXIT_CODE.USAGE,
    );
  }
  return normalized as CalendarView;
}

function parseOutputFormat(raw: string | undefined): CalendarOutputFormat | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (!CALENDAR_OUTPUT_VALUES.includes(normalized as CalendarOutputFormat)) {
    const suggestion = suggestClosestChoice(normalized, CALENDAR_OUTPUT_VALUES);
    throw new PmCliError(
      `Calendar format must be one of ${CALENDAR_OUTPUT_VALUES.join("|")}${suggestion ? `. Did you mean "${suggestion}"?` : "."}`,
      EXIT_CODE.USAGE,
    );
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

function parseStatus(raw: string | undefined, statusRegistry: RuntimeStatusRegistry): ItemStatus | undefined {
  if (raw === undefined) return undefined;
  const normalized = normalizeStatusInput(raw, statusRegistry);
  if (!normalized) {
    const allowedStatuses = statusRegistry.definitions.map((definition) => definition.id);
    throw new PmCliError(`Calendar status filter must be one of ${allowedStatuses.join("|")}`, EXIT_CODE.USAGE);
  }
  return normalized;
}

function parseAssigneeFilter(raw: string | undefined): "assigned" | "unassigned" | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    throw new PmCliError("Calendar assignee filter must be one of assigned|unassigned", EXIT_CODE.USAGE);
  }
  if (normalized !== "assigned" && normalized !== "unassigned") {
    throw new PmCliError(`Invalid calendar assignee filter "${raw}". Allowed: assigned|unassigned`, EXIT_CODE.USAGE);
  }
  return normalized;
}

function toUtcDayKey(timestamp: string): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

/**
 * Calendar day (YYYY-MM-DD) the instant falls on in the given IANA timezone.
 * Events carry an optional `timezone`; bucketing and clock rendering use it so a
 * 23:30Z instant tagged Asia/Tokyo correctly lands on the next local day rather
 * than the UTC day. Falls back to the UTC day when no/invalid timezone is given,
 * so existing UTC behavior is unchanged. Uses Intl (no timezone dependency).
 */
function toLocalDayKey(timestamp: string, timezone?: string | null): string {
  if (!timezone || timezone === "UTC") {
    return toUtcDayKey(timestamp);
  }
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(timestamp));
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    if (year && month && day) {
      return `${year}-${month}-${day}`;
    }
  } catch {
    // Invalid IANA zone — fall back to the UTC day key below.
  }
  return toUtcDayKey(timestamp);
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

function toSortedCountRecord(values: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...values.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function incrementCount(values: Map<string, number>, key: string): void {
  values.set(key, (values.get(key) ?? 0) + 1);
}

function formatRecurrenceRuleForSummary(rule: RecurrenceRule | undefined): string | null {
  if (!rule) {
    return null;
  }
  const parts: string[] = [`freq=${rule.freq}`];
  if (rule.interval !== undefined) {
    parts.push(`interval=${rule.interval}`);
  }
  if (rule.count !== undefined) {
    parts.push(`count=${rule.count}`);
  }
  if (rule.until) {
    parts.push(`until=${rule.until}`);
  }
  if (rule.by_weekday && rule.by_weekday.length > 0) {
    const weekdays = [...rule.by_weekday].sort((left, right) => weekdayOrderIndex(left) - weekdayOrderIndex(right));
    parts.push(`by_weekday=${weekdays.join("|")}`);
  }
  if (rule.by_month_day && rule.by_month_day.length > 0) {
    const monthDays = [...rule.by_month_day].sort((left, right) => left - right);
    parts.push(`by_month_day=${monthDays.join("|")}`);
  }
  if (rule.exdates && rule.exdates.length > 0) {
    const exdates = [...rule.exdates].sort((left, right) => left.localeCompare(right));
    parts.push(`exdates=${exdates.join("|")}`);
  }
  return parts.join(",");
}

function buildUtcTimestamp(year: number, month: number, day: number, timeSource: Date): string | undefined {
  const candidate = new Date(
    Date.UTC(
      year,
      month,
      day,
      timeSource.getUTCHours(),
      timeSource.getUTCMinutes(),
      timeSource.getUTCSeconds(),
      timeSource.getUTCMilliseconds(),
    ),
  );
  if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month || candidate.getUTCDate() !== day) {
    return undefined;
  }
  return candidate.toISOString();
}

function weekdayToken(timestamp: string): (typeof UTC_DAY_TO_WEEKDAY)[number] {
  return UTC_DAY_TO_WEEKDAY[new Date(timestamp).getUTCDay()];
}

function normalizeInstantKey(timestamp: string): string | null {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function buildExcludedInstantSet(exdates: readonly string[] | undefined): Set<string> {
  const excluded = new Set<string>();
  for (const exdate of exdates ?? []) {
    const instantKey = normalizeInstantKey(exdate);
    if (instantKey) {
      excluded.add(instantKey);
    }
  }
  return excluded;
}

function buildRecurringEventWindow(
  start: string | undefined,
  end: string | undefined,
  nowValue: string,
  lookbackDays: number | undefined,
  lookaheadDays: number | undefined,
): { start: string; end: string } {
  const windowStart = start ?? addUtcDays(nowValue, -(lookbackDays ?? DEFAULT_RECURRENCE_LOOKBACK_DAYS));
  const windowEnd = end ?? addUtcDays(start ?? nowValue, lookaheadDays ?? DEFAULT_RECURRENCE_LOOKAHEAD_DAYS);
  return {
    start: windowStart,
    end: compareTimestampStrings(windowEnd, windowStart) > 0 ? windowEnd : addUtcDays(windowStart, 1),
  };
}

function expandRecurringOccurrences(
  startAt: string,
  recurrence: RecurrenceRule,
  window: { start: string; end: string },
  occurrenceLimit: number | undefined,
): string[] {
  const maxOccurrences = occurrenceLimit ?? MAX_RECURRENCE_OCCURRENCES;
  const interval = recurrence.interval ?? 1;
  const countLimit = recurrence.count ?? Number.POSITIVE_INFINITY;
  const until = recurrence.until;
  const excluded = buildExcludedInstantSet(recurrence.exdates);
  const recurrenceWeekdays =
    recurrence.by_weekday && recurrence.by_weekday.length > 0 ? [...recurrence.by_weekday] : [weekdayToken(startAt)];
  const recurrenceMonthDays =
    recurrence.by_month_day && recurrence.by_month_day.length > 0 ? [...recurrence.by_month_day] : [new Date(startAt).getUTCDate()];
  const weekdayFilter = recurrence.by_weekday ? new Set(recurrence.by_weekday) : undefined;
  const monthDayFilter = recurrence.by_month_day ? new Set(recurrence.by_month_day) : undefined;
  const sortedWeekdays = [...new Set(recurrenceWeekdays)].sort(
    (left, right) =>
      weekdayOrderIndex(left as (typeof RECURRENCE_WEEKDAY_VALUES)[number]) -
      weekdayOrderIndex(right as (typeof RECURRENCE_WEEKDAY_VALUES)[number]),
  );
  const sortedMonthDays = [...new Set(recurrenceMonthDays)].sort((left, right) => left - right);

  const occurrences: string[] = [];
  let produced = 0;
  const consumeCandidate = (candidateAt: string): "continue" | "stop" => {
    if (compareTimestampStrings(candidateAt, startAt) < 0) {
      return "continue";
    }
    if (until && compareTimestampStrings(candidateAt, until) > 0) {
      return "stop";
    }
    if (compareTimestampStrings(candidateAt, window.end) >= 0) {
      return "stop";
    }
    if (excluded.has(candidateAt)) {
      return "continue";
    }
    produced += 1;
    if (compareTimestampStrings(candidateAt, window.start) >= 0) {
      occurrences.push(candidateAt);
    }
    if (produced >= countLimit) {
      return "stop";
    }
    return "continue";
  };

  const startDate = new Date(startAt);
  if (recurrence.freq === "daily") {
    let candidateAt = startAt;
    for (let iteration = 0; iteration < maxOccurrences; iteration += 1) {
      const candidateWeekday = weekdayToken(candidateAt);
      const candidateMonthDay = new Date(candidateAt).getUTCDate();
      const weekdayMatches = !weekdayFilter || weekdayFilter.has(candidateWeekday);
      const monthDayMatches = !monthDayFilter || monthDayFilter.has(candidateMonthDay);
      if (weekdayMatches && monthDayMatches && consumeCandidate(candidateAt) === "stop") {
        break;
      }
      candidateAt = addUtcDays(candidateAt, interval);
    }
    return occurrences;
  }

  if (recurrence.freq === "weekly") {
    const weekStart = startOfUtcWeekMonday(startAt);
    for (let step = 0; step < maxOccurrences; step += 1) {
      const candidateWeekStart = addUtcDays(weekStart, step * interval * 7);
      for (const weekday of sortedWeekdays) {
        const dayOffset = weekdayOrderIndex(weekday as (typeof RECURRENCE_WEEKDAY_VALUES)[number]);
        const candidateDay = addUtcDays(candidateWeekStart, dayOffset);
        const dayDate = new Date(candidateDay);
        const candidateAt = new Date(
          Date.UTC(
            dayDate.getUTCFullYear(),
            dayDate.getUTCMonth(),
            dayDate.getUTCDate(),
            startDate.getUTCHours(),
            startDate.getUTCMinutes(),
            startDate.getUTCSeconds(),
            startDate.getUTCMilliseconds(),
          ),
        ).toISOString();
        const candidateMonthDay = dayDate.getUTCDate();
        if (monthDayFilter && !monthDayFilter.has(candidateMonthDay)) {
          continue;
        }
        const consumed = consumeCandidate(candidateAt);
        if (consumed === "stop") {
          return occurrences;
        }
      }
    }
    return occurrences;
  }

  if (recurrence.freq === "monthly") {
    const startYear = startDate.getUTCFullYear();
    const startMonth = startDate.getUTCMonth();
    for (let step = 0; step < maxOccurrences; step += 1) {
      const monthAnchor = new Date(Date.UTC(startYear, startMonth + step * interval, 1, 0, 0, 0, 0));
      const year = monthAnchor.getUTCFullYear();
      const month = monthAnchor.getUTCMonth();
      for (const monthDay of sortedMonthDays) {
        const candidateAt = buildUtcTimestamp(year, month, monthDay, startDate);
        if (!candidateAt) {
          continue;
        }
        const candidateWeekday = weekdayToken(candidateAt);
        if (weekdayFilter && !weekdayFilter.has(candidateWeekday)) {
          continue;
        }
        const consumed = consumeCandidate(candidateAt);
        if (consumed === "stop") {
          return occurrences;
        }
      }
    }
    return occurrences;
  }

  const year = startDate.getUTCFullYear();
  const month = startDate.getUTCMonth();
  for (let step = 0; step < maxOccurrences; step += 1) {
    const candidateYear = year + step * interval;
    for (const monthDay of sortedMonthDays) {
      const candidateAt = buildUtcTimestamp(candidateYear, month, monthDay, startDate);
      if (!candidateAt) {
        continue;
      }
      const candidateWeekday = weekdayToken(candidateAt);
      if (weekdayFilter && !weekdayFilter.has(candidateWeekday)) {
        continue;
      }
      const consumed = consumeCandidate(candidateAt);
      if (consumed === "stop") {
        return occurrences;
      }
    }
  }

  return occurrences;
}

function sortEvents(values: CalendarRow[]): CalendarRow[] {
  return [...values].sort((a, b) => {
    const byAt = compareTimestampStrings(a.at, b.at);
    if (byAt !== 0) return byAt;
    const byPriority = a.item_priority - b.item_priority;
    if (byPriority !== 0) return byPriority;
    const byId = a.item_id.localeCompare(b.item_id);
    if (byId !== 0) return byId;
    const byKind = a.kind.localeCompare(b.kind);
    if (byKind !== 0) return byKind;
    const byEventTitle = String(a.event_title).localeCompare(String(b.event_title));
    if (byEventTitle !== 0) return byEventTitle;
    return String(a.reminder_text).localeCompare(String(b.reminder_text));
  });
}

function buildEventSeed(
  items: ItemFrontMatter[],
  recurringWindow: { start: string; end: string },
  includeSources: Set<CalendarIncludeKind>,
  occurrenceLimit: number | undefined,
): CalendarRow[] {
  const events: CalendarRow[] = [];
  for (const item of items) {
    if (includeSources.has("deadlines") && item.deadline) {
      events.push({
        at: item.deadline,
        date: toUtcDayKey(item.deadline),
        kind: "deadline",
        reminder_text: null,
        event_title: null,
        event_end: null,
        event_location: null,
        event_all_day: null,
        event_timezone: null,
        event_recurring: null,
        event_recurrence_rule: null,
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
    for (const reminder of includeSources.has("reminders") ? (item.reminders ?? []) : []) {
      events.push({
        at: reminder.at,
        date: toUtcDayKey(reminder.at),
        kind: "reminder",
        reminder_text: reminder.text,
        event_title: null,
        event_end: null,
        event_location: null,
        event_all_day: null,
        event_timezone: null,
        event_recurring: null,
        event_recurrence_rule: null,
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
    for (const event of includeSources.has("events") ? (item.events ?? []) : []) {
      const recurrenceRuleSummary = formatRecurrenceRuleForSummary(event.recurrence);
      const recurringDurationMs = (() => {
        if (!event.end_at) {
          return null;
        }
        const duration = Date.parse(event.end_at) - Date.parse(event.start_at);
        return Number.isFinite(duration) && duration > 0 ? duration : null;
      })();
      const occurrences = event.recurrence
        ? expandRecurringOccurrences(event.start_at, event.recurrence, recurringWindow, occurrenceLimit)
        : [event.start_at];
      for (const occurrenceAt of occurrences) {
        const occurrenceEnd =
          event.recurrence && recurringDurationMs !== null
            ? new Date(new Date(occurrenceAt).getTime() + recurringDurationMs).toISOString()
            : (event.end_at ?? null);
        events.push({
          at: occurrenceAt,
          // All-day events are timezone-agnostic calendar dates: bucket by the
          // literal start date. Timed events bucket by their local day in the
          // event's timezone (defaults to UTC when unset).
          date:
            event.all_day === true
              ? occurrenceAt.slice(0, 10)
              : toLocalDayKey(occurrenceAt, event.timezone),
          kind: "event",
          reminder_text: event.description ?? null,
          event_title: event.title ?? item.title,
          event_end: occurrenceEnd,
          event_location: event.location ?? null,
          event_all_day: event.all_day ?? null,
          event_timezone: event.timezone ?? null,
          event_recurring: event.recurrence ? true : false,
          event_recurrence_rule: recurrenceRuleSummary,
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
  }
  return sortEvents(events);
}

function filterItems(
  items: ItemFrontMatter[],
  options: CalendarOptions,
  typeRegistry: ItemTypeRegistry,
  statusRegistry: RuntimeStatusRegistry,
  runtimeFieldFilters: Record<string, unknown>,
): ItemFrontMatter[] {
  const typeFilter = parseType(options.type, typeRegistry);
  const tagFilter = options.tag?.trim().toLowerCase();
  const priorityFilter = parsePriority(options.priority);
  const statusFilter = parseStatus(options.status, statusRegistry);
  const assigneeFilter = options.assignee?.trim();
  const assigneeModeFilter = parseAssigneeFilter(options.assigneeFilter);
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
    if (typeFilter && item.type !== typeFilter) return false;
    if (tagFilter && !item.tags.some((tag) => tag.trim().toLowerCase() === tagFilter)) return false;
    if (priorityFilter !== undefined && item.priority !== priorityFilter) return false;
    if (statusFilter && item.status !== statusFilter) return false;
    if (assigneeModeFilter === "assigned" && !item.assignee) return false;
    if (assigneeModeFilter === "unassigned" && item.assignee) return false;
    if (assigneeFilter !== undefined && item.assignee !== assigneeFilter) {
      return false;
    }
    if (sprintFilter !== undefined && item.sprint !== sprintFilter) return false;
    if (releaseFilter !== undefined && item.release !== releaseFilter) return false;
    if (!matchesRuntimeFilters(item as Record<string, unknown>, runtimeFieldFilters)) return false;
    return true;
  });
}

function includeEventInWindow(event: CalendarRow, start: string | undefined, end: string | undefined): boolean {
  if (start && compareTimestampStrings(event.at, start) < 0) {
    return false;
  }
  if (end && compareTimestampStrings(event.at, end) >= 0) {
    return false;
  }
  return true;
}

function resolveCalendarBoundaryInput(raw: string, nowValue: string, fieldLabel: "--date" | "--from" | "--to"): string {
  if (raw.trim().toLowerCase() === "today") {
    return startOfUtcDay(nowValue);
  }
  return resolveIsoOrRelative(raw, new Date(nowValue), fieldLabel);
}

function buildRange(
  view: CalendarView,
  options: CalendarOptions,
  nowValue: string,
): {
  anchor: string;
  start?: string;
  end?: string;
  periodStart?: string;
  periodEnd?: string;
  fullPeriod: boolean;
} {
  const anchor = options.date ? resolveCalendarBoundaryInput(options.date, nowValue, "--date") : nowValue;
  const includePast = options.past === true;
  const fullPeriodRequested = options.fullPeriod === true;

  const from = options.from ? resolveCalendarBoundaryInput(options.from, nowValue, "--from") : undefined;
  const to = options.to ? resolveCalendarBoundaryInput(options.to, nowValue, "--to") : undefined;
  if (from && to && compareTimestampStrings(from, to) >= 0) {
    throw new PmCliError("Calendar --from must be before --to", EXIT_CODE.USAGE);
  }

  if (view !== "agenda" && (options.from !== undefined || options.to !== undefined)) {
    throw new PmCliError("--from and --to are only supported for --view agenda", EXIT_CODE.USAGE);
  }

  if (view === "agenda") {
    if (fullPeriodRequested) {
      throw new PmCliError(
        "--full-period is only supported for --view day|week|month. For agenda windows, use --from and --to.",
        EXIT_CODE.USAGE,
      );
    }
    const start = from ?? (options.date ? anchor : includePast ? undefined : nowValue);
    return {
      anchor,
      start,
      end: to,
      fullPeriod: false,
    };
  }

  if (view === "day") {
    const dayStart = startOfUtcDay(anchor);
    const fullPeriod = includePast || fullPeriodRequested;
    const start = fullPeriod ? dayStart : maxTimestamp(dayStart, nowValue);
    return {
      anchor,
      start,
      end: addUtcDays(dayStart, 1),
      periodStart: dayStart,
      periodEnd: addUtcDays(dayStart, 1),
      fullPeriod,
    };
  }

  if (view === "week") {
    const weekStart = startOfUtcWeekMonday(anchor);
    const fullPeriod = includePast || fullPeriodRequested;
    const start = fullPeriod ? weekStart : maxTimestamp(weekStart, nowValue);
    return {
      anchor,
      start,
      end: addUtcDays(weekStart, 7),
      periodStart: weekStart,
      periodEnd: addUtcDays(weekStart, 7),
      fullPeriod,
    };
  }

  const monthStart = startOfUtcMonth(anchor);
  const monthEnd = startOfNextUtcMonth(anchor);
  const fullPeriod = includePast || fullPeriodRequested;
  const start = fullPeriod ? monthStart : maxTimestamp(monthStart, nowValue);
  return {
    anchor,
    start,
    end: monthEnd,
    periodStart: monthStart,
    periodEnd: monthEnd,
    fullPeriod,
  };
}

function bucketEventsByDay(events: CalendarRow[]): CalendarDayBucket[] {
  const dayMap = new Map<string, CalendarRow[]>();
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

function summarize(events: CalendarRow[]): CalendarResult["summary"] {
  const itemIds = new Set<string>();
  const byType = new Map<string, number>();
  const byStatus = new Map<string, number>();
  let deadlines = 0;
  let reminders = 0;
  let scheduled = 0;
  let recurringEvents = 0;
  for (const event of events) {
    itemIds.add(event.item_id);
    incrementCount(byType, event.item_type);
    incrementCount(byStatus, event.item_status);
    if (event.kind === "deadline") {
      deadlines += 1;
    } else if (event.kind === "reminder") {
      reminders += 1;
    } else {
      scheduled += 1;
      if (event.event_recurring === true) {
        recurringEvents += 1;
      }
    }
  }
  return {
    events: events.length,
    items: itemIds.size,
    deadlines,
    reminders,
    scheduled,
    by_kind: {
      deadline: deadlines,
      reminder: reminders,
      event: scheduled,
    },
    by_type: toSortedCountRecord(byType),
    by_status: toSortedCountRecord(byStatus),
    recurring_events: recurringEvents,
  };
}

function formatWindow(range: CalendarResult["range"]): string {
  const start = range.start ?? "unbounded";
  const end = range.end ?? "unbounded";
  return `${start} -> ${end}`;
}

function formatClock(timestamp: string, timezone?: string | null): string {
  if (timezone && timezone !== "UTC") {
    try {
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).formatToParts(new Date(timestamp));
      const hour = parts.find((part) => part.type === "hour")?.value;
      const minute = parts.find((part) => part.type === "minute")?.value;
      if (hour && minute) {
        // Local wall-clock time; the event line already prints `timezone=<zone>`.
        return `${hour}:${minute}`;
      }
    } catch {
      // Invalid IANA zone — fall back to the UTC clock below.
    }
  }
  return `${new Date(timestamp).toISOString().slice(11, 16)}Z`;
}

function formatSummaryCountRecord(values: Record<string, number>): string {
  const entries = Object.entries(values);
  if (entries.length === 0) {
    return "empty";
  }
  return entries.map(([key, value]) => `${key}=${value}`).join(", ");
}

function formatEventEnd(event: CalendarRow): string | null {
  if (!event.event_end) {
    return null;
  }
  if (event.event_all_day === true) {
    return event.event_end.slice(0, 10);
  }
  if (event.date === toLocalDayKey(event.event_end, event.event_timezone)) {
    return formatClock(event.event_end, event.event_timezone);
  }
  return event.event_end;
}

function formatEventLine(event: CalendarRow): string {
  const core = `${formatClock(event.at, event.event_timezone)} [${event.kind}] ${event.item_id} type=${event.item_type} p${event.item_priority} ${event.item_status} ${event.item_title}`;
  if (event.kind === "reminder") {
    const reminderText = event.reminder_text ?? "";
    return `${core} — ${reminderText} reminder=${JSON.stringify(reminderText)}`;
  }
  if (event.kind === "event") {
    const details: string[] = [];
    const title = event.event_title ?? event.item_title;
    const titleDiffers = event.event_title !== null && event.event_title !== event.item_title;
    if (titleDiffers) {
      details.push(title);
      details.push(`title=${JSON.stringify(title)}`);
    }
    if (event.event_recurring) {
      details.push("(recurring)");
      details.push("recurring=true");
    }
    const end = formatEventEnd(event);
    if (end) {
      details.push(`end=${end}`);
    }
    if (event.event_all_day !== null) {
      details.push(`all_day=${event.event_all_day ? "true" : "false"}`);
    }
    if (event.event_timezone) {
      details.push(`timezone=${event.event_timezone}`);
    }
    if (event.event_location) {
      details.push(`@ ${event.event_location}`);
      details.push(`location=${JSON.stringify(event.event_location)}`);
    }
    if (event.event_recurrence_rule) {
      details.push(`recurrence=${event.event_recurrence_rule}`);
    }
    if (event.reminder_text) {
      details.push(`description=${JSON.stringify(event.reminder_text)}`);
    }
    return `${core} — ${details.join(" ")}`;
  }
  return core;
}

export function renderCalendarMarkdown(result: CalendarResult): string {
  const lines: string[] = [];
  lines.push(`# pm calendar (${result.view})`);
  lines.push("");
  lines.push(`- now: ${result.now}`);
  lines.push(`- window: ${formatWindow(result.range)}`);
  if (result.range.period_start && result.range.period_end) {
    lines.push(`- period: ${result.range.period_start} -> ${result.range.period_end}`);
    lines.push(`- period-mode: ${result.range.full_period ? "full-period" : "active-window"}`);
  }
  lines.push(
    `- events: ${result.summary.events} (deadlines: ${result.summary.deadlines}, reminders: ${result.summary.reminders}, scheduled: ${result.summary.scheduled})`,
  );
  lines.push(`- items: ${result.summary.items}`);
  lines.push(`- by-kind: ${formatSummaryCountRecord(result.summary.by_kind)}`);
  lines.push(`- by-type: ${formatSummaryCountRecord(result.summary.by_type)}`);
  lines.push(`- by-status: ${formatSummaryCountRecord(result.summary.by_status)}`);
  lines.push(`- recurring-events: ${result.summary.recurring_events}`);
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
  if (result.warnings && result.warnings.length > 0) {
    lines.push("### warnings");
    for (const warning of result.warnings) {
      lines.push(`- ${warning}`);
    }
    lines.push("");
  }
  return lines.join("\n").replace(/\n+$/, "");
}

/**
 * Serializes a CalendarResult as TOON (the project's structured output format).
 *
 * The calendar result is JSON-serializable end-to-end (only strings, numbers,
 * booleans, null, plain objects, and arrays), so the value is fed directly to
 * `@toon-format/toon`'s encoder.
 */
export function renderCalendarToon(result: CalendarResult): string {
  return encodeToon(result as unknown as Parameters<typeof encodeToon>[0]);
}

export async function runCalendar(options: CalendarOptions, global: GlobalOptions): Promise<CalendarResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }

  const nowValue = nowIso();
  const view = parseView(options.view);
  const rangeBounds = buildRange(view, options, nowValue);
  const limit = parseIntegerLimit(options.limit);
  const includeSources = parseIncludeSources(options.include);
  const explicitLookahead = parseNonNegativeInteger(options.recurrenceLookaheadDays, "Calendar recurrence lookahead days");
  const recurrenceLookbackDays = parseNonNegativeInteger(options.recurrenceLookbackDays, "Calendar recurrence lookback days");
  const occurrenceLimit = parseNonNegativeInteger(options.occurrenceLimit, "Calendar occurrence limit");
  if (occurrenceLimit !== undefined && occurrenceLimit < 1) {
    throw new PmCliError("Calendar occurrence limit must be >= 1", EXIT_CODE.USAGE);
  }

  const eventsOnly = includeSources.has("events") && !includeSources.has("deadlines") && !includeSources.has("reminders");
  const hasExplicitBounds = options.to !== undefined || explicitLookahead !== undefined || occurrenceLimit !== undefined;
  const eventsOnlyCapApplied = eventsOnly && !hasExplicitBounds;
  const recurrenceLookaheadDays = eventsOnlyCapApplied ? DEFAULT_EVENTS_ONLY_LOOKAHEAD_DAYS : explicitLookahead;
  const recurrenceLookbackWindowDays =
    eventsOnlyCapApplied && recurrenceLookbackDays === undefined
      ? 0
      : recurrenceLookbackDays;

  const settings = await readSettings(pmRoot);
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const runtimeFieldRegistry = resolveRuntimeFieldRegistry(settings.schema);
  const runtimeFieldFilters = collectRuntimeFilterValues(options as Record<string, unknown>, runtimeFieldRegistry, "calendar");
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const listWarnings: string[] = [];
  if (eventsOnlyCapApplied) {
    listWarnings.push(
      `recurring_events_default_cap_applied:lookback=0d,lookahead=${DEFAULT_EVENTS_ONLY_LOOKAHEAD_DAYS}d -- use --recurrence-lookback-days/--recurrence-lookahead-days or --to for wider range`,
    );
  }
  const items = await listAllFrontMatterLight(pmRoot, settings.item_format, typeRegistry.type_to_folder, listWarnings, settings.schema);
  const filteredItems = filterItems(items, options, typeRegistry, statusRegistry, runtimeFieldFilters);
  const recurringWindow = buildRecurringEventWindow(
    rangeBounds.start,
    rangeBounds.end,
    nowValue,
    recurrenceLookbackWindowDays,
    recurrenceLookaheadDays,
  );
  const seededEvents = buildEventSeed(filteredItems, recurringWindow, includeSources, occurrenceLimit);
  const rangedEvents = seededEvents.filter((event) => includeEventInWindow(event, rangeBounds.start, rangeBounds.end));
  const limitedEvents = limit === undefined ? rangedEvents : rangedEvents.slice(0, limit);
  const days = bucketEventsByDay(limitedEvents);
  const warnings = [...new Set(listWarnings)].sort((left, right) => left.localeCompare(right));

  return {
    view,
    output_default: "markdown",
    now: nowValue,
    anchor: rangeBounds.anchor,
    range: {
      start: rangeBounds.start ?? null,
      end: rangeBounds.end ?? null,
      period_start: rangeBounds.periodStart ?? null,
      period_end: rangeBounds.periodEnd ?? null,
      full_period: rangeBounds.fullPeriod,
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
      assignee_filter: options.assigneeFilter ?? null,
      sprint: options.sprint ?? null,
      release: options.release ?? null,
      runtime_filters: runtimeFieldFilters,
      limit: options.limit ?? null,
      include: options.include ?? null,
      full_period: options.fullPeriod === true ? "true" : null,
      recurrence_lookahead_days: options.recurrenceLookaheadDays ?? null,
      recurrence_lookback_days: options.recurrenceLookbackDays ?? null,
      occurrence_limit: options.occurrenceLimit ?? null,
    },
    summary: summarize(limitedEvents),
    events: limitedEvents,
    days,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
