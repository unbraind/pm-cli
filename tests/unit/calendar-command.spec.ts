import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  renderCalendarMarkdown,
  resolveCalendarOutputFormat,
  runCalendar,
  type CalendarOptions,
} from "../../src/cli/commands/calendar.js";
import { EXIT_CODE } from "../../src/constants.js";
import { PmCliError } from "../../src/errors.js";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

function createCalendarItem(
  context: TempPmContext,
  options: {
    title: string;
    type?: string;
    status?: string;
    priority?: string;
    tags?: string;
    assignee?: string;
    deadline?: string;
    reminders?: string[];
    sprint?: string;
    release?: string;
  },
): string {
  const createArgs = [
    "create",
    "--json",
    "--title",
    options.title,
    "--description",
    `${options.title} description`,
    "--type",
    options.type ?? "Task",
    "--status",
    options.status ?? "open",
    "--priority",
    options.priority ?? "1",
    "--tags",
    options.tags ?? "calendar,unit",
    "--body",
    "",
    "--deadline",
    options.deadline ?? "none",
    "--estimate",
    "10",
    "--acceptance-criteria",
    "calendar test seed",
    "--author",
    "calendar-test",
    "--message",
    `Create ${options.title}`,
    "--assignee",
    options.assignee ?? "none",
  ];
  if (options.sprint) {
    createArgs.push("--sprint", options.sprint);
  }
  if (options.release) {
    createArgs.push("--release", options.release);
  }
  for (const reminder of options.reminders ?? []) {
    createArgs.push("--reminder", reminder);
  }
  createArgs.push("--dep", "none", "--comment", "none", "--note", "none", "--learning", "none", "--file", "none", "--test", "none", "--doc", "none");
  const result = context.runCli(createArgs, { expectJson: true });
  expect(result.code).toBe(0);
  return (result.json as { item: { id: string } }).item.id;
}

