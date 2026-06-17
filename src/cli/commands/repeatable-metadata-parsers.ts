import { assertNoUnknownCsvKeys, parseCsvKv } from "../../core/item/parse.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import { resolveIsoOrRelative } from "../../core/shared/time.js";
import type { CalendarEvent, Reminder } from "../../types/index.js";
import { resolveEventEndAt } from "./event-validation-messages.js";
import {
  parseEventBoolean,
  parseRecurrenceRule,
  type RecurrenceEmptyNumericGuard,
} from "./recurrence-parsers.js";

/** Allowed CSV/markdown keys for `--reminder` (GH-258). */
const REMINDER_KEYS = ["at", "date", "text", "title"] as const;
/** Allowed CSV/markdown keys for `--event`, including recurrence keys (GH-258). */
const EVENT_KEYS = [
  "start",
  "date",
  "end",
  "duration",
  "title",
  "description",
  "location",
  "timezone",
  "all_day",
  "recur_freq",
  "recur_interval",
  "recur_count",
  "recur_until",
  "recur_by_weekday",
  "recur_by_month_day",
  "recur_exdates",
] as const;
/** Allowed CSV/markdown keys for the `--type-option` structured form (GH-258). */
const TYPE_OPTION_KEYS = ["key", "value"] as const;

type EmptyValueGuard = "defined" | "truthy";
type ReminderValueMode = "raw" | "trimmed";

interface ParseReminderEntriesOptions {
  valueMode: ReminderValueMode;
}

interface ParseEventEntriesOptions {
  allDayEmptyGuard: EmptyValueGuard;
  recurrenceEmptyNumericGuard: RecurrenceEmptyNumericGuard;
}

function optionalString(value: string | undefined, mode: ReminderValueMode): string | undefined {
  return mode === "trimmed" ? value?.trim() : value;
}

function isProvided(value: string | undefined, guard: EmptyValueGuard): boolean {
  return guard === "defined" ? value !== undefined : Boolean(value);
}

export function parseReminderEntries(raw: string[], nowValue: Date, options: ParseReminderEntriesOptions): Reminder[] {
  return raw.map((entry) => {
    const kv = parseCsvKv(entry, "--reminder");
    assertNoUnknownCsvKeys(kv, "--reminder", REMINDER_KEYS);
    const atRaw = optionalString(kv.at ?? kv.date, options.valueMode);
    const textRaw = optionalString(kv.text ?? kv.title, options.valueMode);
    if (!atRaw || !textRaw) {
      throw new PmCliError("--reminder requires at=<iso|relative> or date=<iso|relative>, plus text=<value> or title=<value>", EXIT_CODE.USAGE);
    }
    const text = textRaw.trim();
    if (!text) {
      throw new PmCliError("--reminder text must not be empty", EXIT_CODE.USAGE);
    }
    return {
      at: resolveIsoOrRelative(atRaw, nowValue, "reminder.at"),
      text,
    };
  });
}

export function parseEventEntries(raw: string[], nowValue: Date, options: ParseEventEntriesOptions): CalendarEvent[] {
  return raw.map((entry) => {
    const kv = parseCsvKv(entry, "--event");
    assertNoUnknownCsvKeys(kv, "--event", EVENT_KEYS);
    const startRaw = (kv.start ?? kv.date)?.trim();
    if (!startRaw) {
      throw new PmCliError("--event requires start=<iso|relative> or date=<iso|relative>", EXIT_CODE.USAGE);
    }
    const startAt = resolveIsoOrRelative(startRaw, nowValue, "event.start");
    const endRaw = kv.end?.trim();
    const durationRaw = kv.duration?.trim();
    const endAt = resolveEventEndAt(startAt, endRaw, durationRaw, nowValue);

    const titleRaw = kv.title;
    const descriptionRaw = kv.description;
    const locationRaw = kv.location;
    const timezoneRaw = kv.timezone;

    const title = titleRaw?.trim();
    const description = descriptionRaw?.trim();
    const location = locationRaw?.trim();
    const timezone = timezoneRaw?.trim();
    if (titleRaw !== undefined && !title) {
      throw new PmCliError("--event title must not be empty", EXIT_CODE.USAGE);
    }
    if (descriptionRaw !== undefined && !description) {
      throw new PmCliError("--event description must not be empty", EXIT_CODE.USAGE);
    }
    if (locationRaw !== undefined && !location) {
      throw new PmCliError("--event location must not be empty", EXIT_CODE.USAGE);
    }
    if (timezoneRaw !== undefined && !timezone) {
      throw new PmCliError("--event timezone must not be empty", EXIT_CODE.USAGE);
    }

    const allDayRaw = kv.all_day?.trim();
    const recurrence = parseRecurrenceRule(kv, startAt, nowValue, options.recurrenceEmptyNumericGuard);
    const allDay = isProvided(allDayRaw, options.allDayEmptyGuard)
      ? parseEventBoolean(allDayRaw as string, "--event all_day")
      : undefined;

    return {
      start_at: startAt,
      end_at: endAt,
      title,
      description,
      location,
      all_day: allDay,
      timezone,
      recurrence,
    };
  });
}

export function parseTypeOptionEntries(raw: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const entry of raw) {
    const trimmedEntry = entry.trim();
    if (trimmedEntry.length === 0) {
      throw new PmCliError("--type-option values must not be empty", EXIT_CODE.USAGE);
    }
    let key: string | undefined;
    let value: string | undefined;
    const prefersStructuredKv =
      trimmedEntry.includes(",") ||
      trimmedEntry.includes("\n") ||
      trimmedEntry.startsWith("```") ||
      /^(?:[-*+]\s+)?(?:key|value)\s*[:=]/i.test(trimmedEntry);
    if (prefersStructuredKv) {
      const kv = parseCsvKv(trimmedEntry, "--type-option");
      assertNoUnknownCsvKeys(kv, "--type-option", TYPE_OPTION_KEYS);
      key = kv.key?.trim();
      value = kv.value?.trim();
    } else {
      const equalsIndex = trimmedEntry.indexOf("=");
      const colonIndex = trimmedEntry.indexOf(":");
      let separatorIndex = equalsIndex;
      if (equalsIndex <= 0 && colonIndex > 0) {
        separatorIndex = colonIndex;
      }
      if (separatorIndex <= 0 || separatorIndex === trimmedEntry.length - 1) {
        throw new PmCliError(
          "--type-option requires key=value or key=<name>,value=<value> entries",
          EXIT_CODE.USAGE,
        );
      }
      key = trimmedEntry.slice(0, separatorIndex).trim();
      value = trimmedEntry.slice(separatorIndex + 1).trim();
    }
    if (!key || !value) {
      throw new PmCliError("--type-option requires key and value", EXIT_CODE.USAGE);
    }
    values[key] = value;
  }
  return Object.fromEntries(Object.entries(values).sort((left, right) => left[0].localeCompare(right[0])));
}
