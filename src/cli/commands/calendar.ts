/**
 * @module cli/commands/calendar
 *
 * Implements the pm calendar command surface and its agent-facing runtime behavior.
 */
import { encode as encodeToon } from "@toon-format/toon";
import { pathExists } from "../../core/fs/fs-utils.js";
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import {
  resolveItemTypeRegistry,
  type ItemTypeRegistry,
} from "../../core/item/type-registry.js";
import {
  parseIntegerLimit,
  parsePriority,
  parseType,
} from "../shared-parsers.js";
import { normalizeStatusInput } from "../../core/item/status.js";
import {
  collectRuntimeFilterValues,
  matchesRuntimeFilters,
} from "../../core/schema/runtime-field-filters.js";
import {
  resolveRuntimeFieldRegistry,
  resolveRuntimeStatusRegistry,
  type RuntimeStatusRegistry,
} from "../../core/schema/runtime-schema.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { levenshteinDistanceWithinLimit } from "../../core/shared/levenshtein.js";
import {
  compareTimestampStrings,
  nowIso,
  resolveIsoOrRelative,
} from "../../core/shared/time.js";
import { listAllItemMetadataLight } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type {
  ItemMetadata,
  ItemStatus,
  ItemType,
  RecurrenceRule,
} from "../../types/index.js";
import {
  RECURRENCE_WEEKDAY_VALUES,
  weekdayOrderIndex,
} from "../../types/index.js";

const CALENDAR_VIEW_VALUES = ["agenda", "day", "week", "month"] as const;
/** Restricts calendar view values accepted by command, SDK, and storage contracts. */
export type CalendarView = (typeof CALENDAR_VIEW_VALUES)[number];

const CALENDAR_OUTPUT_VALUES = ["markdown", "toon", "json"] as const;
/** Restricts calendar output format values accepted by command, SDK, and storage contracts. */
export type CalendarOutputFormat = (typeof CALENDAR_OUTPUT_VALUES)[number];

/** Documents the calendar options payload exchanged by command, SDK, and package integrations. */
export interface CalendarOptions {
  /** Value that configures or reports view for this contract. */
  view?: string;
  /** Value that configures or reports date for this contract. */
  date?: string;
  /** Value that configures or reports from for this contract. */
  from?: string;
  /** Value that configures or reports to for this contract. */
  to?: string;
  /** Value that configures or reports past for this contract. */
  past?: boolean;
  /** Value that configures or reports full period for this contract. */
  fullPeriod?: boolean;
  /** Value that configures or reports limit for this contract. */
  limit?: string;
  /** Schema type that determines the shape and validation rules for this value. */
  type?: string;
  /** Value that configures or reports tag for this contract. */
  tag?: string;
  /** Value that configures or reports priority for this contract. */
  priority?: string;
  /** Lifecycle state reported for status. */
  status?: string;
  /** Value that configures or reports assignee for this contract. */
  assignee?: string;
  /** Value that configures or reports assignee filter for this contract. */
  assigneeFilter?: string;
  /** Value that configures or reports sprint for this contract. */
  sprint?: string;
  /** Value that configures or reports release for this contract. */
  release?: string;
  /** Value that configures or reports include for this contract. */
  include?: string;
  /** Value that configures or reports recurrence lookahead days for this contract. */
  recurrenceLookaheadDays?: string;
  /** Value that configures or reports recurrence lookback days for this contract. */
  recurrenceLookbackDays?: string;
  /** Value that configures or reports occurrence limit for this contract. */
  occurrenceLimit?: string;
  /** Value that configures or reports format for this contract. */
  format?: string;
  [key: string]: unknown;
}

/** Documents the calendar row payload exchanged by command, SDK, and package integrations. */
export interface CalendarRow {
  /** Value that configures or reports at for this contract. */
  at: string;
  /** Value that configures or reports date for this contract. */
  date: string;
  /** Value that configures or reports kind for this contract. */
  kind: "deadline" | "reminder" | "event";
  /** Value that configures or reports reminder text for this contract. */
  reminder_text: string | null;
  /** Value that configures or reports event title for this contract. */
  event_title: string | null;
  /** Value that configures or reports event end for this contract. */
  event_end: string | null;
  /** Value that configures or reports event location for this contract. */
  event_location: string | null;
  /** Value that configures or reports event all day for this contract. */
  event_all_day: boolean | null;
  /** Value that configures or reports event timezone for this contract. */
  event_timezone: string | null;
  /** Value that configures or reports event recurring for this contract. */
  event_recurring: boolean | null;
  /** Value that configures or reports event recurrence rule for this contract. */
  event_recurrence_rule: string | null;
  /** Value that configures or reports item id for this contract. */
  item_id: string;
  /** Value that configures or reports item title for this contract. */
  item_title: string;
  /** Schema type that determines the shape and validation rules for this value. */
  item_type: ItemType;
  /** Lifecycle state reported for itemthe record. */
  item_status: ItemStatus;
  /** Value that configures or reports item priority for this contract. */
  item_priority: number;
  /** Value that configures or reports item assignee for this contract. */
  item_assignee: string | null;
  /** Value that configures or reports item deadline for this contract. */
  item_deadline: string | null;
  /** Value that configures or reports item tags for this contract. */
  item_tags: string[];
}

