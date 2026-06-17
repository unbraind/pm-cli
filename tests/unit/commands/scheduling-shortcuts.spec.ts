import { describe, expect, it } from "vitest";
import { runEvent, runMeet, runRemind } from "../../../src/cli/commands/scheduling-shortcuts.js";
import type { CalendarEvent, ItemMetadata, Reminder } from "../../../src/types/index.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

function events(item: ItemMetadata): CalendarEvent[] {
  return (item as ItemMetadata & { events?: CalendarEvent[] }).events ?? [];
}

function reminders(item: ItemMetadata): Reminder[] {
  return (item as ItemMetadata & { reminders?: Reminder[] }).reminders ?? [];
}

describe("scheduling shortcuts", () => {
  it("runMeet creates a Meeting with default start=now and duration=1h", async () => {
    await withTempPmPath(async (context) => {
      const result = await runMeet("Sprint Planning", { author: "claude-code-agent" }, { path: context.pmPath });
      expect(result.item.type).toBe("Meeting");
      expect(result.item.title).toBe("Sprint Planning");
      const [event] = events(result.item);
      expect(event).toBeDefined();
      // Default duration 1h => end is one hour after start.
      const span = new Date(event.end_at).getTime() - new Date(event.start_at).getTime();
      expect(span).toBe(60 * 60 * 1000);
      // Meetings are not "worked", so no lifecycle nudge.
      expect(result.next_transition).toBeUndefined();
    });
  });

  it("runMeet honors explicit start/duration/location/timezone/all-day", async () => {
    await withTempPmPath(async (context) => {
      const result = await runMeet(
        "1:1",
        {
          start: "2026-07-01T15:00:00Z",
          duration: "2h",
          location: "Room A, 3rd floor",
          timezone: "America/New_York",
          allDay: true,
        },
        { path: context.pmPath },
      );
      const [event] = events(result.item);
      expect(event.start_at).toBe("2026-07-01T15:00:00.000Z");
      expect(event.end_at).toBe("2026-07-01T17:00:00.000Z");
      expect(event.location).toBe("Room A, 3rd floor");
      expect(event.timezone).toBe("America/New_York");
      expect(event.all_day).toBe(true);
    });
  });

  it("runEvent uses --end when provided, overriding the duration default", async () => {
    await withTempPmPath(async (context) => {
      const result = await runEvent(
        "Release v2",
        { start: "2026-07-01T10:00:00Z", end: "2026-07-01T12:00:00Z" },
        { path: context.pmPath },
      );
      expect(result.item.type).toBe("Event");
      const [event] = events(result.item);
      expect(event.start_at).toBe("2026-07-01T10:00:00.000Z");
      expect(event.end_at).toBe("2026-07-01T12:00:00.000Z");
    });
  });

  it("runRemind creates a Reminder, defaulting text to a comma-bearing title", async () => {
    await withTempPmPath(async (context) => {
      const result = await runRemind("Review PR, then merge", { at: "+2d" }, { path: context.pmPath });
      expect(result.item.type).toBe("Reminder");
      const [reminder] = reminders(result.item);
      // The comma in the title must survive the CSV round-trip via quoting.
      expect(reminder.text).toBe("Review PR, then merge");
      expect(reminder.at).toBeDefined();
    });
  });

  it("runRemind honors explicit --text including embedded quotes", async () => {
    await withTempPmPath(async (context) => {
      const result = await runRemind(
        "ignored title",
        { at: "2026-07-01T09:00:00Z", text: 'Ping the "team" lead' },
        { path: context.pmPath },
      );
      const [reminder] = reminders(result.item);
      expect(reminder.text).toBe('Ping the "team" lead');
      expect(reminder.at).toBe("2026-07-01T09:00:00.000Z");
    });
  });

  it("escapes a trailing backslash so it cannot break out of the quoted CSV field", async () => {
    await withTempPmPath(async (context) => {
      const result = await runRemind(
        "x",
        { at: "2026-09-01T09:00:00Z", text: "evil\\" },
        { path: context.pmPath },
      );
      const reminded = reminders(result.item);
      // The backslash must not escape the closing quote and merge fields:
      // exactly one reminder, with the `at` value intact.
      expect(reminded).toHaveLength(1);
      expect(reminded[0].at).toBe("2026-09-01T09:00:00.000Z");
      expect(reminded[0].text.startsWith("evil")).toBe(true);
    });
  });

  it("forwards common create options (parent inheritance, tags, priority)", async () => {
    await withTempPmPath(async (context) => {
      const parent = await runMeet("Parent meeting", {}, { path: context.pmPath });
      const child = await runRemind(
        "Child reminder",
        {
          parent: parent.item.id,
          tags: "scheduling,demo",
          priority: "1",
          body: "body text",
          description: "a description",
        },
        { path: context.pmPath },
      );
      expect(child.item.parent).toBe(parent.item.id);
      expect(child.item.tags).toEqual(expect.arrayContaining(["scheduling", "demo"]));
      expect(child.item.priority).toBe(1);
    });
  });
});
