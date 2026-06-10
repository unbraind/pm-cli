import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseContextDepth,
  parseContextSections,
  renderContextMarkdown,
  resolveContextOutputFormat,
  runContext,
  type ContextOptions,
} from "../../src/cli/commands/context.js";
import { SETTINGS_DEFAULTS, EXIT_CODE } from "../../src/core/shared/constants.js";
import { PmCliError } from "../../src/core/shared/errors.js";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

function createContextItem(
  context: TempPmContext,
  options: {
    title: string;
    type?: string;
    status?: string;
    priority?: string;
    tags?: string;
    assignee?: string;
    deadline?: string;
    order?: string;
    reminders?: string[];
    events?: string[];
  },
): string {
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
    options.priority ?? "1",
    "--tags",
    options.tags ?? "context,unit",
    "--body",
    "",
    "--deadline",
    options.deadline ?? "+1d",
    "--estimate",
    "15",
    "--acceptance-criteria",
    `${options.title} acceptance`,
    "--author",
    "context-test",
    "--message",
    `Create ${options.title}`,
    "--assignee",
    options.assignee ?? "seed-assignee",
    "--dep",
    "id=pm-seed-related,kind=related,author=context-test,created_at=now",
    "--comment",
    "author=context-test,created_at=now,text=seed comment",
    "--note",
    "author=context-test,created_at=now,text=seed note",
    "--learning",
    "author=context-test,created_at=now,text=seed learning",
    "--file",
    "path=README.md,scope=project,note=seed file",
    "--test",
    "command=node dist/cli.js --version,scope=project,note=seed test",
    "--doc",
    "path=README.md,scope=project,note=seed doc",
  ];
  if (options.order !== undefined) {
    args.push("--order", options.order);
  }
  for (const reminder of options.reminders ?? []) {
    args.push("--reminder", reminder);
  }
  for (const event of options.events ?? []) {
    args.push("--event", event);
  }
  const created = context.runCli(args, { expectJson: true });
  expect(created.code).toBe(0);
  return (created.json as { item: { id: string } }).item.id;
}