/** Documents the calendar day bucket payload exchanged by command, SDK, and package integrations. */
export interface CalendarDayBucket {
  /** Value that configures or reports date for this contract. */
  date: string;
  /** Value that configures or reports count for this contract. */
  count: number;
  /** Value that configures or reports events for this contract. */
  events: CalendarRow[];
}

/** Documents the calendar result payload exchanged by command, SDK, and package integrations. */
export interface CalendarResult {
  /** Value that configures or reports view for this contract. */
  view: CalendarView;
  /** Value that configures or reports output default for this contract. */
  output_default: "markdown";
  /** Value that configures or reports now for this contract. */
  now: string;
  /** Value that configures or reports anchor for this contract. */
  anchor: string;
  /** Value that configures or reports range for this contract. */
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
  /** Value that configures or reports filters for this contract. */
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
  /** Value that configures or reports summary for this contract. */
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
  /** Value that configures or reports events for this contract. */
  events: CalendarRow[];
  /** Value that configures or reports days for this contract. */
  days: CalendarDayBucket[];
  /** Value that configures or reports warnings for this contract. */
  warnings?: string[];
}

const UTC_DAY_TO_WEEKDAY = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
] as const;
const DEFAULT_RECURRENCE_LOOKAHEAD_DAYS = 365;
const DEFAULT_RECURRENCE_LOOKBACK_DAYS = 365;
const DEFAULT_EVENTS_ONLY_LOOKAHEAD_DAYS = 28;
const MAX_RECURRENCE_OCCURRENCES = 1000;

function parseNonNegativeInteger(
  raw: string | undefined,
  label: string,
): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new PmCliError(
      `${label} must be a non-negative integer`,
      EXIT_CODE.USAGE,
    );
  }
  return parsed;
}

type CalendarIncludeKind = "deadlines" | "reminders" | "events";

function parseIncludeSources(
  raw: string | undefined,
): Set<CalendarIncludeKind> {
  if (!raw) {
    return new Set(["deadlines", "reminders", "events"]);
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "all") {
    return new Set(["deadlines", "reminders", "events"]);
  }
  const values = normalized
    .split(/[|,]/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (values.length === 0) {
    throw new PmCliError(
      "Calendar include filter must not be empty",
      EXIT_CODE.USAGE,
    );
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
    throw new PmCliError(
      "Calendar include filter must be deadlines|reminders|events|scheduled|all",
      EXIT_CODE.USAGE,
    );
  }
  return include;
}

/** Suggest the closest valid choice for a mistyped enum value (within edit distance 2) so an agent gets an actionable "did you mean" hint instead of just a list of choices (never-block UX). */
function suggestClosestChoice(
  value: string,
  choices: readonly string[],
): string | undefined {
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

function parseOutputFormat(
  raw: string | undefined,
): CalendarOutputFormat | undefined {
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

/** Implements resolve calendar output format for the public runtime surface of this module. */
export function resolveCalendarOutputFormat(
  options: CalendarOptions,
  global: GlobalOptions,
): CalendarOutputFormat {
  const commandFormat = parseOutputFormat(options.format);
  if (global.json && commandFormat && commandFormat !== "json") {
    throw new PmCliError(
      "Cannot combine --json with --format markdown|toon",
      EXIT_CODE.USAGE,
    );
  }
  if (global.json) {
    return "json";
  }
  return commandFormat ?? "markdown";
}

function parseStatus(
  raw: string | undefined,
  statusRegistry: RuntimeStatusRegistry,
): ItemStatus | undefined {
  if (raw === undefined) return undefined;
  const normalized = normalizeStatusInput(raw, statusRegistry);
  if (!normalized) {
    const allowedStatuses = statusRegistry.definitions.map(
      (definition) => definition.id,
    );
    throw new PmCliError(
      `Calendar status filter must be one of ${allowedStatuses.join("|")}`,
      EXIT_CODE.USAGE,
    );
  }
  return normalized;
}

function parseAssigneeFilter(
  raw: string | undefined,
): "assigned" | "unassigned" | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    throw new PmCliError(
      "Calendar assignee filter must be one of assigned|unassigned",
      EXIT_CODE.USAGE,
    );
  }
  if (normalized !== "assigned" && normalized !== "unassigned") {
    throw new PmCliError(
      `Invalid calendar assignee filter "${raw}". Allowed: assigned|unassigned`,
      EXIT_CODE.USAGE,
    );
  }
  return normalized;
}

function toUtcDayKey(timestamp: string): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

/** Calendar day (YYYY-MM-DD) the instant falls on in the given IANA timezone. Events carry an optional `timezone`; bucketing and clock rendering use it so a 23:30Z instant tagged Asia/Tokyo correctly lands on the next local day rather than the UTC day. Falls back to the UTC day when no/invalid timezone is given, so existing UTC behavior is unchanged. Uses Intl (no timezone dependency). */
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
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      0,
      0,
      0,
      0,
    ),
  ).toISOString();
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
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0),
  ).toISOString();
}

