/**
 * @module sdk/item-schedule
 *
 * Normalizes scheduling metadata into one stable read facet so scheduled item
 * types remain useful through generic SDK, CLI, MCP, JSON, and TOON reads.
 */
import type { CalendarEvent, ItemMetadata, Reminder } from "../types/index.js";

const BUILTIN_SCHEDULE_TYPES = new Set(["event", "meeting", "reminder"]);

/** Schedule projection attached to standard and deep item reads. */
export interface ItemScheduleContext {
  /** Item deadline when present. */
  deadline: string | null;
  /** Earliest event start, convenient for single-event consumers. */
  start_at: string | null;
  /** End of the earliest event when present. */
  end_at: string | null;
  /** Location of the earliest event when present. */
  location: string | null;
  /** All configured reminders. */
  reminders: Reminder[];
  /** All configured events ordered by start timestamp. */
  events: CalendarEvent[];
}

/** Return whether an item carries or semantically represents schedule data. */
export function itemHasSchedule(item: ItemMetadata): boolean {
  return (
    BUILTIN_SCHEDULE_TYPES.has(item.type.trim().toLowerCase()) ||
    item.deadline !== undefined ||
    (item.reminders?.length ?? 0) > 0 ||
    (item.events?.length ?? 0) > 0
  );
}

/** Build a deterministic schedule facet, or undefined for unscheduled items. */
export function buildItemSchedule(
  item: ItemMetadata,
): ItemScheduleContext | undefined {
  if (!itemHasSchedule(item)) {
    return undefined;
  }
  const events = [...(item.events ?? [])].sort((left, right) =>
    left.start_at.localeCompare(right.start_at),
  );
  const primary = events[0];
  return {
    deadline: item.deadline ?? null,
    start_at: primary?.start_at ?? null,
    end_at: primary?.end_at ?? null,
    location: primary?.location ?? null,
    reminders: [...(item.reminders ?? [])],
    events,
  };
}
