/**
 * @module cli/commands/scheduling-shortcuts
 *
 * Implements the pm scheduling shortcuts command surface and its agent-facing runtime behavior.
 */
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { runCreate, type CreateCommandOptions, type CreateResult } from "./create.js";

/**
 * GH-217: low-friction creation shortcuts for the scheduling item types
 * (Meeting/Event/Reminder), which sit unused because `pm create --type Event`
 * demands structured `--event`/`--reminder` CSV entries. These commands accept
 * friendly time flags (`--start`, `--duration`, `--end`, `--at`) and translate
 * them into the canonical scheduling fields, then delegate to `runCreate` so the
 * full create pipeline (parent/focus inheritance, governance, hooks, validation)
 * applies unchanged. The `lightweight` schedule preset is applied so progressive
 * scheduling fields are not demanded up front.
 */

/** Options shared by every scheduling shortcut, forwarded to `runCreate`. */
export interface SchedulingShortcutCommonOptions {
  parent?: string;
  allowMissingParent?: boolean;
  tags?: string;
  priority?: string;
  body?: string;
  description?: string;
  author?: string;
  message?: string;
}

/** Options for `pm meet` and `pm event` (a start time plus a span). */
export interface MeetingEventShortcutOptions extends SchedulingShortcutCommonOptions {
  start?: string;
  duration?: string;
  end?: string;
  location?: string;
  timezone?: string;
  allDay?: boolean;
}

/** Options for `pm remind` (a single point in time). */
export interface ReminderShortcutOptions extends SchedulingShortcutCommonOptions {
  at?: string;
  text?: string;
}

/** Default span applied when neither `--end` nor `--duration` is given. */
const DEFAULT_DURATION = "1h";
/** Default start applied when `--start` is omitted (keeps the item calendar-visible). */
const DEFAULT_START = "now";
/** Default reminder time applied when `--at` is omitted. */
const DEFAULT_REMINDER_AT = "+1d";

/**
 * Wrap a free-text value (reminder text, event location) in double quotes so
 * commas and colons survive the CSV round-trip into `--reminder`/`--event`.
 * Backslashes are escaped first, then embedded quotes — escaping quotes alone
 * would let a trailing backslash escape the closing quote and break out of the
 * quoted field (CSV injection). The parser's `unquoteValue` strips the wrapping
 * quotes and unescapes `\"` back to `"`.
 */
function quoteCsvValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

/**
 * Append a `key="value"` pair. EVERY value is double-quoted (not just free-text
 * fields) so a comma or `=` in any token — `start`, `duration`, `at`, etc. —
 * cannot inject extra CSV key/value pairs into the `--event`/`--reminder`
 * entry. The parser's `parseCsvKv` unquotes every value before use, so quoting
 * is transparent to ISO/relative/timezone tokens.
 */
function appendPair(pairs: string[], key: string, value: string | undefined): void {
  if (value !== undefined) {
    pairs.push(`${key}=${quoteCsvValue(value)}`);
  }
}

function buildCommonOptions(
  type: string,
  title: string,
  options: SchedulingShortcutCommonOptions,
): CreateCommandOptions {
  return {
    type,
    title,
    schedulePreset: "lightweight",
    parent: options.parent,
    allowMissingParent: options.allowMissingParent,
    tags: options.tags,
    priority: options.priority,
    body: options.body,
    description: options.description,
    author: options.author,
    message: options.message,
  };
}

function buildEventEntry(options: MeetingEventShortcutOptions): string {
  const pairs: string[] = [];
  appendPair(pairs, "start", options.start ?? DEFAULT_START);
  if (options.end !== undefined) {
    appendPair(pairs, "end", options.end);
  } else {
    appendPair(pairs, "duration", options.duration ?? DEFAULT_DURATION);
  }
  appendPair(pairs, "location", options.location);
  appendPair(pairs, "timezone", options.timezone);
  if (options.allDay === true) {
    appendPair(pairs, "all_day", "true");
  }
  return pairs.join(",");
}

async function createScheduled(
  type: string,
  title: string,
  options: MeetingEventShortcutOptions,
  global: GlobalOptions,
): Promise<CreateResult> {
  const createOptions = buildCommonOptions(type, title, options);
  createOptions.event = [buildEventEntry(options)];
  return runCreate(createOptions, global);
}

/** `pm meet "<title>"` — create a Meeting with sensible scheduling defaults. */
export function runMeet(
  title: string,
  options: MeetingEventShortcutOptions,
  global: GlobalOptions,
): Promise<CreateResult> {
  return createScheduled("Meeting", title, options, global);
}

/** `pm event "<title>"` — create an Event with sensible scheduling defaults. */
export function runEvent(
  title: string,
  options: MeetingEventShortcutOptions,
  global: GlobalOptions,
): Promise<CreateResult> {
  return createScheduled("Event", title, options, global);
}

/** `pm remind "<title>"` — create a Reminder from a single point in time. */
export function runRemind(
  title: string,
  options: ReminderShortcutOptions,
  global: GlobalOptions,
): Promise<CreateResult> {
  const createOptions = buildCommonOptions("Reminder", title, options);
  const pairs: string[] = [];
  appendPair(pairs, "at", options.at ?? DEFAULT_REMINDER_AT);
  appendPair(pairs, "text", options.text ?? title);
  createOptions.reminder = [pairs.join(",")];
  return runCreate(createOptions, global);
}
