import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  NEXT_OUTPUT_VALUES,
  renderNextMarkdown,
  resolveNextOutputFormat,
  runNext,
  type NextResult,
} from "../../../src/cli/commands/next.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import { withTempPmPath, type TempPmContext } from "../../helpers/withTempPmPath.js";

interface CreateItemOptions {
  title: string;
  type?: string;
  status?: string;
  priority?: string;
  parent?: string;
  deadline?: string;
  blockedBy?: string;
  dep?: string;
}

function createItem(context: TempPmContext, options: CreateItemOptions): string {
  const args = [
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
    options.priority ?? "2",
    "--body",
    "",
  ];
  if (options.parent) args.push("--parent", options.parent);
  if (options.deadline) args.push("--deadline", options.deadline);
  if (options.blockedBy) args.push("--blocked-by", options.blockedBy);
  if (options.dep) args.push("--dep", options.dep);
  const created = context.runCli(args, { expectJson: true });
  expect(created.code).toBe(0);
  return (created.json as { item: { id: string } }).item.id;
}

// Deadlines are computed relative to the real clock with whole-day margin so the
// floored relative-day bucket (overdue / today / in Nd) is stable regardless of
// the time of day the test runs.
function deadlineOffsetMs(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}
const DAY_MS = 24 * 60 * 60 * 1000;

describe("resolveNextOutputFormat", () => {
  it("exposes the supported output formats", () => {
    expect([...NEXT_OUTPUT_VALUES]).toEqual(["markdown", "toon", "json"]);
  });

  it("defaults to toon and honours an explicit command format", () => {
    expect(resolveNextOutputFormat({}, {})).toBe("toon");
    expect(resolveNextOutputFormat({ format: "MARKDOWN" }, {})).toBe("markdown");
  });

  it("forces json under global --json and rejects a conflicting command format", () => {
    expect(resolveNextOutputFormat({}, { json: true })).toBe("json");
    expect(resolveNextOutputFormat({ format: "json" }, { json: true })).toBe("json");
    expect(() => resolveNextOutputFormat({ format: "toon" }, { json: true })).toThrow(/Cannot combine --json/);
  });

  it("rejects an unknown command format", () => {
    expect(() => resolveNextOutputFormat({ format: "yaml" }, {})).toThrow(/markdown\|toon\|json/);
  });
});

