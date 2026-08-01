/**
 * @module sdk/scheduling-shortcuts
 *
 * Provides SDK-first scheduling shortcuts shared by CLI, MCP, and packages.
 */
import type { GlobalOptions } from "../core/shared/command-types.js";
import {
  runCreate,
  type CreateCommandOptions,
  type CreateResult,
} from "./lifecycle/create.js";

/** Options shared by every scheduling shortcut. */
export interface SchedulingShortcutCommonOptions {
  /** Optional parent item id. */
  parent?: string;
  /** Permit a parent that has not been created yet. */
  allowMissingParent?: boolean;
  /** Comma-separated item tags. */
  tags?: string;
  /** Item priority. */
  priority?: string;
  /** Long-form item body. */
  body?: string;
  /** Concise item description. */
  description?: string;
  /** Explicit mutation author override. */
  author?: string;
  /** Human-readable history message. */
  message?: string;
}

/** Options for meeting and event shortcuts. */
export interface MeetingEventShortcutOptions extends SchedulingShortcutCommonOptions {
  /** ISO, relative, or natural start token. */
  start?: string;
  /** Relative duration used when end is omitted. */
  duration?: string;
  /** ISO, relative, or natural end token. */
  end?: string;
  /** Physical or virtual location. */
  location?: string;
  /** IANA timezone. */
  timezone?: string;
  /** Whether the item spans a calendar day. */
  allDay?: boolean;
}

/** Options for reminder shortcuts. */
export interface ReminderShortcutOptions extends SchedulingShortcutCommonOptions {
  /** ISO, relative, or natural reminder token. */
  at?: string;
  /** Reminder text, defaulting to the title. */
  text?: string;
}

const DEFAULT_DURATION = "1h";
const DEFAULT_START = "now";
const DEFAULT_REMINDER_AT = "+1d";

function appendQuotedPair(
  pairs: string[],
  key: string,
  value: string | undefined,
): void {
  if (value !== undefined) {
    pairs.push(`${key}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
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

async function createMeetingOrEvent(
  type: "Meeting" | "Event",
  title: string,
  options: MeetingEventShortcutOptions,
  global: GlobalOptions,
): Promise<CreateResult> {
  const createOptions = buildCommonOptions(type, title, options);
  const pairs: string[] = [];
  appendQuotedPair(pairs, "start", options.start ?? DEFAULT_START);
  if (options.end !== undefined) {
    appendQuotedPair(pairs, "end", options.end);
  } else {
    appendQuotedPair(pairs, "duration", options.duration ?? DEFAULT_DURATION);
  }
  appendQuotedPair(pairs, "location", options.location);
  appendQuotedPair(pairs, "timezone", options.timezone);
  if (options.allDay === true) appendQuotedPair(pairs, "all_day", "true");
  createOptions.event = [pairs.join(",")];
  return runCreate(createOptions, global);
}

/** Create a Meeting with scheduling defaults through the canonical lifecycle. */
export function runMeet(
  title: string,
  options: MeetingEventShortcutOptions,
  global: GlobalOptions,
): Promise<CreateResult> {
  return createMeetingOrEvent("Meeting", title, options, global);
}

/** Create an Event with scheduling defaults through the canonical lifecycle. */
export function runEvent(
  title: string,
  options: MeetingEventShortcutOptions,
  global: GlobalOptions,
): Promise<CreateResult> {
  return createMeetingOrEvent("Event", title, options, global);
}

/** Create a Reminder with scheduling defaults through the canonical lifecycle. */
export function runRemind(
  title: string,
  options: ReminderShortcutOptions,
  global: GlobalOptions,
): Promise<CreateResult> {
  const createOptions = buildCommonOptions("Reminder", title, options);
  const pairs: string[] = [];
  appendQuotedPair(pairs, "at", options.at ?? DEFAULT_REMINDER_AT);
  appendQuotedPair(pairs, "text", options.text ?? title);
  createOptions.reminder = [pairs.join(",")];
  return runCreate(createOptions, global);
}