function startOfNextUtcMonth(timestamp: string): string {
  const date = new Date(timestamp);
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1, 0, 0, 0, 0),
  ).toISOString();
}

function maxTimestamp(left: string, right: string): string {
  return compareTimestampStrings(left, right) >= 0 ? left : right;
}

function toSortedCountRecord(
  values: Map<string, number>,
): Record<string, number> {
  return Object.fromEntries(
    [...values.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function incrementCount(values: Map<string, number>, key: string): void {
  values.set(key, (values.get(key) ?? 0) + 1);
}

function formatRecurrenceRuleForSummary(
  rule: RecurrenceRule | undefined,
): string | null {
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
    const weekdays = [...rule.by_weekday].sort(
      (left, right) => weekdayOrderIndex(left) - weekdayOrderIndex(right),
    );
    parts.push(`by_weekday=${weekdays.join("|")}`);
  }
  if (rule.by_month_day && rule.by_month_day.length > 0) {
    const monthDays = [...rule.by_month_day].sort(
      (left, right) => left - right,
    );
    parts.push(`by_month_day=${monthDays.join("|")}`);
  }
  if (rule.exdates && rule.exdates.length > 0) {
    const exdates = [...rule.exdates].sort((left, right) =>
      left.localeCompare(right),
    );
    parts.push(`exdates=${exdates.join("|")}`);
  }
  return parts.join(",");
}

function buildUtcTimestamp(
  year: number,
  month: number,
  day: number,
  timeSource: Date,
): string | undefined {
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
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month ||
    candidate.getUTCDate() !== day
  ) {
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

function buildExcludedInstantSet(
  exdates: readonly string[] | undefined,
): Set<string> {
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
  const windowStart =
    start ??
    addUtcDays(nowValue, -(lookbackDays ?? DEFAULT_RECURRENCE_LOOKBACK_DAYS));
  const windowEnd =
    end ??
    addUtcDays(
      start ?? nowValue,
      lookaheadDays ?? DEFAULT_RECURRENCE_LOOKAHEAD_DAYS,
    );
  return {
    start: windowStart,
    end:
      compareTimestampStrings(windowEnd, windowStart) > 0
        ? windowEnd
        : addUtcDays(windowStart, 1),
  };
}

interface RecurrenceExpansionContext {
  startAt: string;
  startDate: Date;
  window: { start: string; end: string };
  maxOccurrences: number;
  interval: number;
  countLimit: number;
  until: string | undefined;
  excluded: Set<string>;
  weekdayFilter: Set<string> | undefined;
  monthDayFilter: Set<number> | undefined;
  sortedWeekdays: Array<(typeof RECURRENCE_WEEKDAY_VALUES)[number]>;
  sortedMonthDays: number[];
  occurrences: string[];
  produced: number;
}

function buildRecurrenceExpansionContext(
  startAt: string,
  recurrence: RecurrenceRule,
  window: { start: string; end: string },
  occurrenceLimit: number | undefined,
): RecurrenceExpansionContext {
  // Omitted filters default to the series start; explicit empty filters intentionally match no occurrences.
  const recurrenceWeekdays =
    recurrence.by_weekday !== undefined
      ? [...recurrence.by_weekday]
      : [weekdayToken(startAt)];
  const recurrenceMonthDays =
    recurrence.by_month_day !== undefined
      ? [...recurrence.by_month_day]
      : [new Date(startAt).getUTCDate()];
  return {
    startAt,
    startDate: new Date(startAt),
    window,
    maxOccurrences: occurrenceLimit ?? MAX_RECURRENCE_OCCURRENCES,
    interval: recurrence.interval ?? 1,
    countLimit: recurrence.count ?? Number.POSITIVE_INFINITY,
    until: recurrence.until,
    excluded: buildExcludedInstantSet(recurrence.exdates),
    weekdayFilter:
      recurrence.by_weekday !== undefined
        ? new Set(recurrence.by_weekday)
        : undefined,
    monthDayFilter:
      recurrence.by_month_day !== undefined
        ? new Set(recurrence.by_month_day)
        : undefined,
    sortedWeekdays: [...new Set(recurrenceWeekdays)].sort(
      (left, right) => weekdayOrderIndex(left) - weekdayOrderIndex(right),
    ),
    sortedMonthDays: [...new Set(recurrenceMonthDays)].sort(
      (left, right) => left - right,
    ),
    occurrences: [],
    produced: 0,
  };
}

function consumeRecurrenceCandidate(
  context: RecurrenceExpansionContext,
  candidateAt: string,
): "continue" | "stop" {
  if (compareTimestampStrings(candidateAt, context.startAt) < 0) {
    return "continue";
  }
  if (
    context.until &&
    compareTimestampStrings(candidateAt, context.until) > 0
  ) {
    return "stop";
  }
  if (compareTimestampStrings(candidateAt, context.window.end) >= 0) {
    return "stop";
  }
  if (context.excluded.has(candidateAt)) {
    return "continue";
  }
  context.produced += 1;
  if (compareTimestampStrings(candidateAt, context.window.start) >= 0) {
    context.occurrences.push(candidateAt);
  }
  return context.produced >= context.countLimit ||
    context.occurrences.length >= context.maxOccurrences
    ? "stop"
    : "continue";
}

function recurrenceDayMatchesFilters(
  context: RecurrenceExpansionContext,
  candidateAt: string,
): boolean {
  const candidateWeekday = weekdayToken(candidateAt);
  const candidateMonthDay = new Date(candidateAt).getUTCDate();
  const weekdayMatches =
    !context.weekdayFilter || context.weekdayFilter.has(candidateWeekday);
  const monthDayMatches =
    !context.monthDayFilter || context.monthDayFilter.has(candidateMonthDay);
  return weekdayMatches && monthDayMatches;
}

function expandDailyOccurrences(context: RecurrenceExpansionContext): string[] {
  let candidateAt = context.startAt;
  for (let iteration = 0; iteration < context.maxOccurrences; iteration += 1) {
    if (
      recurrenceDayMatchesFilters(context, candidateAt) &&
      consumeRecurrenceCandidate(context, candidateAt) === "stop"
    ) {
      break;
    }
    candidateAt = addUtcDays(candidateAt, context.interval);
  }
  return context.occurrences;
}

function buildWeeklyCandidateAt(
  context: RecurrenceExpansionContext,
  candidateWeekStart: string,
  weekday: string,
): string {
  const dayOffset = weekdayOrderIndex(
    weekday as (typeof RECURRENCE_WEEKDAY_VALUES)[number],
  );
  const candidateDay = addUtcDays(candidateWeekStart, dayOffset);
  const dayDate = new Date(candidateDay);
  return new Date(
    Date.UTC(
      dayDate.getUTCFullYear(),
      dayDate.getUTCMonth(),
      dayDate.getUTCDate(),
      context.startDate.getUTCHours(),
      context.startDate.getUTCMinutes(),
      context.startDate.getUTCSeconds(),
      context.startDate.getUTCMilliseconds(),
    ),
  ).toISOString();
}

function expandWeeklyOccurrences(
  context: RecurrenceExpansionContext,
): string[] {
  const weekStart = startOfUtcWeekMonday(context.startAt);
  for (let step = 0; step < context.maxOccurrences; step += 1) {
    const candidateWeekStart = addUtcDays(
      weekStart,
      step * context.interval * 7,
    );
    for (const weekday of context.sortedWeekdays) {
      const candidateAt = buildWeeklyCandidateAt(
        context,
        candidateWeekStart,
        weekday,
      );
      if (!recurrenceDayMatchesFilters(context, candidateAt)) {
        continue;
      }
      if (consumeRecurrenceCandidate(context, candidateAt) === "stop") {
        return context.occurrences;
      }
    }
  }
  return context.occurrences;
}

function expandMonthlyOccurrences(
  context: RecurrenceExpansionContext,
): string[] {
  const startYear = context.startDate.getUTCFullYear();
  const startMonth = context.startDate.getUTCMonth();
  for (let step = 0; step < context.maxOccurrences; step += 1) {
    const monthAnchor = new Date(
      Date.UTC(startYear, startMonth + step * context.interval, 1, 0, 0, 0, 0),
    );
    for (const monthDay of context.sortedMonthDays) {
      const candidateAt = buildUtcTimestamp(
        monthAnchor.getUTCFullYear(),
        monthAnchor.getUTCMonth(),
        monthDay,
        context.startDate,
      );
      if (!candidateAt || !recurrenceDayMatchesFilters(context, candidateAt)) {
        continue;
      }
      if (consumeRecurrenceCandidate(context, candidateAt) === "stop") {
        return context.occurrences;
      }
    }
  }
  return context.occurrences;
}

function expandYearlyOccurrences(
  context: RecurrenceExpansionContext,
): string[] {
  const year = context.startDate.getUTCFullYear();
  const month = context.startDate.getUTCMonth();
  for (let step = 0; step < context.maxOccurrences; step += 1) {
    const candidateYear = year + step * context.interval;
    for (const monthDay of context.sortedMonthDays) {
      const candidateAt = buildUtcTimestamp(
        candidateYear,
        month,
        monthDay,
        context.startDate,
      );
      if (!candidateAt || !recurrenceDayMatchesFilters(context, candidateAt)) {
        continue;
      }
      if (consumeRecurrenceCandidate(context, candidateAt) === "stop") {
        return context.occurrences;
      }
    }
  }
  return context.occurrences;
}

function expandRecurringOccurrences(
  startAt: string,
  recurrence: RecurrenceRule,
  window: { start: string; end: string },
  occurrenceLimit: number | undefined,
): string[] {
  const context = buildRecurrenceExpansionContext(
    startAt,
    recurrence,
    window,
    occurrenceLimit,
  );
  if (recurrence.freq === "daily") {
    return expandDailyOccurrences(context);
  }

  if (recurrence.freq === "weekly") {
    return expandWeeklyOccurrences(context);
  }

  if (recurrence.freq === "monthly") {
    return expandMonthlyOccurrences(context);
  }

  return expandYearlyOccurrences(context);
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
    const byEventTitle = String(a.event_title).localeCompare(
      String(b.event_title),
    );
    if (byEventTitle !== 0) return byEventTitle;
    return String(a.reminder_text).localeCompare(String(b.reminder_text));
  });
}

function buildItemCalendarRowBase(
  item: ItemMetadata,
): Pick<
  CalendarRow,
  | "item_id"
  | "item_title"
  | "item_type"
  | "item_status"
  | "item_priority"
  | "item_assignee"
  | "item_deadline"
  | "item_tags"
> {
  return {
    item_id: item.id,
    item_title: item.title,
    item_type: item.type,
    item_status: item.status,
    item_priority: item.priority,
    item_assignee: item.assignee ?? null,
    item_deadline: item.deadline ?? null,
    item_tags: item.tags,
  };
}

function buildDeadlineRow(item: ItemMetadata): CalendarRow | null {
  if (!item.deadline) {
    return null;
  }
  return {
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
    ...buildItemCalendarRowBase(item),
    item_deadline: item.deadline,
  };
}

function buildReminderRows(item: ItemMetadata): CalendarRow[] {
  return (item.reminders ?? []).map((reminder) => ({
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
    ...buildItemCalendarRowBase(item),
  }));
}

function recurringDurationMs(
  startAt: string,
  endAt: string | undefined,
): number | null {
  if (!endAt) {
    return null;
  }
  const duration = Date.parse(endAt) - Date.parse(startAt);
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

function eventOccurrenceEnd(
  occurrenceAt: string,
  event: NonNullable<ItemMetadata["events"]>[number],
  durationMs: number | null,
): string | null {
  return event.recurrence && durationMs !== null
    ? new Date(new Date(occurrenceAt).getTime() + durationMs).toISOString()
    : (event.end_at ?? null);
}

function buildScheduledEventRows(
  item: ItemMetadata,
  event: NonNullable<ItemMetadata["events"]>[number],
  recurringWindow: { start: string; end: string },
  occurrenceLimit: number | undefined,
): CalendarRow[] {
  const recurrenceRuleSummary = formatRecurrenceRuleForSummary(
    event.recurrence,
  );
  const durationMs = recurringDurationMs(event.start_at, event.end_at);
  const occurrences = event.recurrence
    ? expandRecurringOccurrences(
        event.start_at,
        event.recurrence,
        recurringWindow,
        occurrenceLimit,
      )
    : [event.start_at];
  return occurrences.map((occurrenceAt) => ({
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
    event_end: eventOccurrenceEnd(occurrenceAt, event, durationMs),
    event_location: event.location ?? null,
    event_all_day: event.all_day ?? null,
    event_timezone: event.timezone ?? null,
    event_recurring: event.recurrence ? true : false,
    event_recurrence_rule: recurrenceRuleSummary,
    ...buildItemCalendarRowBase(item),
  }));
}

function buildEventSeed(
  items: ItemMetadata[],
  recurringWindow: { start: string; end: string },
  includeSources: Set<CalendarIncludeKind>,
  occurrenceLimit: number | undefined,
): CalendarRow[] {
  const events: CalendarRow[] = [];
  for (const item of items) {
    const deadlineRow = includeSources.has("deadlines")
      ? buildDeadlineRow(item)
      : null;
    if (deadlineRow) {
      events.push(deadlineRow);
    }
    if (includeSources.has("reminders")) {
      events.push(...buildReminderRows(item));
    }
    for (const event of includeSources.has("events")
      ? (item.events ?? [])
      : []) {
      events.push(
        ...buildScheduledEventRows(
          item,
          event,
          recurringWindow,
          occurrenceLimit,
        ),
      );
    }
  }
  return sortEvents(events);
}

function filterItems(
  items: ItemMetadata[],
  options: CalendarOptions,
  typeRegistry: ItemTypeRegistry,
  statusRegistry: RuntimeStatusRegistry,
  runtimeFieldFilters: Record<string, unknown>,
): ItemMetadata[] {
  const typeFilter = parseType(options.type, typeRegistry);
  const tagFilter = options.tag?.trim().toLowerCase();
  const priorityFilter = parsePriority(options.priority);
  const statusFilter = parseStatus(options.status, statusRegistry);
  const assigneeFilter = options.assignee?.trim();
  const assigneeModeFilter = parseAssigneeFilter(options.assigneeFilter);
  const sprintFilter = options.sprint?.trim();
  const releaseFilter = options.release?.trim();

  if (
    assigneeFilter &&
    (assigneeFilter.toLowerCase() === "none" ||
      assigneeFilter.toLowerCase() === "null")
  ) {
    throw new PmCliError(
      '--assignee no longer accepts "none" or "null". Use --assignee-filter unassigned.',
      EXIT_CODE.USAGE,
    );
  }
  if (assigneeFilter !== undefined && assigneeModeFilter === "unassigned") {
    throw new PmCliError(
      "Cannot combine --assignee with --assignee-filter unassigned",
      EXIT_CODE.USAGE,
    );
  }

  return items.filter((item) =>
    itemMatchesCalendarFilters(item, {
      typeFilter,
      tagFilter,
      priorityFilter,
      statusFilter,
      assigneeFilter,
      assigneeModeFilter,
      sprintFilter,
      releaseFilter,
      runtimeFieldFilters,
    }),
  );
}

function itemMatchesCalendarFilters(
  item: ItemMetadata,
  filters: {
    typeFilter: ItemType | undefined;
    tagFilter: string | undefined;
    priorityFilter: number | undefined;
    statusFilter: ItemStatus | undefined;
    assigneeFilter: string | undefined;
    assigneeModeFilter: "assigned" | "unassigned" | undefined;
    sprintFilter: string | undefined;
    releaseFilter: string | undefined;
    runtimeFieldFilters: Record<string, unknown>;
  },
): boolean {
  return (
    itemMatchesCalendarIdentityFilters(item, filters) &&
    itemMatchesCalendarOwnerFilters(item, filters) &&
    matchesRuntimeFilters(
      item as Record<string, unknown>,
      filters.runtimeFieldFilters,
    )
  );
}

function itemMatchesCalendarIdentityFilters(
  item: ItemMetadata,
  filters: Parameters<typeof itemMatchesCalendarFilters>[1],
): boolean {
  if (filters.typeFilter && item.type !== filters.typeFilter) return false;
  if (
    filters.tagFilter &&
    !item.tags.some((tag) => tag.trim().toLowerCase() === filters.tagFilter)
  )
    return false;
  if (
    filters.priorityFilter !== undefined &&
    item.priority !== filters.priorityFilter
  )
    return false;
  if (filters.statusFilter && item.status !== filters.statusFilter)
    return false;
  return true;
}

function itemMatchesCalendarOwnerFilters(
  item: ItemMetadata,
  filters: Parameters<typeof itemMatchesCalendarFilters>[1],
): boolean {
  if (filters.assigneeModeFilter === "assigned" && !item.assignee) return false;
  if (filters.assigneeModeFilter === "unassigned" && item.assignee)
    return false;
  if (
    filters.assigneeFilter !== undefined &&
    item.assignee !== filters.assigneeFilter
  )
    return false;
  if (
    filters.sprintFilter !== undefined &&
    item.sprint !== filters.sprintFilter
  )
    return false;
  if (
    filters.releaseFilter !== undefined &&
    item.release !== filters.releaseFilter
  )
    return false;
  return true;
}

function includeEventInWindow(
  event: CalendarRow,
  start: string | undefined,
  end: string | undefined,
): boolean {
  if (start && compareTimestampStrings(event.at, start) < 0) {
    return false;
  }
  if (end && compareTimestampStrings(event.at, end) >= 0) {
    return false;
  }
  return true;
}

function resolveCalendarBoundaryInput(
  raw: string,
  nowValue: string,
  fieldLabel: "--date" | "--from" | "--to",
): string {
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
  const anchor = options.date
    ? resolveCalendarBoundaryInput(options.date, nowValue, "--date")
    : nowValue;
  const includePast = options.past === true;
  const fullPeriodRequested = options.fullPeriod === true;

  const from = options.from
    ? resolveCalendarBoundaryInput(options.from, nowValue, "--from")
    : undefined;
  const to = options.to
    ? resolveCalendarBoundaryInput(options.to, nowValue, "--to")
    : undefined;
  if (from && to && compareTimestampStrings(from, to) >= 0) {
    throw new PmCliError(
      "Calendar --from must be before --to",
      EXIT_CODE.USAGE,
    );
  }

  if (
    view !== "agenda" &&
    (options.from !== undefined || options.to !== undefined)
  ) {
    throw new PmCliError(
      "--from and --to are only supported for --view agenda",
      EXIT_CODE.USAGE,
    );
  }

  if (view === "agenda") {
    return buildAgendaRange(
      anchor,
      options,
      nowValue,
      includePast,
      fullPeriodRequested,
      from,
      to,
    );
  }

  if (view === "day") {
    const dayStart = startOfUtcDay(anchor);
    return buildFixedPeriodRange(
      anchor,
      nowValue,
      includePast,
      fullPeriodRequested,
      dayStart,
      addUtcDays(dayStart, 1),
    );
  }

  if (view === "week") {
    const weekStart = startOfUtcWeekMonday(anchor);
    return buildFixedPeriodRange(
      anchor,
      nowValue,
      includePast,
      fullPeriodRequested,
      weekStart,
      addUtcDays(weekStart, 7),
    );
  }

  const monthStart = startOfUtcMonth(anchor);
  return buildFixedPeriodRange(
    anchor,
    nowValue,
    includePast,
    fullPeriodRequested,
    monthStart,
    startOfNextUtcMonth(anchor),
  );
}

function buildAgendaRange(
  anchor: string,
  options: CalendarOptions,
  nowValue: string,
  includePast: boolean,
  fullPeriodRequested: boolean,
  from: string | undefined,
  to: string | undefined,
): ReturnType<typeof buildRange> {
  if (fullPeriodRequested) {
    throw new PmCliError(
      "--full-period is only supported for --view day|week|month. For agenda windows, use --from and --to.",
      EXIT_CODE.USAGE,
    );
  }
  return {
    anchor,
    start: from ?? (options.date ? anchor : includePast ? undefined : nowValue),
    end: to,
    fullPeriod: false,
  };
}

function buildFixedPeriodRange(
  anchor: string,
  nowValue: string,
  includePast: boolean,
  fullPeriodRequested: boolean,
  periodStart: string,
  periodEnd: string,
): ReturnType<typeof buildRange> {
  const fullPeriod = includePast || fullPeriodRequested;
  return {
    anchor,
    start: fullPeriod ? periodStart : maxTimestamp(periodStart, nowValue),
    end: periodEnd,
    periodStart,
    periodEnd,
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
    const titleDiffers =
      event.event_title !== null && event.event_title !== event.item_title;
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

/** Implements render calendar markdown for the public runtime surface of this module. */
export function renderCalendarMarkdown(result: CalendarResult): string {
  const lines: string[] = [];
  lines.push(`# pm calendar (${result.view})`);
  lines.push("");
  lines.push(`- now: ${result.now}`);
  lines.push(`- window: ${formatWindow(result.range)}`);
  if (result.range.period_start && result.range.period_end) {
    lines.push(
      `- period: ${result.range.period_start} -> ${result.range.period_end}`,
    );
    lines.push(
      `- period-mode: ${result.range.full_period ? "full-period" : "active-window"}`,
    );
  }
  lines.push(
    `- events: ${result.summary.events} (deadlines: ${result.summary.deadlines}, reminders: ${result.summary.reminders}, scheduled: ${result.summary.scheduled})`,
  );
  lines.push(`- items: ${result.summary.items}`);
  lines.push(`- by-kind: ${formatSummaryCountRecord(result.summary.by_kind)}`);
  lines.push(`- by-type: ${formatSummaryCountRecord(result.summary.by_type)}`);
  lines.push(
    `- by-status: ${formatSummaryCountRecord(result.summary.by_status)}`,
  );
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
  return trimTrailingNewlines(lines.join("\n"));
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

function trimTrailingNewlines(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "\n") {
    end -= 1;
  }
  return value.slice(0, end);
}

interface CalendarExecutionInputs {
  nowValue: string;
  view: CalendarView;
  rangeBounds: ReturnType<typeof buildRange>;
  limit: number | undefined;
  includeSources: Set<CalendarIncludeKind>;
  occurrenceLimit: number | undefined;
  recurrenceLookaheadDays: number | undefined;
  recurrenceLookbackWindowDays: number | undefined;
  eventsOnlyCapApplied: boolean;
}

function resolveCalendarExecutionInputs(
  options: CalendarOptions,
): CalendarExecutionInputs {
  const nowValue = nowIso();
  const view = parseView(options.view);
  const rangeBounds = buildRange(view, options, nowValue);
  const limit = parseIntegerLimit(options.limit);
  const includeSources = parseIncludeSources(options.include);
  const explicitLookahead = parseNonNegativeInteger(
    options.recurrenceLookaheadDays,
    "Calendar recurrence lookahead days",
  );
  const recurrenceLookbackDays = parseNonNegativeInteger(
    options.recurrenceLookbackDays,
    "Calendar recurrence lookback days",
  );
  const occurrenceLimit = parseNonNegativeInteger(
    options.occurrenceLimit,
    "Calendar occurrence limit",
  );
  if (occurrenceLimit !== undefined && occurrenceLimit < 1) {
    throw new PmCliError(
      "Calendar occurrence limit must be >= 1",
      EXIT_CODE.USAGE,
    );
  }
  const eventsOnly =
    includeSources.has("events") &&
    !includeSources.has("deadlines") &&
    !includeSources.has("reminders");
  const hasExplicitBounds =
    options.to !== undefined ||
    explicitLookahead !== undefined ||
    recurrenceLookbackDays !== undefined ||
    occurrenceLimit !== undefined;
  const eventsOnlyCapApplied = eventsOnly && !hasExplicitBounds;
  return {
    nowValue,
    view,
    rangeBounds,
    limit,
    includeSources,
    occurrenceLimit,
    recurrenceLookaheadDays: eventsOnlyCapApplied
      ? DEFAULT_EVENTS_ONLY_LOOKAHEAD_DAYS
      : explicitLookahead,
    recurrenceLookbackWindowDays:
      eventsOnlyCapApplied && recurrenceLookbackDays === undefined
        ? 0
        : recurrenceLookbackDays,
    eventsOnlyCapApplied,
  };
}

function appendCalendarCapWarning(
  warnings: string[],
  capApplied: boolean,
): void {
  if (!capApplied) {
    return;
  }
  warnings.push(
    `recurring_events_default_cap_applied:lookback=0d,lookahead=${DEFAULT_EVENTS_ONLY_LOOKAHEAD_DAYS}d -- use --recurrence-lookback-days/--recurrence-lookahead-days or --to for wider range`,
  );
}

function buildCalendarFiltersResult(
  options: CalendarOptions,
  runtimeFieldFilters: Record<string, unknown>,
): CalendarResult["filters"] {
  return {
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
  };
}

function buildCalendarRangeResult(
  options: CalendarOptions,
  rangeBounds: ReturnType<typeof buildRange>,
): CalendarResult["range"] {
  return {
    start: rangeBounds.start ?? null,
    end: rangeBounds.end ?? null,
    period_start: rangeBounds.periodStart ?? null,
    period_end: rangeBounds.periodEnd ?? null,
    full_period: rangeBounds.fullPeriod,
    past: options.past === true,
    from: options.from ?? null,
    to: options.to ?? null,
  };
}

/** Implements run calendar for the public runtime surface of this module. */
export async function runCalendar(
  options: CalendarOptions,
  global: GlobalOptions,
): Promise<CalendarResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(
      `Tracker is not initialized at ${pmRoot}. Run pm init first.`,
      EXIT_CODE.NOT_FOUND,
    );
  }

  const inputs = resolveCalendarExecutionInputs(options);

  const settings = await readSettings(pmRoot);
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const runtimeFieldRegistry = resolveRuntimeFieldRegistry(settings.schema);
  const runtimeFieldFilters = collectRuntimeFilterValues(
    options as Record<string, unknown>,
    runtimeFieldRegistry,
    "calendar",
  );
  const typeRegistry = resolveItemTypeRegistry(
    settings,
    getActiveExtensionRegistrations(),
  );
  const listWarnings: string[] = [];
  appendCalendarCapWarning(listWarnings, inputs.eventsOnlyCapApplied);
  const items = await listAllItemMetadataLight(
    pmRoot,
    settings.item_format,
    typeRegistry.type_to_folder,
    listWarnings,
    settings.schema,
  );
  const filteredItems = filterItems(
    items,
    options,
    typeRegistry,
    statusRegistry,
    runtimeFieldFilters,
  );
  const recurringWindow = buildRecurringEventWindow(
    inputs.rangeBounds.start,
    inputs.rangeBounds.end,
    inputs.nowValue,
    inputs.recurrenceLookbackWindowDays,
    inputs.recurrenceLookaheadDays,
  );
  const seededEvents = buildEventSeed(
    filteredItems,
    recurringWindow,
    inputs.includeSources,
    inputs.occurrenceLimit,
  );
  const rangedEvents = seededEvents.filter((event) =>
    includeEventInWindow(
      event,
      inputs.rangeBounds.start,
      inputs.rangeBounds.end,
    ),
  );
  const limitedEvents =
    inputs.limit === undefined
      ? rangedEvents
      : rangedEvents.slice(0, inputs.limit);
  const days = bucketEventsByDay(limitedEvents);
  const warnings = [...new Set(listWarnings)].sort((left, right) =>
    left.localeCompare(right),
  );

  return {
    view: inputs.view,
    output_default: "markdown",
    now: inputs.nowValue,
    anchor: inputs.rangeBounds.anchor,
    range: buildCalendarRangeResult(options, inputs.rangeBounds),
    filters: buildCalendarFiltersResult(options, runtimeFieldFilters),
    summary: summarize(limitedEvents),
    events: limitedEvents,
    days,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