describe("runNext", () => {
  it("recommends in-progress work first, ranks ready leaves, and lists blocked leaves with their blockers", async () => {
    await withTempPmPath(async (context) => {
      const epic = createItem(context, { title: "Build auth", type: "Epic" });
      const child = createItem(context, { title: "Design schema", parent: epic, priority: "1" });
      const blocker = createItem(context, { title: "Provision DB", priority: "0" });
      const blockee = createItem(context, { title: "Run migration", priority: "0", dep: `id=${blocker},kind=blocked_by` });
      const wip = createItem(context, { title: "Already underway", priority: "2" });
      context.runCli(["update", wip, "--status", "in_progress", "--json"], { expectJson: true });

      const result = await runNext({}, { path: context.pmPath });

      expect(result.recommended?.id).toBe(wip);
      expect(result.recommended?.reasons).toContain("in progress — resume to finish");
      const readyIds = result.ready.map((entry) => entry.id);
      expect(readyIds).toContain(child);
      expect(readyIds).toContain(blocker);
      expect(readyIds).not.toContain(epic);
      expect(readyIds).not.toContain(blockee);

      const blockerRow = result.ready.find((entry) => entry.id === blocker);
      expect(blockerRow?.unblocks).toEqual([blockee]);

      expect(result.blocked.map((entry) => entry.id)).toEqual([blockee]);
      expect(result.blocked[0].blockers).toEqual([
        { id: blocker, title: "Provision DB", status: "open" },
      ]);
      expect(result.summary).toMatchObject({ recommended: true, in_progress: 1, containers: 1 });
    });
  });

  it("rationalises an open recommendation with priority, deadline, parent, resolved blockers, and downstream unblocks", async () => {
    await withTempPmPath(async (context) => {
      const epic = createItem(context, { title: "Parent epic", type: "Epic" });
      const doneBlocker = createItem(context, { title: "Already done", status: "open" });
      context.runCli(["close", doneBlocker, "done", "--json"], { expectJson: true });
      const focus = createItem(context, {
        title: "Focus task",
        priority: "0",
        parent: epic,
        deadline: deadlineOffsetMs(5 * DAY_MS),
        dep: `id=${doneBlocker},kind=blocked_by`,
      });
      createItem(context, { title: "Downstream", dep: `id=${focus},kind=blocked_by` });

      const result = await runNext({}, { path: context.pmPath });
      expect(result.recommended?.id).toBe(focus);
      const reasons = result.recommended?.reasons ?? [];
      expect(reasons).toContain("open and ready to start");
      expect(reasons).toContain("priority p0 (highest)");
      expect(reasons).toContain("all blockers resolved");
      expect(reasons).toContain(`advances ${epic}`);
      expect(reasons.some((reason) => reason.startsWith("deadline ") && reason.includes("(in "))).toBe(true);
      expect(reasons.some((reason) => reason.startsWith("unblocks 1 item(s):"))).toBe(true);
    });
  });

  it("renders overdue and due-today deadline rationales", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, { title: "Overdue task", priority: "0", deadline: deadlineOffsetMs(-5 * DAY_MS) });
      const overdue = await runNext({}, { path: context.pmPath });
      expect(overdue.recommended?.reasons.some((reason) => reason.includes("(overdue "))).toBe(true);
    });
    await withTempPmPath(async (context) => {
      // A date-only deadline of today resolves to today's UTC midnight, so the
      // calendar-date delta is exactly 0 regardless of the wall-clock time.
      const todayDate = new Date(Date.now()).toISOString().slice(0, 10);
      createItem(context, { title: "Due today", priority: "0", deadline: todayDate });
      const today = await runNext({}, { path: context.pmPath });
      expect(today.recommended?.reasons.some((reason) => reason.includes("(due today)"))).toBe(true);
    });
  });

  it("ranks multiple blocked leaves by criticality", async () => {
    await withTempPmPath(async (context) => {
      const blocker = createItem(context, { title: "Shared blocker" });
      const high = createItem(context, { title: "High blocked", priority: "0", dep: `id=${blocker},kind=blocked_by` });
      const low = createItem(context, { title: "Low blocked", priority: "3", dep: `id=${blocker},kind=blocked_by` });
      const result = await runNext({}, { path: context.pmPath });
      // The shared blocker is the only ready leaf; both dependents are blocked and
      // ranked p0 before p3.
      expect(result.blocked.map((entry) => entry.id)).toEqual([high, low]);
      expect(result.recommended?.id).toBe(blocker);
    });
  });

  it("scopes to a parent subtree, honours --limit/--blocked-limit, and --ready-only", async () => {
    await withTempPmPath(async (context) => {
      const epic = createItem(context, { title: "Scoped epic", type: "Epic" });
      const inSubtree = createItem(context, { title: "Subtree leaf", parent: epic });
      createItem(context, { title: "Outside leaf" });
      const scoped = await runNext({ parent: epic }, { path: context.pmPath });
      expect(scoped.ready.map((entry) => entry.id)).toEqual([inSubtree]);
      expect(scoped.filters.parent).toBe(epic);

      const limited = await runNext({ limit: "1" }, { path: context.pmPath });
      expect(limited.ready).toHaveLength(1);
      expect(limited.filters.limit).toBe(1);
      // An omitted --blocked-limit defaults to the resolved --limit.
      expect(limited.filters.blocked_limit).toBe(1);

      // A non-positive --limit falls back to the default cap (surfaces both ready leaves).
      const zeroLimit = await runNext({ limit: "0" }, { path: context.pmPath });
      expect(zeroLimit.filters.limit).toBe(5);
      expect(zeroLimit.ready).toHaveLength(2);

      const readyOnly = await runNext({ readyOnly: true }, { path: context.pmPath });
      expect(readyOnly.filters.ready_only).toBe(true);
      expect(readyOnly.blocked).toHaveLength(0);
    });
  });

  it("rejects an unknown --parent and an invalid --limit", async () => {
    await withTempPmPath(async (context) => {
      await expect(runNext({ parent: "pm-missing" }, { path: context.pmPath })).rejects.toMatchObject<Partial<PmCliError>>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
      await expect(runNext({ limit: "abc" }, { path: context.pmPath })).rejects.toMatchObject<Partial<PmCliError>>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("suggests creating work when nothing is actionable and points at the blocker otherwise", async () => {
    await withTempPmPath(async (context) => {
      const empty = await runNext({}, { path: context.pmPath });
      expect(empty.recommended).toBeNull();
      expect(empty.suggestions?.[0]).toContain("pm create");

      const blocker = createItem(context, { title: "Hard blocker" });
      createItem(context, { title: "Waiting work", dep: `id=${blocker},kind=blocked_by` });
      context.runCli(["update", blocker, "--status", "blocked", "--json"], { expectJson: true });
      const blockedOnly = await runNext({}, { path: context.pmPath });
      expect(blockedOnly.recommended).toBeNull();
      expect(blockedOnly.suggestions?.[0]).toContain(`closing ${blocker}`);
    });
  });

  it("propagates de-duplicated, sorted parse warnings from the corpus reads", async () => {
    await withTempPmPath(async (context) => {
      const tasksDir = path.join(context.pmPath, "tasks");
      await writeFile(path.join(tasksDir, "invalid-a.toon"), "id: invalid-a\nstatus: open\n", "utf8");
      await writeFile(path.join(tasksDir, "invalid-b.toon"), "this is not toon front matter\n", "utf8");
      const result = await runNext({}, { path: context.pmPath });
      expect(result.warnings?.length ?? 0).toBeGreaterThanOrEqual(2);
      expect(result.warnings).toEqual([...(result.warnings ?? [])].sort((left, right) => left.localeCompare(right)));
    });
  });
});

function nextResult(overrides: Partial<NextResult>): NextResult {
  return {
    output_default: "toon",
    now: "2026-06-24T12:00:00.000Z",
    recommended: null,
    ready: [],
    blocked: [],
    summary: { recommended: false, ready: 0, blocked: 0, in_progress: 0, candidates: 0, containers: 0 },
    filters: {
      type: null,
      tag: null,
      priority: null,
      assignee: null,
      assignee_filter: null,
      sprint: null,
      release: null,
      parent: null,
      limit: 5,
      blocked_limit: 5,
      ready_only: false,
    },
    ...overrides,
  };
}

describe("renderNextMarkdown", () => {
  it("renders the recommendation, ready, and blocked sections with annotations", () => {
    const markdown = renderNextMarkdown(
      nextResult({
        recommended: {
          id: "pm-rec",
          title: "Recommended",
          type: "Task",
          status: "open",
          priority: 0,
          order: null,
          deadline: "2026-06-30",
          assignee: null,
          tags: [],
          updated_at: "2026-06-24T00:00:00.000Z",
          parent: "pm-epic",
          open_blocker_count: 0,
          blockers: [],
          unblocks: ["pm-down"],
          reasons: ["open and ready to start", "priority p0 (highest)"],
        },
        ready: [
          {
            id: "pm-rec",
            title: "Recommended",
            type: "Task",
            status: "open",
            priority: 0,
            order: null,
            deadline: "2026-06-30",
            assignee: null,
            tags: [],
            updated_at: "2026-06-24T00:00:00.000Z",
            parent: "pm-epic",
            open_blocker_count: 0,
            blockers: [],
            unblocks: ["pm-down"],
          },
        ],
        blocked: [
          {
            id: "pm-block",
            title: "Blocked",
            type: "Issue",
            status: "open",
            priority: 1,
            order: null,
            deadline: null,
            assignee: null,
            tags: [],
            updated_at: "2026-06-24T00:00:00.000Z",
            parent: null,
            open_blocker_count: 2,
            blockers: [
              { id: "pm-gate", title: "Gate", status: "open" },
              { id: "pm-gate2", title: null, status: null },
            ],
            unblocks: [],
          },
        ],
        summary: { recommended: true, ready: 1, blocked: 1, in_progress: 0, candidates: 2, containers: 0 },
        filters: { ...nextResult({}).filters, parent: "pm-epic" },
      }),
    );
    expect(markdown).toContain("## Recommended");
    expect(markdown).toContain("why: open and ready to start; priority p0 (highest)");
    expect(markdown).toContain("scope: subtree of pm-epic");
    expect(markdown).toContain("unblocks:1");
    expect(markdown).toContain("blocked_by:pm-gate(open), pm-gate2(?)");
  });

  it("renders empty-state placeholders, hides the blocked section under ready-only, and lists suggestions", () => {
    const markdown = renderNextMarkdown(
      nextResult({
        filters: { ...nextResult({}).filters, ready_only: true },
        suggestions: ["pm create --type Task --title \"...\" to add a new work item"],
      }),
    );
    expect(markdown).toContain("No ready work.");
    expect(markdown).toContain("No ready items.");
    expect(markdown).not.toContain("## Blocked");
    expect(markdown).toContain("## Suggestions");
  });

  it("renders an empty blocked section when blocked work is absent but not ready-only", () => {
    const markdown = renderNextMarkdown(nextResult({}));
    expect(markdown).toContain("## Blocked");
    expect(markdown).toContain("No blocked items.");
  });
});
