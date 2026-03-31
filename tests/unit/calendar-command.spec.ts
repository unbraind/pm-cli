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
    events?: string[];
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
  for (const event of options.events ?? []) {
    createArgs.push("--event", event);
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

  it("expands one-off and recurring events in agenda output", async () => {
    await withTempPmPath(async (context) => {
      createCalendarItem(context, {
        title: "One-off event seed",
        events: ["start=2026-04-02T14:00:00.000Z,title=One-off demo"],
      });
      createCalendarItem(context, {
        title: "Recurring event seed",
        events: ["start=2026-04-01T10:00:00.000Z,title=Weekly sync,recur_freq=weekly,recur_by_weekday=wed|fri,recur_count=4"],
      });

      const result = await runCalendar(
        {
          view: "agenda",
          from: "2026-04-01T00:00:00.000Z",
          to: "2026-04-10T00:00:00.000Z",
        },
        { path: context.pmPath },
      );

      expect(result.summary.events).toBe(4);
      expect(result.summary.deadlines).toBe(0);
      expect(result.summary.reminders).toBe(0);
      expect(result.summary.scheduled).toBe(4);
      expect(result.events.every((event) => event.kind === "event")).toBe(true);

      const recurring = result.events.filter((event) => event.event_recurring === true);
      expect(recurring).toHaveLength(3);
      expect(recurring.map((event) => event.at)).toEqual([
        "2026-04-01T10:00:00.000Z",
        "2026-04-03T10:00:00.000Z",
        "2026-04-08T10:00:00.000Z",
      ]);

      const oneOff = result.events.find((event) => event.event_recurring === false);
      expect(oneOff?.at).toBe("2026-04-02T14:00:00.000Z");
      expect(oneOff?.event_title).toBe("One-off demo");

      const markdown = renderCalendarMarkdown(result);
      expect(markdown).toContain("[event]");
      expect(markdown).toContain("(recurring)");
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

  it("supports source include filters and recurrence bounding controls", async () => {
    await withTempPmPath(async (context) => {
      createCalendarItem(context, {
        title: "Include controls seed",
        tags: "calendar,include-controls",
        deadline: "2026-04-06T09:00:00.000Z",
        reminders: ["at=2026-04-06T08:30:00.000Z,text=reminder seed"],
        events: ["start=2026-04-06T10:00:00.000Z,title=event seed"],
      });
      createCalendarItem(context, {
        title: "Recurring controls seed",
        tags: "calendar,recurrence-controls",
        events: ["start=2026-04-01T09:00:00.000Z,title=daily recurring,recur_freq=daily,recur_count=10"],
      });

      const deadlinesOnly = await runCalendar(
        {
          view: "agenda",
          from: "2026-04-06T00:00:00.000Z",
          to: "2026-04-07T00:00:00.000Z",
          include: "deadlines",
        },
        { path: context.pmPath },
      );
      expect(deadlinesOnly.summary.events).toBe(1);
      expect(deadlinesOnly.events.every((event) => event.kind === "deadline")).toBe(true);

      const remindersOnly = await runCalendar(
        {
          view: "agenda",
          from: "2026-04-06T00:00:00.000Z",
          to: "2026-04-07T00:00:00.000Z",
          include: "reminders",
        },
        { path: context.pmPath },
      );
      expect(remindersOnly.summary.events).toBe(1);
      expect(remindersOnly.events.every((event) => event.kind === "reminder")).toBe(true);

      const eventsOnly = await runCalendar(
        {
          view: "agenda",
          from: "2026-04-06T00:00:00.000Z",
          to: "2026-04-07T00:00:00.000Z",
          include: "events",
        },
        { path: context.pmPath },
      );
      expect(eventsOnly.summary.events).toBe(2);
      expect(eventsOnly.events.every((event) => event.kind === "event")).toBe(true);

      const allSources = await runCalendar(
        {
          view: "agenda",
          from: "2026-04-06T00:00:00.000Z",
          to: "2026-04-07T00:00:00.000Z",
          include: "all",
          tag: "include-controls",
        },
        { path: context.pmPath },
      );
      expect(allSources.summary.events).toBe(3);
      expect(new Set(allSources.events.map((event) => event.kind))).toEqual(new Set(["deadline", "reminder", "event"]));

      const boundedLookahead = await runCalendar(
        {
          view: "agenda",
          from: "2026-04-01T00:00:00.000Z",
          include: "events",
          recurrenceLookaheadDays: "2",
          tag: "recurrence-controls",
        },
        { path: context.pmPath },
      );
      expect(boundedLookahead.events.map((event) => event.at)).toEqual([
        "2026-04-01T09:00:00.000Z",
        "2026-04-02T09:00:00.000Z",
      ]);

      const boundedOccurrenceLimit = await runCalendar(
        {
          view: "agenda",
          from: "2026-04-01T00:00:00.000Z",
          include: "events",
          recurrenceLookaheadDays: "10",
          occurrenceLimit: "2",
          tag: "recurrence-controls",
        },
        { path: context.pmPath },
      );
      expect(boundedOccurrenceLimit.events).toHaveLength(2);
    });
  });

  it("covers recurrence expansion edge branches across frequencies", async () => {
    await withTempPmPath(async (context) => {
      createCalendarItem(context, {
        title: "Weekly month-day filter seed",
        tags: "calendar,recurrence-weekly-edges",
        events: [
          "start=2026-03-30T09:00:00.000Z,title=weekly filtered,recur_freq=weekly,recur_by_weekday=mon|tue,recur_by_month_day=1",
        ],
      });
      createCalendarItem(context, {
        title: "Daily count-stop seed",
        tags: "calendar,recurrence-count-stop",
        events: ["start=2026-04-01T09:00:00.000Z,title=daily count stop,recur_freq=daily,recur_count=1"],
      });
      createCalendarItem(context, {
        title: "Monthly stop seed",
        tags: "calendar,recurrence-monthly-stop",
        events: [
          "start=2026-01-31T09:00:00.000Z,title=monthly stop,recur_freq=monthly,recur_by_month_day=31|30,recur_by_weekday=mon,recur_count=1",
        ],
      });
      createCalendarItem(context, {
        title: "Monthly return seed",
        tags: "calendar,recurrence-monthly-return",
        events: ["start=2026-04-30T09:00:00.000Z,title=monthly return,recur_freq=monthly,recur_by_month_day=31"],
      });
      createCalendarItem(context, {
        title: "Monthly continue seed",
        tags: "calendar,recurrence-monthly-continue",
        events: ["start=2026-01-01T09:00:00.000Z,title=monthly continue,recur_freq=monthly,recur_by_month_day=1,recur_count=4"],
      });
      createCalendarItem(context, {
        title: "Yearly return seed",
        tags: "calendar,recurrence-yearly-return",
        events: [
          "start=2023-02-28T09:00:00.000Z,title=yearly return,recur_freq=yearly,recur_by_month_day=28|29,recur_by_weekday=sun",
        ],
      });
      createCalendarItem(context, {
        title: "Yearly continue seed",
        tags: "calendar,recurrence-yearly-continue",
        events: [
          "start=2024-02-29T09:00:00.000Z,title=yearly continue,recur_freq=yearly,recur_by_month_day=29,recur_count=2",
        ],
      });
      createCalendarItem(context, {
        title: "Yearly stop seed",
        tags: "calendar,recurrence-yearly-stop",
        events: [
          "start=2024-02-29T09:00:00.000Z,title=yearly stop,recur_freq=yearly,recur_by_month_day=29,recur_by_weekday=thu,recur_count=1",
        ],
      });
      createCalendarItem(context, {
        title: "Candidate before start seed",
        tags: "calendar,recurrence-before-start",
        events: [
          "start=2026-04-08T09:00:00.000Z,title=before start,recur_freq=weekly,recur_by_weekday=mon|wed,recur_count=2",
        ],
      });
      createCalendarItem(context, {
        title: "Until stop seed",
        tags: "calendar,recurrence-until-stop",
        events: [
          "start=2026-04-01T09:00:00.000Z,title=until stop,recur_freq=daily,recur_until=2026-04-02T09:00:00.000Z",
        ],
      });
      createCalendarItem(context, {
        title: "Excluded dates seed",
        tags: "calendar,recurrence-excluded",
        events: [
          "start=2026-04-01T09:00:00.000Z,title=excluded dates,recur_freq=daily,recur_count=3,recur_exdates=2026-04-01T09:00:00.000Z|2026-04-03T09:00:00.000Z",
        ],
      });
      createCalendarItem(context, {
        title: "Daily filter seed",
        tags: "calendar,recurrence-daily-filters",
        events: ["start=2026-04-01T09:00:00.000Z,title=daily filter,recur_freq=daily,recur_by_weekday=thu,recur_by_month_day=2,recur_count=2"],
      });
      createCalendarItem(context, {
        title: "Event title ordering seed",
        tags: "calendar,event-title-ordering",
        events: [
          "start=2026-04-20T10:00:00.000Z,title=Zulu event",
          "start=2026-04-20T10:00:00.000Z,title=Alpha event,location=Room A",
          "start=2026-04-20T11:00:00.000Z,location=Room B",
        ],
      });

      const weeklyEdge = await runCalendar(
        {
          view: "agenda",
          from: "2026-03-30T00:00:00.000Z",
          to: "2026-04-02T00:00:00.000Z",
          include: "events",
          tag: "recurrence-weekly-edges",
          occurrenceLimit: "1",
        },
        { path: context.pmPath },
      );
      expect(weeklyEdge.summary.events).toBe(0);

      const dailyCountStop = await runCalendar(
        {
          view: "agenda",
          from: "2026-04-01T00:00:00.000Z",
          to: "2026-04-03T00:00:00.000Z",
          include: "events",
          tag: "recurrence-count-stop",
        },
        { path: context.pmPath },
      );
      expect(dailyCountStop.events.map((event) => event.at)).toEqual(["2026-04-01T09:00:00.000Z"]);

      const monthlyStop = await runCalendar(
        {
          view: "agenda",
          from: "2026-01-01T00:00:00.000Z",
          to: "2026-04-01T00:00:00.000Z",
          include: "events",
          tag: "recurrence-monthly-stop",
        },
        { path: context.pmPath },
      );
      expect(monthlyStop.events.map((event) => event.at)).toEqual(["2026-03-30T09:00:00.000Z"]);

      const monthlyReturn = await runCalendar(
        {
          view: "agenda",
          from: "2026-04-01T00:00:00.000Z",
          to: "2026-05-01T00:00:00.000Z",
          include: "events",
          tag: "recurrence-monthly-return",
          occurrenceLimit: "1",
        },
        { path: context.pmPath },
      );
      expect(monthlyReturn.summary.events).toBe(0);

      const monthlyContinue = await runCalendar(
        {
          view: "agenda",
          from: "2026-01-01T00:00:00.000Z",
          to: "2026-04-01T00:00:00.000Z",
          include: "events",
          tag: "recurrence-monthly-continue",
        },
        { path: context.pmPath },
      );
      expect(monthlyContinue.events.map((event) => event.at)).toEqual([
        "2026-01-01T09:00:00.000Z",
        "2026-02-01T09:00:00.000Z",
        "2026-03-01T09:00:00.000Z",
      ]);

      const yearlyReturn = await runCalendar(
        {
          view: "agenda",
          from: "2023-01-01T00:00:00.000Z",
          to: "2024-01-01T00:00:00.000Z",
          include: "events",
          tag: "recurrence-yearly-return",
          occurrenceLimit: "1",
        },
        { path: context.pmPath },
      );
      expect(yearlyReturn.summary.events).toBe(0);

      const yearlyContinue = await runCalendar(
        {
          view: "agenda",
          from: "2024-01-01T00:00:00.000Z",
          to: "2029-01-01T00:00:00.000Z",
          include: "events",
          tag: "recurrence-yearly-continue",
          occurrenceLimit: "2",
        },
        { path: context.pmPath },
      );
      expect(yearlyContinue.events.map((event) => event.at)).toEqual(["2024-02-29T09:00:00.000Z"]);

      const yearlyStop = await runCalendar(
        {
          view: "agenda",
          from: "2024-01-01T00:00:00.000Z",
          to: "2025-01-01T00:00:00.000Z",
          include: "events",
          tag: "recurrence-yearly-stop",
        },
        { path: context.pmPath },
      );
      expect(yearlyStop.events.map((event) => event.at)).toEqual(["2024-02-29T09:00:00.000Z"]);

      const beforeStart = await runCalendar(
        {
          view: "agenda",
          from: "2026-04-06T00:00:00.000Z",
          to: "2026-04-15T00:00:00.000Z",
          include: "events",
          tag: "recurrence-before-start",
        },
        { path: context.pmPath },
      );
      expect(beforeStart.events.map((event) => event.at)).toEqual([
        "2026-04-08T09:00:00.000Z",
        "2026-04-13T09:00:00.000Z",
      ]);

      const untilStop = await runCalendar(
        {
          view: "agenda",
          from: "2026-04-01T00:00:00.000Z",
          to: "2026-04-10T00:00:00.000Z",
          include: "events",
          tag: "recurrence-until-stop",
        },
        { path: context.pmPath },
      );
      expect(untilStop.events.map((event) => event.at)).toEqual([
        "2026-04-01T09:00:00.000Z",
        "2026-04-02T09:00:00.000Z",
      ]);

      const excludedDates = await runCalendar(
        {
          view: "agenda",
          from: "2026-04-01T00:00:00.000Z",
          to: "2026-04-10T00:00:00.000Z",
          include: "events",
          tag: "recurrence-excluded",
        },
        { path: context.pmPath },
      );
      expect(excludedDates.events.map((event) => event.at)).toEqual([
        "2026-04-02T09:00:00.000Z",
        "2026-04-04T09:00:00.000Z",
        "2026-04-05T09:00:00.000Z",
      ]);

      const dailyFilters = await runCalendar(
        {
          view: "agenda",
          from: "2026-04-01T00:00:00.000Z",
          to: "2026-04-05T00:00:00.000Z",
          include: "events",
          tag: "recurrence-daily-filters",
        },
        { path: context.pmPath },
      );
      expect(dailyFilters.events.map((event) => event.at)).toEqual(["2026-04-02T09:00:00.000Z"]);

      const titleOrdering = await runCalendar(
        {
          view: "agenda",
          from: "2026-04-20T00:00:00.000Z",
          to: "2026-04-21T00:00:00.000Z",
          include: "events",
          tag: "event-title-ordering",
        },
        { path: context.pmPath },
      );
      const firstDayEvents = titleOrdering.events.filter((event) => event.at === "2026-04-20T10:00:00.000Z");
      expect(firstDayEvents.map((event) => event.event_title)).toEqual(["Alpha event", "Zulu event"]);
      expect(titleOrdering.events[2]?.event_title).toBe("Event title ordering seed");

      const titleOrderingMarkdown = renderCalendarMarkdown(titleOrdering);
      expect(titleOrderingMarkdown).toContain("Event title ordering seed");
      expect(titleOrderingMarkdown).toContain("@ Room B");
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
        { view: "agenda", include: "deadlines|unknown" },
        { view: "agenda", include: " , | " },
        { view: "agenda", recurrenceLookaheadDays: "-3" },
        { view: "agenda", recurrenceLookbackDays: "-2" },
        { view: "agenda", occurrenceLimit: "0" },
      ];

      for (const options of invalidCases) {
        await expect(runCalendar(options, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
          exitCode: EXIT_CODE.USAGE,
        });
      }
    });
  });
});
