/**
 * @module cli/commands/recurrence-parsers
 *
 * Implements the pm recurrence parsers command surface and its agent-facing runtime behavior.
 */
import { parseOptionalNumber } from "../../core/item/parse.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import { resolveIsoOrRelative } from "../../core/shared/time.js";
import {
  RECURRENCE_FREQUENCY_VALUES,
  RECURRENCE_WEEKDAY_VALUES,
  weekdayOrderIndex,
} from "../../types/index.js";
import type { RecurrenceRule } from "../../types/index.js";

/**
 * Shared calendar recurrence/event parsing helpers used by the `create` and
 * `update` commands. Extracted verbatim from create.ts and update.ts (pm-why9).
 *
 * `parseEventBoolean`, `parseDelimitedList`, and `ensureEnumValue` were
 * byte-identical between the two commands (update spelled `ensureEnumValue` as
 * `ensureEnum`).
 *
 * `parseRecurrenceRule` was identical apart from the recur_interval/recur_count
 * "provided" guard: create used `intervalRaw !== undefined` (an empty
 * `recur_interval=` is parsed and rejected), while update used the truthy
 * `intervalRaw ?` (an empty value is skipped). That distinction is preserved
 * via the `emptyNumericGuard` option so both call sites keep their exact
 * behaviour, including error strings.
 */

export function parseEventBoolean(value: string, flag: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  throw new PmCliError(`${flag} must be one of true|false|1|0|yes|no`, EXIT_CODE.USAGE);
}

/**
 * Implements parse delimited list for the public runtime surface of this module.
 */
export function parseDelimitedList(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split("|")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/**
 * Implements ensure enum value for the public runtime surface of this module.
 */
export function ensureEnumValue<T extends string>(value: string, allowed: readonly T[], label: string): T {
  if (!allowed.includes(value as T)) {
    throw new PmCliError(`Invalid ${label} value "${value}". Allowed: ${allowed.join(", ")}`, EXIT_CODE.USAGE);
  }
  return value as T;
}

/**
 * `"defined"` parses `recur_interval=`/`recur_count=` (empty values), matching
 * the historical `create` behaviour. `"truthy"` skips empty values, matching
 * the historical `update` behaviour.
 */
export type RecurrenceEmptyNumericGuard = "defined" | "truthy";

/**
 * Authoritative list of the CSV/markdown recurrence keys this parser reads.
 * Co-located with {@link parseRecurrenceRule} so adding a recurrence field
 * updates the reads AND the strict unknown-key allow-list in one place — the
 * `--event` validator (repeatable-metadata-parsers EVENT_KEYS) spreads this, so
 * a new recur key can never be silently rejected (GH-258). Keep in sync with
 * the `kv.recur_*` reads below.
 */
export const RECURRENCE_CSV_KEYS = [
  "recur_freq",
  "recur_interval",
  "recur_count",
  "recur_until",
  "recur_by_weekday",
  "recur_by_month_day",
  "recur_exdates",
] as const;

function numericRecurrenceValueProvided(raw: string | undefined, guard: RecurrenceEmptyNumericGuard): boolean {
  return guard === "defined" ? raw !== undefined : Boolean(raw);
}

function parsePositiveRecurrenceInteger(raw: string | undefined, label: string, guard: RecurrenceEmptyNumericGuard): number | undefined {
  if (!numericRecurrenceValueProvided(raw, guard)) {
    return undefined;
  }
  const parsed = parseOptionalNumber(raw as string, `event ${label}`);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new PmCliError(`--event ${label} must be an integer >= 1`, EXIT_CODE.USAGE);
  }
  return parsed;
}

function parseRecurrenceUntil(untilRaw: string | undefined, startAt: string, nowValue: Date): string | undefined {
  const until = untilRaw ? resolveIsoOrRelative(untilRaw, nowValue, "event.recur_until") : undefined;
  if (until && until < startAt) {
    throw new PmCliError("--event recur_until must be at or after start", EXIT_CODE.USAGE);
  }
  return until;
}

function parseRecurrenceWeekdays(raw: string | undefined): Array<(typeof RECURRENCE_WEEKDAY_VALUES)[number]> {
  return Array.from(
    new Set(
      parseDelimitedList(raw).map((value) => ensureEnumValue(value.toLowerCase(), RECURRENCE_WEEKDAY_VALUES, "event weekday")),
    ),
  ).sort((left, right) => weekdayOrderIndex(left) - weekdayOrderIndex(right));
}

function parseRecurrenceMonthDays(raw: string | undefined): number[] {
  return Array.from(
    new Set(
      parseDelimitedList(raw).map((value) => {
        const day = parseOptionalNumber(value, "event recur_by_month_day");
        if (!Number.isInteger(day) || day < 1 || day > 31) {
          throw new PmCliError("--event recur_by_month_day values must be integers 1..31", EXIT_CODE.USAGE);
        }
        return day;
      }),
    ),
  ).sort((left, right) => left - right);
}

function parseRecurrenceExdates(raw: string | undefined, nowValue: Date): string[] {
  return Array.from(
    new Set(parseDelimitedList(raw).map((value) => resolveIsoOrRelative(value, nowValue, "event.recur_exdates"))),
  ).sort((left, right) => left.localeCompare(right));
}

/**
 * Implements parse recurrence rule for the public runtime surface of this module.
 */
export function parseRecurrenceRule(
  kv: Record<string, string>,
  startAt: string,
  nowValue: Date,
  emptyNumericGuard: RecurrenceEmptyNumericGuard,
): RecurrenceRule | undefined {
  const freqRaw = kv.recur_freq?.trim();
  const intervalRaw = kv.recur_interval?.trim();
  const countRaw = kv.recur_count?.trim();
  const untilRaw = kv.recur_until?.trim();
  const byWeekdayRaw = kv.recur_by_weekday?.trim();
  const byMonthDayRaw = kv.recur_by_month_day?.trim();
  const exdatesRaw = kv.recur_exdates?.trim();

  const recurrenceInputsProvided = [freqRaw, intervalRaw, countRaw, untilRaw, byWeekdayRaw, byMonthDayRaw, exdatesRaw].some(
    (value) => value !== undefined,
  );
  if (!recurrenceInputsProvided) {
    return undefined;
  }
  if (!freqRaw) {
    throw new PmCliError("--event recurrence fields require recur_freq=<daily|weekly|monthly|yearly>", EXIT_CODE.USAGE);
  }

  const freq = ensureEnumValue(freqRaw.toLowerCase(), RECURRENCE_FREQUENCY_VALUES, "event recurrence frequency");
  const interval = parsePositiveRecurrenceInteger(intervalRaw, "recur_interval", emptyNumericGuard);
  const count = parsePositiveRecurrenceInteger(countRaw, "recur_count", emptyNumericGuard);
  const until = parseRecurrenceUntil(untilRaw, startAt, nowValue);
  const byWeekday = parseRecurrenceWeekdays(byWeekdayRaw);
  const byMonthDay = parseRecurrenceMonthDays(byMonthDayRaw);
  const exdates = parseRecurrenceExdates(exdatesRaw, nowValue);

  return {
    freq,
    interval,
    count,
    until,
    by_weekday: byWeekday.length > 0 ? byWeekday : undefined,
    by_month_day: byMonthDay.length > 0 ? byMonthDay : undefined,
    exdates: exdates.length > 0 ? exdates : undefined,
  };
}