describe("calendar command module", () => {
  it("resolves output format precedence and conflicts", () => {
    expect(resolveCalendarOutputFormat({}, { json: false })).toBe("markdown");
    expect(resolveCalendarOutputFormat({ format: "toon" }, { json: false })).toBe("toon");
    expect(resolveCalendarOutputFormat({ format: "  TOON  " }, { json: false })).toBe("toon");
    expect(resolveCalendarOutputFormat({ format: "json" }, { json: false })).toBe("json");
    expect(resolveCalendarOutputFormat({}, { json: true })).toBe("json");
    expect(resolveCalendarOutputFormat({ format: "json" }, { json: true })).toBe("json");
    expect(() => resolveCalendarOutputFormat({ format: "markdown" }, { json: true })).toThrow(PmCliError);
    expect(() => resolveCalendarOutputFormat({ format: "xml" }, { json: false })).toThrow(PmCliError);
  });

  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-calendar-not-init-"));
    try {
      await expect(runCalendar({}, { path: tempDir })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("builds agenda events deterministically and renders markdown", async () => {
    await withTempPmPath(async (context) => {
      createCalendarItem(context, {
        title: "Calendar agenda seed",
        deadline: "2026-04-02T12:00:00.000Z",
        reminders: ["at=2026-04-02T09:30:00.000Z,text=calendar reminder"],
      });

      const result = await runCalendar(
        {
          view: "agenda",
          from: "2026-04-02T00:00:00.000Z",
          to: "2026-04-03T00:00:00.000Z",
        },
        { path: context.pmPath },
      );

      expect(result.view).toBe("agenda");
      expect(result.summary.events).toBe(2);
      expect(result.summary.deadlines).toBe(1);
      expect(result.summary.reminders).toBe(1);
      expect(result.events.map((event) => event.kind)).toEqual(["reminder", "deadline"]);
      expect(result.days).toHaveLength(1);

      const markdown = renderCalendarMarkdown(result);
      expect(markdown).toContain("# pm calendar (agenda)");
      expect(markdown).toContain("[reminder]");
      expect(markdown).toContain("[deadline]");
      expect(markdown).toContain("calendar reminder");
    });
  });

  it("applies filters and event limits", async () => {
    await withTempPmPath(async (context) => {
      createCalendarItem(context, {
        title: "Filter match item",
        type: "Task",
        status: "open",
        priority: "1",
        tags: "calendar,match",
        assignee: "agent-a",
        sprint: "sprint-7",
        release: "vnext",
        deadline: "2026-04-05T09:00:00.000Z",
        reminders: ["at=2026-04-05T08:00:00.000Z,text=match reminder"],
      });
      createCalendarItem(context, {
        title: "Filter non-match item",
        type: "Issue",
        status: "blocked",
        priority: "4",
        tags: "calendar,other",
        assignee: "agent-b",
        deadline: "2026-04-05T10:00:00.000Z",
      });
      createCalendarItem(context, {
        title: "Filter priority-mismatch item",
        type: "Task",
        status: "open",
        priority: "2",
        tags: "calendar,match",
        assignee: "agent-a",
        sprint: "sprint-7",
        release: "vnext",
        deadline: "2026-04-05T11:00:00.000Z",
      });

      const result = await runCalendar(
        {
          view: "agenda",
          from: "2026-04-05T00:00:00.000Z",
          to: "2026-04-06T00:00:00.000Z",
          type: "Task",
          status: "open",
          assignee: "agent-a",
          sprint: "sprint-7",
          release: "vnext",
          tag: "match",
          priority: "1",
          limit: "1",
        },
        { path: context.pmPath },
      );

      expect(result.summary.events).toBe(1);
      expect(result.events).toHaveLength(1);
      expect(result.events[0]?.item_title).toBe("Filter match item");

      const statusMismatch = await runCalendar(
        {
          view: "agenda",
          from: "2026-04-05T00:00:00.000Z",
          to: "2026-04-06T00:00:00.000Z",
          type: "Task",
          status: "blocked",
        },
        { path: context.pmPath },
      );
      expect(statusMismatch.summary.events).toBe(0);

      const sprintMismatch = await runCalendar(
        {
          view: "agenda",
          from: "2026-04-05T00:00:00.000Z",
          to: "2026-04-06T00:00:00.000Z",
          type: "Task",
          status: "open",
          assignee: "agent-a",
          sprint: "sprint-mismatch",
        },
        { path: context.pmPath },
      );
      expect(sprintMismatch.summary.events).toBe(0);

      const releaseMismatch = await runCalendar(
        {
          view: "agenda",
          from: "2026-04-05T00:00:00.000Z",
          to: "2026-04-06T00:00:00.000Z",
          type: "Task",
          status: "open",
          assignee: "agent-a",
          sprint: "sprint-7",
          release: "v-legacy",
        },
        { path: context.pmPath },
      );
      expect(releaseMismatch.summary.events).toBe(0);
    });
  });

  it("handles default agenda behavior assignee branches and empty markdown state", async () => {
    await withTempPmPath(async (context) => {
      createCalendarItem(context, {
        title: "Assigned calendar item",
        assignee: "agent-a",
        deadline: "2099-04-05T09:00:00.000Z",
      });
      createCalendarItem(context, {
        title: "Unassigned calendar item",
        assignee: "none",
        deadline: "2099-04-05T10:00:00.000Z",
      });

      const defaultAgenda = await runCalendar({}, { path: context.pmPath });
      expect(defaultAgenda.view).toBe("agenda");
      expect(defaultAgenda.summary.events).toBe(2);

      const datedAgenda = await runCalendar(
        {
          view: "agenda",
          date: "2099-04-05T00:00:00.000Z",
          to: "2099-04-06T00:00:00.000Z",
        },
        { path: context.pmPath },
      );
      expect(datedAgenda.range.start).toBe("2099-04-05T00:00:00.000Z");

      const unassignedOnly = await runCalendar(
        {
          view: "agenda",
          from: "2099-04-05T00:00:00.000Z",
          to: "2099-04-06T00:00:00.000Z",
          assignee: "none",
        },
        { path: context.pmPath },
      );
      expect(unassignedOnly.summary.events).toBe(1);
      expect(unassignedOnly.events[0]?.item_title).toBe("Unassigned calendar item");

      const missingAssignee = await runCalendar(
        {
          view: "agenda",
          from: "2099-04-05T00:00:00.000Z",
          to: "2099-04-06T00:00:00.000Z",
          assignee: "agent-z",
        },
        { path: context.pmPath },
      );
      expect(missingAssignee.summary.events).toBe(0);
      expect(renderCalendarMarkdown(missingAssignee)).toContain("No calendar events matched the selected filters.");

      const agendaWithPast = await runCalendar(
        { view: "agenda", past: true, limit: "0" },
        { path: context.pmPath },
      );
      expect(agendaWithPast.range.start).toBeNull();
      expect(agendaWithPast.summary.events).toBe(0);
      expect(renderCalendarMarkdown(agendaWithPast)).toContain("window: none -> none");
    });
  });

  it("handles day/week/month windows and past toggles", async () => {
    await withTempPmPath(async (context) => {
      createCalendarItem(context, {
        title: "Past day seed",
        deadline: "2000-01-01T09:00:00.000Z",
        reminders: ["at=2000-01-01T08:00:00.000Z,text=past reminder"],
      });
      createCalendarItem(context, {
        title: "Past week seed",
        deadline: "2000-01-03T09:00:00.000Z",
      });

      const dayWithoutPast = await runCalendar(
        { view: "day", date: "2000-01-01T00:00:00.000Z" },
        { path: context.pmPath },
      );
      expect(dayWithoutPast.summary.events).toBe(0);

      const futureDayWithoutPast = await runCalendar(
        { view: "day", date: "2099-01-01T12:00:00.000Z" },
        { path: context.pmPath },
      );
      expect(futureDayWithoutPast.range.start).toBe("2099-01-01T00:00:00.000Z");
      expect(futureDayWithoutPast.range.end).toBe("2099-01-02T00:00:00.000Z");

      const dayWithPast = await runCalendar(
        { view: "day", date: "2000-01-01T00:00:00.000Z", past: true },
        { path: context.pmPath },
      );
      expect(dayWithPast.summary.events).toBe(2);

      const weekWithPast = await runCalendar(
        { view: "week", date: "2000-01-01T00:00:00.000Z", past: true },
        { path: context.pmPath },
      );
      expect(weekWithPast.summary.events).toBe(2);

      const weekWithoutPast = await runCalendar(
        { view: "week", date: "2000-01-01T00:00:00.000Z" },
        { path: context.pmPath },
      );
      expect(weekWithoutPast.summary.events).toBe(0);

      const monthWithPast = await runCalendar(
        { view: "month", date: "2000-01-01T00:00:00.000Z", past: true },
        { path: context.pmPath },
      );
      expect(monthWithPast.summary.events).toBe(3);

      const monthWithoutPast = await runCalendar(
        { view: "month", date: "2000-01-01T00:00:00.000Z" },
        { path: context.pmPath },
      );
      expect(monthWithoutPast.summary.events).toBe(0);
    });
  });

  it("keeps range boundaries and event ordering deterministic", async () => {
    await withTempPmPath(async (context) => {
      createCalendarItem(context, {
        title: "Ordering low-priority seed",
        tags: "calendar,ordering",
        priority: "1",
        deadline: "2026-05-01T10:00:00.000Z",
      });
      createCalendarItem(context, {
        title: "Ordering high-priority seed",
        tags: "calendar,ordering",
        priority: "0",
        deadline: "2026-05-01T10:00:00.000Z",
      });
      createCalendarItem(context, {
        title: "Ordering mixed seed",
        tags: "calendar,ordering",
        deadline: "2026-05-01T10:00:00.000Z",
        reminders: [
          "at=2026-05-01T10:00:00.000Z,text=beta reminder",
          "at=2026-05-01T10:00:00.000Z,text=alpha reminder",
        ],
      });
      createCalendarItem(context, {
        title: "Ordering reminder-only seed",
        tags: "calendar,ordering",
        reminders: [
          "at=2026-05-01T10:00:00.000Z,text=zeta reminder",
          "at=2026-05-01T10:00:00.000Z,text=alpha reminder",
        ],
      });
      createCalendarItem(context, {
        title: "Ordering before-window seed",
        tags: "calendar,ordering",
        deadline: "2026-04-30T23:59:59.000Z",
      });
      createCalendarItem(context, {
        title: "Ordering end-window seed",
        tags: "calendar,ordering",
        deadline: "2026-05-02T00:00:00.000Z",
      });
      createCalendarItem(context, {
        title: "Sunday week boundary seed",
        tags: "calendar,sunday-week",
        deadline: "1999-12-27T09:00:00.000Z",
      });
      createCalendarItem(context, {
        title: "Reminder text sort seed",
        tags: "calendar,reminder-only",
        reminders: [
          "at=2026-05-03T10:00:00.000Z,text=zulu reminder",
          "at=2026-05-03T10:00:00.000Z,text=alpha reminder",
        ],
      });

      const orderingResult = await runCalendar(
        {
          view: "agenda",
          from: "2026-05-01T00:00:00.000Z",
          to: "2026-05-02T00:00:00.000Z",
          tag: "ordering",
        },
        { path: context.pmPath },
      );

      expect(orderingResult.events.some((event) => event.item_title === "Ordering before-window seed")).toBe(false);
      expect(orderingResult.events.some((event) => event.item_title === "Ordering end-window seed")).toBe(false);

      const atTen = orderingResult.events.filter((event) => event.at === "2026-05-01T10:00:00.000Z");
      expect(atTen[0]?.item_title).toBe("Ordering high-priority seed");

      const samePriorityDeadlineIds = atTen
        .filter((event) => event.kind === "deadline" && event.item_priority === 1)
        .map((event) => event.item_id);
      expect(samePriorityDeadlineIds).toHaveLength(2);
      expect(samePriorityDeadlineIds).toEqual(
        [...samePriorityDeadlineIds].sort((left, right) => left.localeCompare(right)),
      );

      const mixedSequence = atTen
        .filter((event) => event.item_title === "Ordering mixed seed")
        .map((event) => `${event.kind}:${event.reminder_text ?? ""}`);
      expect(mixedSequence).toEqual(["deadline:", "reminder:alpha reminder", "reminder:beta reminder"]);

      const reminderOnly = atTen.filter((event) => event.item_title === "Ordering reminder-only seed");
      expect(reminderOnly.map((event) => event.kind)).toEqual(["reminder", "reminder"]);
      expect(reminderOnly.map((event) => event.item_deadline)).toEqual([null, null]);
      expect(reminderOnly.map((event) => event.reminder_text)).toEqual(["alpha reminder", "zeta reminder"]);

      const sundayWeek = await runCalendar(
        {
          view: "week",
          date: "2000-01-02T12:00:00.000Z",
          past: true,
          tag: "sunday-week",
        },
        { path: context.pmPath },
      );
      expect(sundayWeek.summary.events).toBe(1);
      expect(sundayWeek.events[0]?.item_title).toBe("Sunday week boundary seed");

      const reminderOnlySort = await runCalendar(
        {
          view: "agenda",
          from: "2026-05-03T00:00:00.000Z",
          to: "2026-05-04T00:00:00.000Z",
          tag: "reminder-only",
        },
        { path: context.pmPath },
      );
      expect(reminderOnlySort.events.map((event) => event.reminder_text)).toEqual([
        "alpha reminder",
        "zulu reminder",
      ]);
    });
  });

  it("validates calendar option contracts", async () => {
    await withTempPmPath(async (context) => {
      createCalendarItem(context, {
        title: "Validation seed",
        deadline: "2026-04-10T10:00:00.000Z",
      });

      const invalidCases: CalendarOptions[] = [
        { view: "quarter" },
        { view: "agenda", from: "2026-04-10T10:00:00.000Z", to: "2026-04-10T10:00:00.000Z" },
        { view: "day", from: "2026-04-10T00:00:00.000Z" },
        { view: "agenda", type: "bug" },
        { view: "agenda", status: "doing" },
        { view: "agenda", priority: "9" },
        { view: "agenda", limit: "-1" },
      ];

      for (const options of invalidCases) {
        await expect(runCalendar(options, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
          exitCode: EXIT_CODE.USAGE,
        });
      }
    });
  });
});