describe("context command module", () => {
  it("resolves output format precedence and conflicts", () => {
    expect(resolveContextOutputFormat({}, { json: false })).toBe("toon");
    expect(resolveContextOutputFormat({ format: "markdown" }, { json: false })).toBe("markdown");
    expect(resolveContextOutputFormat({ format: "  JSON  " }, { json: false })).toBe("json");
    expect(resolveContextOutputFormat({}, { json: true })).toBe("json");
    expect(resolveContextOutputFormat({ format: "json" }, { json: true })).toBe("json");
    expect(() => resolveContextOutputFormat({ format: "toon" }, { json: true })).toThrow(PmCliError);
    expect(() => resolveContextOutputFormat({ format: "xml" }, { json: false })).toThrow(PmCliError);
  });

  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-context-not-init-"));
    try {
      await expect(runContext({}, { path: tempDir })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("builds deterministic high-level and low-level focus with agenda context", async () => {
    await withTempPmPath(async (context) => {
      const featureInProgress = createContextItem(context, {
        title: "Feature in progress",
        type: "Feature",
        status: "in_progress",
        priority: "1",
        order: "2",
        deadline: "2026-04-05T09:00:00.000Z",
        events: ["start=2026-04-04T12:00:00.000Z,title=Feature sync"],
      });
      const epicOpen = createContextItem(context, {
        title: "Epic open",
        type: "Epic",
        status: "open",
        priority: "0",
        order: "3",
      });
      const taskOpen = createContextItem(context, {
        title: "Task open critical",
        type: "Task",
        status: "open",
        priority: "0",
        order: "1",
        deadline: "2026-04-04T10:00:00.000Z",
        reminders: ["at=2026-04-04T08:00:00.000Z,text=Task reminder"],
      });
      const issueOpenNoOrder = createContextItem(context, {
        title: "Issue open no order",
        type: "Issue",
        status: "open",
        priority: "0",
        deadline: "2026-04-04T09:00:00.000Z",
      });
      createContextItem(context, {
        title: "Blocked issue",
        type: "Issue",
        status: "blocked",
        priority: "0",
      });
      createContextItem(context, {
        title: "Closed task with deadline",
        type: "Task",
        status: "closed",
        priority: "0",
        deadline: "2026-04-04T13:00:00.000Z",
      });

      const result = await runContext(
        {
          from: "2026-04-04T00:00:00.000Z",
          to: "2026-04-06T00:00:00.000Z",
          limit: "5",
        },
        { path: context.pmPath },
      );

      expect(result.summary.active_items).toBe(4);
      expect(result.summary.in_progress).toBe(1);
      expect(result.summary.open).toBe(3);
      expect(result.summary.blocked).toBe(1);
      expect(result.summary.blocked_fallback_used).toBe(false);

      expect(result.high_level.map((item) => item.id)).toEqual([featureInProgress, epicOpen]);
      expect(result.low_level.map((item) => item.id)).toEqual([taskOpen, issueOpenNoOrder]);
      expect(result.blocked_fallback).toEqual([]);

      expect(result.agenda.summary.events).toBe(4);
      expect(result.agenda.summary.deadlines).toBe(2);
      expect(result.agenda.summary.reminders).toBe(1);
      expect(result.agenda.summary.scheduled).toBe(1);
      expect(result.agenda.events.every((event) => event.item_status !== "closed" && event.item_status !== "canceled")).toBe(true);

      const markdown = renderContextMarkdown(result);
      expect(markdown).toContain("# pm context");
      expect(markdown).toContain("## High-level focus");
      expect(markdown).toContain(featureInProgress);
      expect(markdown).toContain(taskOpen);
      expect(markdown).toContain("[event]");
      expect(markdown).toContain("[reminder]");
      expect(markdown).toContain("[deadline]");
    });
  });

  it("uses blocked fallback when active work is empty", async () => {
    await withTempPmPath(async (context) => {
      const blockedTask = createContextItem(context, {
        title: "Blocked fallback task",
        status: "blocked",
        type: "Task",
        priority: "1",
        deadline: "2026-05-01T10:00:00.000Z",
      });
      createContextItem(context, {
        title: "Draft task",
        status: "draft",
        type: "Task",
        priority: "2",
        deadline: "2026-05-03T10:00:00.000Z",
      });

      const result = await runContext(
        {
          from: "2026-05-01T00:00:00.000Z",
          to: "2026-05-02T00:00:00.000Z",
        },
        { path: context.pmPath },
      );

      expect(result.summary.active_items).toBe(0);
      expect(result.summary.blocked).toBe(1);
      expect(result.summary.blocked_fallback_used).toBe(true);
      expect(result.high_level).toEqual([]);
      expect(result.low_level).toEqual([]);
      expect(result.blocked_fallback.map((item) => item.id)).toEqual([blockedTask]);
      expect(result.agenda.summary.events).toBe(1);

      const markdown = renderContextMarkdown(result);
      expect(markdown).toContain("No high-level active items.");
      expect(markdown).toContain("No low-level active items.");
      expect(markdown).toContain("## Blocked fallback");
    });
  });

  it("applies filters and validates limits", async () => {
    await withTempPmPath(async (context) => {
      const keptId = createContextItem(context, {
        title: "Filtered keep",
        type: "Task",
        status: "open",
        priority: "1",
        assignee: "agent-a",
        tags: "context,keep",
        deadline: "2026-06-01T10:00:00.000Z",
      });
      createContextItem(context, {
        title: "Filtered drop",
        type: "Task",
        status: "open",
        priority: "2",
        assignee: "agent-b",
        tags: "context,drop",
        deadline: "2026-06-01T11:00:00.000Z",
      });

      const options: ContextOptions = {
        type: "Task",
        tag: "keep",
        priority: "1",
        assignee: "agent-a",
        from: "2026-06-01T00:00:00.000Z",
        to: "2026-06-02T00:00:00.000Z",
        limit: "1",
      };
      const result = await runContext(options, { path: context.pmPath });
      expect(result.low_level).toHaveLength(1);
      expect(result.low_level[0]?.id).toBe(keptId);
      expect(result.filters.limit).toBe("1");

      await expect(runContext({ limit: "-1" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runContext({ limit: "1.5" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("renders markdown guidance when agenda has no events", async () => {
    await withTempPmPath(async (context) => {
      createContextItem(context, {
        title: "No agenda seed",
        type: "Feature",
        status: "open",
        priority: "1",
      });

      const result = await runContext(
        {
          from: "2026-07-01T00:00:00.000Z",
          to: "2026-07-02T00:00:00.000Z",
        },
        { path: context.pmPath },
      );
      expect(result.agenda.summary.events).toBe(0);
      const markdown = renderContextMarkdown(result);
      expect(markdown).toContain("No agenda events matched the selected filters.");
    });
  });

  it("parseContextDepth validates and falls back to settings", () => {
    const settings = SETTINGS_DEFAULTS.context;
    expect(parseContextDepth(undefined, settings)).toBe("brief");
    expect(parseContextDepth("standard", settings)).toBe("standard");
    expect(parseContextDepth("  Deep  ", settings)).toBe("deep");
    expect(parseContextDepth("brief", settings)).toBe("brief");
    expect(() => parseContextDepth("invalid", settings)).toThrow(PmCliError);

    const customSettings = { ...settings, default_depth: "deep" as const };
    expect(parseContextDepth(undefined, customSettings)).toBe("deep");
    expect(parseContextDepth("brief", customSettings)).toBe("brief");
  });

  it("parseContextSections resolves from depth and allows overrides", () => {
    const settings = SETTINGS_DEFAULTS.context;
    expect(parseContextSections(undefined, "brief", settings)).toEqual([]);
    expect(parseContextSections(undefined, "standard", settings)).toEqual([
      "hierarchy",
      "activity",
      "progress",
      "recently_created",
      "unparented",
      "workload",
    ]);
    const deepSections = parseContextSections(undefined, "deep", settings);
    expect(deepSections).toContain("hierarchy");
    expect(deepSections).toContain("blockers");
    expect(deepSections).toContain("files");
    expect(deepSections).toContain("staleness");
    expect(deepSections).toContain("tests");

    const overrides = parseContextSections(["hierarchy", "blockers"], "brief", settings);
    expect(overrides).toEqual(["hierarchy", "blockers"]);

    expect(() => parseContextSections(["invalid_section"], "brief", settings)).toThrow(PmCliError);
  });

  it("parseContextSections respects section settings toggles", () => {
    const settings = {
      ...SETTINGS_DEFAULTS.context,
      sections: { ...SETTINGS_DEFAULTS.context.sections, hierarchy: false, activity: false },
    };
    const sections = parseContextSections(undefined, "standard", settings);
    expect(sections).not.toContain("hierarchy");
    expect(sections).not.toContain("activity");
    expect(sections).toContain("progress");
    expect(sections).toContain("workload");
  });

  it("--depth brief returns no additional sections", async () => {
    await withTempPmPath(async (context) => {
      createContextItem(context, { title: "Brief task", type: "Task", status: "open", priority: "1" });

      const result = await runContext({ depth: "brief" }, { path: context.pmPath });
      expect(result.depth).toBe("brief");
      expect(result.sections_included).toEqual([]);
      expect(result.hierarchy).toBeUndefined();
      expect(result.activity).toBeUndefined();
      expect(result.progress).toBeUndefined();
      expect(result.workload).toBeUndefined();
    });
  });

  it("ignores caller-supplied list projection flags so MCP options never strip tags", async () => {
    await withTempPmPath(async (context) => {
      createContextItem(context, { title: "Projection task", type: "Task", status: "open", priority: "1" });

      const projectionPermutations: ContextOptions[] = [
        { compact: true } as unknown as ContextOptions,
        { brief: true } as unknown as ContextOptions,
        { fields: "id,title" } as unknown as ContextOptions,
        { includeBody: true } as unknown as ContextOptions,
        { include_body: true } as unknown as ContextOptions,
        { depth: "standard", compact: true } as unknown as ContextOptions,
      ];
      for (const options of projectionPermutations) {
        const result = await runContext(options, { path: context.pmPath });
        const focusItems = [...result.high_level, ...result.low_level];
        expect(focusItems.length).toBeGreaterThan(0);
        for (const focus of focusItems) {
          expect(Array.isArray(focus.tags)).toBe(true);
        }
      }
    });
  });

  it("--depth standard includes hierarchy, activity, progress, workload", async () => {
    await withTempPmPath(async (context) => {
      createContextItem(context, { title: "Standard epic", type: "Epic", status: "open", priority: "0" });
      createContextItem(context, { title: "Standard task", type: "Task", status: "open", priority: "1" });

      const result = await runContext({ depth: "standard", limit: "5" }, { path: context.pmPath });
      expect(result.depth).toBe("standard");
      expect(result.sections_included).toContain("hierarchy");
      expect(result.sections_included).toContain("activity");
      expect(result.sections_included).toContain("progress");
      expect(result.sections_included).toContain("recently_created");
      expect(result.sections_included).toContain("unparented");
      expect(result.sections_included).toContain("workload");
      expect(result.hierarchy).toBeDefined();
      expect(result.activity).toBeDefined();
      expect(result.progress).toBeDefined();
      expect(result.workload).toBeDefined();
      expect(result.blockers).toBeUndefined();
      expect(result.files).toBeUndefined();
      expect(result.staleness).toBeUndefined();
      expect(result.tests).toBeUndefined();
    });
  });

  it("--depth deep includes all sections", async () => {
    await withTempPmPath(async (context) => {
      createContextItem(context, { title: "Deep epic", type: "Epic", status: "open", priority: "0" });
      createContextItem(context, { title: "Deep task", type: "Task", status: "open", priority: "1" });

      const result = await runContext({ depth: "deep", limit: "5" }, { path: context.pmPath });
      expect(result.depth).toBe("deep");
      expect(result.sections_included).toContain("hierarchy");
      expect(result.sections_included).toContain("activity");
      expect(result.sections_included).toContain("progress");
      expect(result.sections_included).toContain("recently_created");
      expect(result.sections_included).toContain("unparented");
      expect(result.sections_included).toContain("workload");
      expect(result.sections_included).toContain("blockers");
      expect(result.sections_included).toContain("files");
      expect(result.sections_included).toContain("staleness");
      expect(result.sections_included).toContain("tests");
      expect(result.hierarchy).toBeDefined();
      expect(result.tests).toBeDefined();
      expect(result.summary.total_items).toBeGreaterThanOrEqual(2);
    });
  });

  it("builds hierarchy with parent-child relationships and counts", async () => {
    await withTempPmPath(async (context) => {
      const epicId = createContextItem(context, { title: "Hierarchy epic", type: "Epic", status: "open", priority: "0" });
      const featureArgs = [
        "create", "--json", "--title", "Hierarchy feature",
        "--description", "d", "--type", "Feature", "--status", "open",
        "--priority", "1", "--tags", "context", "--body", "",
        "--deadline", "+1d", "--estimate", "15",
        "--acceptance-criteria", "ac",
        "--author", "context-test", "--message", "Create feature",
        "--assignee", "seed-assignee",
        "--parent", epicId,
        "--dep", `id=${epicId},kind=parent,author=context-test,created_at=now`,
        "--comment", "author=context-test,created_at=now,text=seed",
        "--note", "author=context-test,created_at=now,text=seed",
        "--learning", "author=context-test,created_at=now,text=seed",
        "--file", "path=README.md,scope=project,note=seed",
        "--test", "command=node dist/cli.js --version,scope=project,note=seed",
        "--doc", "path=README.md,scope=project,note=seed",
      ];
      const featureResult = context.runCli(featureArgs, { expectJson: true });
      expect(featureResult.code).toBe(0);
      const featureId = (featureResult.json as { item: { id: string } }).item.id;

      const result = await runContext({ depth: "standard", limit: "10" }, { path: context.pmPath });
      expect(result.hierarchy).toBeDefined();
      const epicNode = result.hierarchy!.find((n) => n.id === epicId);
      expect(epicNode).toBeDefined();
      expect(epicNode!.children_total).toBeGreaterThanOrEqual(1);
      expect(epicNode!.children.some((c) => c.id === featureId)).toBe(true);
    });
  });

  it("builds progress entries for high-level items with children", async () => {
    await withTempPmPath(async (context) => {
      const epicId = createContextItem(context, { title: "Progress epic", type: "Epic", status: "open", priority: "0" });
      const childArgs = [
        "create", "--json", "--title", "Progress child",
        "--description", "d", "--type", "Task", "--status", "open",
        "--priority", "1", "--tags", "context", "--body", "",
        "--deadline", "+1d", "--estimate", "15",
        "--acceptance-criteria", "ac",
        "--author", "context-test", "--message", "Create child",
        "--assignee", "seed-assignee",
        "--parent", epicId,
        "--dep", `id=${epicId},kind=parent,author=context-test,created_at=now`,
        "--comment", "author=context-test,created_at=now,text=seed",
        "--note", "author=context-test,created_at=now,text=seed",
        "--learning", "author=context-test,created_at=now,text=seed",
        "--file", "path=README.md,scope=project,note=seed",
        "--test", "command=node dist/cli.js --version,scope=project,note=seed",
        "--doc", "path=README.md,scope=project,note=seed",
      ];
      const childResult = context.runCli(childArgs, { expectJson: true });
      expect(childResult.code).toBe(0);

      const result = await runContext({ depth: "standard", limit: "10" }, { path: context.pmPath });
      expect(result.progress).toBeDefined();
      expect(result.progress!.length).toBeGreaterThan(0);
      const epicProgress = result.progress!.find((e) => e.id === epicId);
      expect(epicProgress).toBeDefined();
      expect(epicProgress!.total).toBeGreaterThanOrEqual(1);
      expect(epicProgress!.completion_pct).toBeGreaterThanOrEqual(0);
      expect(epicProgress!.completion_pct).toBeLessThanOrEqual(100);
      const epicFocus = result.high_level.find((entry) => entry.id === epicId);
      expect(epicFocus).toMatchObject({
        children_total: 1,
        children_closed: 0,
        completion_pct: 0,
      });
      expect(epicFocus?.parent).toBeNull();
    });
  });

  it("includes recently-created and unparented sections for agent context recovery", async () => {
    await withTempPmPath(async (context) => {
      const orphanTask = createContextItem(context, { title: "Unparented task", type: "Task", status: "open", priority: "1" });
      const orphanIssue = createContextItem(context, { title: "Unparented issue", type: "Issue", status: "open", priority: "1" });

      const result = await runContext(
        { section: ["recently_created", "unparented"], limit: "10" },
        { path: context.pmPath },
      );

      expect(result.sections_included).toEqual(["recently_created", "unparented"]);
      expect(result.recently_created?.map((entry) => entry.id)).toEqual(expect.arrayContaining([orphanTask, orphanIssue]));
      expect(result.recently_created?.every((entry) => typeof entry.created_at === "string")).toBe(true);
      expect(result.unparented?.map((entry) => entry.id)).toEqual(expect.arrayContaining([orphanTask, orphanIssue]));
      expect(result.unparented?.every((entry) => entry.parent === null)).toBe(true);
    });
  });

  it("sorts recently-created entries with malformed legacy timestamps", async () => {
    await withTempPmPath(async (context) => {
      const legacyId = createContextItem(context, { title: "Legacy recent task", type: "Task", status: "open", priority: "1" });
      const currentId = createContextItem(context, { title: "Current recent task", type: "Task", status: "open", priority: "1" });
      const legacyPath = path.join(context.pmPath, "tasks", `${legacyId}.toon`);
      await writeFile(legacyPath, (await readFile(legacyPath, "utf8")).replace(/^created_at: .+\n/m, ""), "utf8");

      const result = await runContext(
        { section: ["recently_created"], limit: "10" },
        { path: context.pmPath },
      );

      expect(result.recently_created?.map((entry) => entry.id)).toContain(currentId);
    });
  });

  it("treats whitespace-only parent values as unparented", async () => {
    await withTempPmPath(async (context) => {
      const legacyId = createContextItem(context, { title: "Whitespace parent task", type: "Task", status: "open", priority: "1" });
      const legacyPath = path.join(context.pmPath, "tasks", `${legacyId}.toon`);
      await writeFile(legacyPath, (await readFile(legacyPath, "utf8")).replace("author: context-test\n", 'author: context-test\nparent: "   "\n'), "utf8");

      const result = await runContext(
        { section: ["unparented"], limit: "10" },
        { path: context.pmPath },
      );

      const entry = result.unparented?.find((item) => item.id === legacyId);
      expect(entry).toBeDefined();
      expect(entry?.parent).toBeNull();
    });
  });

  it("builds workload grouped by assignee", async () => {
    await withTempPmPath(async (context) => {
      createContextItem(context, { title: "W1", type: "Task", status: "open", priority: "1", assignee: "alice" });
      createContextItem(context, { title: "W2", type: "Task", status: "open", priority: "1", assignee: "alice" });
      createContextItem(context, { title: "W3", type: "Task", status: "open", priority: "1", assignee: "bob" });

      const result = await runContext({ depth: "standard", limit: "10" }, { path: context.pmPath });
      expect(result.workload).toBeDefined();
      const alice = result.workload!.find((w) => w.assignee === "alice");
      const bob = result.workload!.find((w) => w.assignee === "bob");
      expect(alice).toBeDefined();
      expect(alice!.active).toBe(2);
      expect(bob).toBeDefined();
      expect(bob!.active).toBe(1);
    });
  });

  it("builds test health summary from active items", async () => {
    await withTempPmPath(async (context) => {
      createContextItem(context, { title: "Test health task", type: "Task", status: "open", priority: "1" });

      const result = await runContext({ depth: "deep", limit: "10" }, { path: context.pmPath });
      expect(result.tests).toBeDefined();
      expect(result.tests!.items_with_tests).toBeGreaterThanOrEqual(1);
      expect(typeof result.tests!.recent_runs.passed).toBe("number");
      expect(typeof result.tests!.recent_runs.failed).toBe("number");
      expect(typeof result.tests!.recent_runs.skipped).toBe("number");
    });
  });

  it("hot files collects linked files from active items", async () => {
    await withTempPmPath(async (context) => {
      createContextItem(context, { title: "Files A", type: "Task", status: "open", priority: "1" });
      createContextItem(context, { title: "Files B", type: "Task", status: "open", priority: "1" });

      const result = await runContext({ depth: "deep", limit: "10" }, { path: context.pmPath });
      expect(result.files).toBeDefined();
      const readmeFile = result.files!.find((f) => f.path === "README.md");
      expect(readmeFile).toBeDefined();
      expect(readmeFile!.references).toBeGreaterThanOrEqual(2);
    });
  });

  it("--section overrides depth and selects only named sections", async () => {
    await withTempPmPath(async (context) => {
      createContextItem(context, { title: "Section override", type: "Task", status: "open", priority: "1" });

      const result = await runContext(
        { section: ["workload", "tests"], limit: "10" },
        { path: context.pmPath },
      );
      expect(result.sections_included).toEqual(["workload", "tests"]);
      expect(result.workload).toBeDefined();
      expect(result.tests).toBeDefined();
      expect(result.hierarchy).toBeUndefined();
      expect(result.activity).toBeUndefined();
      expect(result.progress).toBeUndefined();
      expect(result.blockers).toBeUndefined();
    });
  });

  it("renders markdown sections for standard depth", async () => {
    await withTempPmPath(async (context) => {
      const epicId = createContextItem(context, { title: "MD epic", type: "Epic", status: "open", priority: "0" });
      const childArgs = [
        "create", "--json", "--title", "MD child task",
        "--description", "d", "--type", "Task", "--status", "open",
        "--priority", "1", "--tags", "context", "--body", "",
        "--deadline", "+1d", "--estimate", "15",
        "--acceptance-criteria", "ac",
        "--author", "context-test", "--message", "Create child",
        "--assignee", "md-agent",
        "--parent", epicId,
        "--dep", `id=${epicId},kind=parent,author=context-test,created_at=now`,
        "--comment", "author=context-test,created_at=now,text=seed",
        "--note", "author=context-test,created_at=now,text=seed",
        "--learning", "author=context-test,created_at=now,text=seed",
        "--file", "path=README.md,scope=project,note=seed",
        "--test", "command=node dist/cli.js --version,scope=project,note=seed",
        "--doc", "path=README.md,scope=project,note=seed",
      ];
      const childResult = context.runCli(childArgs, { expectJson: true });
      expect(childResult.code).toBe(0);

      const result = await runContext({ depth: "standard", limit: "5" }, { path: context.pmPath });
      const markdown = renderContextMarkdown(result);
      expect(markdown).toContain("- depth: standard");
      expect(markdown).toContain("## Hierarchy");
      expect(markdown).toContain("## Recent activity");
      expect(markdown).toContain("## Progress");
      expect(markdown).toContain("## Workload");
    });
  });

  it("renders markdown sections for deep depth", async () => {
    await withTempPmPath(async (context) => {
      createContextItem(context, { title: "Deep MD task", type: "Task", status: "open", priority: "1" });

      const result = await runContext({ depth: "deep", limit: "5" }, { path: context.pmPath });
      const markdown = renderContextMarkdown(result);
      expect(markdown).toContain("- depth: deep");
      expect(markdown).toContain("## Test health");
    });
  });

  it("renders malformed recently created timestamps defensively", () => {
    const markdown = renderContextMarkdown({
      now: "2026-05-01T00:00:00.000Z",
      depth: "standard",
      filters: {},
      sections_included: ["recently_created"],
      summary: {
        active_items: 1,
        in_progress: 0,
        open: 1,
        blocked: 0,
        blocked_fallback_used: false,
        agenda_events: 0,
      },
      high_level: [],
      low_level: [],
      blocked_fallback: [],
      agenda: { summary: { events: 0, deadlines: 0, reminders: 0, scheduled: 0 }, events: [] },
      recently_created: [
        {
          id: "pm-compact",
          title: "Compact legacy item",
          type: "Task",
          status: "open",
          priority: 1,
          order: null,
          deadline: null,
          assignee: null,
          tags: [],
          updated_at: "2026-05-01T00:00:00.000Z",
          parent: null,
          created_at: "20260610",
        },
        {
          id: "pm-impossible",
          title: "Impossible legacy item",
          type: "Task",
          status: "open",
          priority: 1,
          order: null,
          deadline: null,
          assignee: null,
          tags: [],
          updated_at: "2026-05-01T00:00:00.000Z",
          parent: null,
          created_at: "2026-02-30T00:00:00.000Z",
        },
        {
          id: "pm-legacy",
          title: "Legacy item",
          type: "Task",
          status: "open",
          priority: 1,
          order: null,
          deadline: null,
          assignee: null,
          tags: [],
          updated_at: "2026-05-01T00:00:00.000Z",
          parent: null,
          created_at: undefined,
        },
      ],
    } as never);

    expect(markdown).toContain("- 2026-06-10 pm-compact");
    expect(markdown).toContain("- unknown pm-impossible");
    expect(markdown).toContain("- unknown pm-legacy");
  });
});
