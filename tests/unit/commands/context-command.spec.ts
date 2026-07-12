import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  _testOnly as contextInternals,
  parseContextDepth,
  parseContextFocusFields,
  parseContextSections,
  projectContextFocusRows,
  renderContextMarkdown,
  resolveContextOutputFormat,
  runContext,
  type ContextFocusItem,
  type ContextOptions,
} from "../../../src/cli/commands/context.js";
import { resolveRuntimeStatusRegistry } from "../../../src/core/schema/runtime-schema.js";
import { SETTINGS_DEFAULTS, EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import { withTempPmPath, type TempPmContext } from "../../helpers/withTempPmPath.js";

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
    parent?: string;
    blockedBy?: string;
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
  if (options.parent !== undefined) {
    args.push("--parent", options.parent);
  }
  if (options.blockedBy !== undefined) {
    args.push("--blocked-by", options.blockedBy);
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
  it("covers context parsing, date, status, and projection helper branches", () => {
    const settings = SETTINGS_DEFAULTS.context;
    const statusRegistry = resolveRuntimeStatusRegistry(SETTINGS_DEFAULTS.schema);

    expect(contextInternals.parseContextLimit(undefined, "standard")).toBe(10);
    // --depth full removes the default per-section cap when no explicit --limit is set.
    expect(contextInternals.parseContextLimit(undefined, "full")).toBe(Number.MAX_SAFE_INTEGER);
    expect(contextInternals.parseContextLimit("5", "full")).toBe(5);
    expect(contextInternals.parseContextParent(undefined)).toBeUndefined();
    expect(contextInternals.parseContextParent("  pm-epic  ")).toBe("pm-epic");
    expect(() => contextInternals.parseContextParent("   ")).toThrow(PmCliError);
    expect(contextInternals.parseActivityLimit(undefined, settings)).toBe(settings.activity_limit);
    expect(contextInternals.parseActivityLimit("3", settings)).toBe(3);
    expect(contextInternals.parseStaleThresholdDays(undefined, settings)).toBe(settings.stale_threshold_days);
    expect(contextInternals.parseStaleThresholdDays("7d", settings)).toBe(7);
    expect(() => contextInternals.parseStaleThresholdDays("0", settings)).toThrow(PmCliError);
    expect(() => contextInternals.parseStaleThresholdDays("soon", settings)).toThrow(PmCliError);

    expect(contextInternals.compareOptionalOrder(null, null)).toBe(0);
    expect(contextInternals.compareOptionalOrder(null, 1)).toBe(1);
    expect(contextInternals.compareOptionalOrder(1, null)).toBe(-1);
    expect(contextInternals.compareOptionalDeadline(null, null)).toBe(0);
    expect(contextInternals.compareOptionalDeadline(null, "2026-01-01T00:00:00.000Z")).toBe(1);
    expect(contextInternals.compareOptionalDeadline("2026-01-01T00:00:00.000Z", null)).toBe(-1);
    expect(contextInternals.sortableTimestamp("20260610")).toBe("2026-06-10T00:00:00.000Z");
    expect(contextInternals.parseContextTimestampMs("20260613T091530+02:00")).toBe(Date.parse("2026-06-13T07:15:30.000Z"));
    expect(contextInternals.parseContextTimestampMs("20260613T0915")).toBe(Date.parse("2026-06-13T09:15:00"));
    expect(contextInternals.dateTokenForTimestamp("not-a-date")).toBe("unknown");
    expect(Number.isNaN(contextInternals.parseContextTimestampMs("2026-02-30"))).toBe(true);

    expect(contextInternals.statusRank("in_progress", statusRegistry)).toBe(0);
    expect(contextInternals.statusRank("draft", statusRegistry)).toBe(3);
    const customStatusRegistry = {
      ...statusRegistry,
      active_statuses: new Set([...statusRegistry.active_statuses, "qa_ready"]),
      blocked_statuses: new Set([...statusRegistry.blocked_statuses, "waiting"]),
      terminal_statuses: new Set([...statusRegistry.terminal_statuses, "archived"]),
    };
    expect(contextInternals.statusRank("qa_ready" as never, customStatusRegistry)).toBe(4);
    expect(contextInternals.statusRank("waiting" as never, customStatusRegistry)).toBe(5);
    expect(contextInternals.statusRank("archived" as never, customStatusRegistry)).toBe(7);
    expect(contextInternals.statusRank("custom" as never, customStatusRegistry)).toBe(6);
    expect(contextInternals.isClosedStatus("closed", statusRegistry)).toBe(true);
    expect(contextInternals.isInProgressStatus("in_progress", statusRegistry)).toBe(true);
    expect(contextInternals.isOpenStatus("open", statusRegistry)).toBe(true);
    expect(contextInternals.isBlockedStatus("blocked", statusRegistry)).toBe(true);
    expect(
      contextInternals.filterTerminalCalendarEvents(
        [
          { item_status: "open" },
          { item_status: "closed" },
        ] as never,
        statusRegistry,
      ),
    ).toEqual([{ item_status: "open" }]);
    expect(
      contextInternals.stripListProjectionFlags({
        compact: true,
        fields: "id",
        includeBody: true,
        tag: "keep",
      } as never),
    ).toEqual({ tag: "keep" });
  });

  it("covers context hierarchy, progress, blockers, staleness, and test-health helper branches", () => {
    const statusRegistry = resolveRuntimeStatusRegistry(SETTINGS_DEFAULTS.schema);
    const now = "2026-06-13T12:00:00.000Z";
    const epic = {
      id: "pm-epic",
      title: "Epic",
      type: "Epic",
      status: "open",
      priority: 2,
      order: null,
      deadline: null,
      created_at: "2026-06-01T00:00:00.000Z",
      updated_at: "2026-06-01T00:00:00.000Z",
    };
    const feature = {
      ...epic,
      id: "pm-feature",
      title: "Feature",
      type: "Feature",
      status: "in_progress",
      priority: 1,
      parent: "pm-epic",
      order: 1,
      updated_at: "2026-06-02T00:00:00.000Z",
    };
    const openTask = {
      ...epic,
      id: "pm-open",
      title: "Open task",
      type: "Task",
      status: "open",
      parent: "pm-feature",
      files: [{ path: "src/a.ts" }, { path: "src/a.ts" }],
      tests: [{ command: "pnpm test" }],
      test_runs: [{ passed: 2, failed: 0, skipped: 1 }],
    };
    const blockedTask = {
      ...epic,
      id: "pm-blocked",
      title: "Blocked task",
      type: "Task",
      status: "blocked",
      parent: "pm-feature",
      blocked_by: "pm-open",
      blocked_reason: "waiting",
      unblock_note: "ship dependency",
      files: [{ path: "src/b.ts" }],
      tests: [{ command: "pnpm test" }],
      test_runs: [{ passed: 0, failed: 1, skipped: 0 }],
    };
    const closedTask = {
      ...epic,
      id: "pm-closed",
      title: "Closed task",
      type: "Task",
      status: "closed",
      parent: "pm-feature",
      updated_at: "2026-06-12T00:00:00.000Z",
    };
    const allItems = [epic, feature, openTask, blockedTask, closedTask] as never;
    const activeItems = [epic, feature, openTask, blockedTask] as never;
    const childrenByParent = contextInternals.buildChildrenByParent(allItems);

    expect(contextInternals.normalizedParentId("  pm-parent  ")).toBe("pm-parent");
    expect(contextInternals.dateTokenForTimestamp("20260613T091530+0200")).toBe("2026-06-13");
    expect(contextInternals.normalizedParentId("   ")).toBeNull();
    expect(contextInternals.completionPct(1, 4)).toBe(25);
    expect(contextInternals.compareCriticalItems(
      {
        ...openTask,
        id: "pm-newer",
        updated_at: "2026-06-10T00:00:00.000Z",
      },
      {
        ...openTask,
        id: "pm-older",
        updated_at: "2026-06-09T00:00:00.000Z",
      },
      statusRegistry,
    )).toBeLessThan(0);
    expect(contextInternals.compareCriticalItems(
      {
        ...openTask,
        id: "pm-a",
      },
      {
        ...openTask,
        id: "pm-b",
      },
      statusRegistry,
    )).toBeLessThan(0);
    expect(contextInternals.collectDescendants("pm-epic", childrenByParent).map((item: { id: string }) => item.id)).toEqual([
      "pm-feature",
      "pm-open",
      "pm-blocked",
      "pm-closed",
    ]);
    const cyclicChildrenByParent = new Map<string, Array<{ id: string; status: string }>>([
      ["pm-root", [{ id: "pm-a", status: "open" }, { id: "pm-b", status: "open" }]],
      ["pm-a", [{ id: "pm-c", status: "open" }]],
      ["pm-b", [{ id: "pm-c", status: "open" }]],
      // revisit pm-a through pm-c -> pm-a to exercise visited-skip branch
      ["pm-c", [{ id: "pm-a", status: "open" }]],
    ]);
    const cyclicDescendantIds = contextInternals
      .collectDescendants(
        "pm-root",
        cyclicChildrenByParent as unknown as Map<string, never[]>,
      )
      .map((item: { id: string }) => item.id);
    expect(cyclicDescendantIds).toHaveLength(5);
    expect([...cyclicDescendantIds].sort()).toEqual(["pm-a", "pm-a", "pm-b", "pm-c", "pm-c"]);

    expect(
      contextInternals.buildHierarchy(
        allItems,
        [
          {
            ...epic,
            id: "pm-missing-parent",
            type: "Epic",
            status: "open",
          },
        ] as never,
        statusRegistry,
        5,
      ),
    ).toEqual([]);
    const hierarchy = contextInternals.buildHierarchy(allItems, activeItems, statusRegistry, 5);
    expect(hierarchy[0]?.children.some((child) => child.id === "pm-open")).toBe(true);
    expect(hierarchy[0]?.children.some((child) => child.id === "pm-blocked")).toBe(true);

    // collectSubtreeIds: anchor + every transitive descendant, case-insensitive anchor match.
    const subtree = contextInternals.collectSubtreeIds(allItems, "PM-FEATURE");
    expect(subtree.found).toBe(true);
    expect([...subtree.ids].sort()).toEqual(["pm-blocked", "pm-closed", "pm-feature", "pm-open"]);
    const leafSubtree = contextInternals.collectSubtreeIds(allItems, "pm-open");
    expect(leafSubtree.found).toBe(true);
    expect([...leafSubtree.ids]).toEqual(["pm-open"]);
    const missingSubtree = contextInternals.collectSubtreeIds(allItems, "pm-nope");
    expect(missingSubtree.found).toBe(false);
    expect(missingSubtree.ids.size).toBe(0);

    const progress = contextInternals.buildProgress(allItems, activeItems, statusRegistry, 5);
    expect(progress[0]).toMatchObject({
      id: "pm-epic",
      total: 4,
      closed: 1,
      open: 1,
      in_progress: 1,
      blocked: 1,
      completion_pct: 25,
    });
    expect(contextInternals.buildBlockers([blockedTask] as never, new Map([["pm-open", openTask]]), 5)).toEqual([
      {
        id: "pm-blocked",
        title: "Blocked task",
        blocked_by: "pm-open",
        blocked_by_title: "Open task",
        blocked_by_status: "open",
        blocked_reason: "waiting",
        unblock_note: "ship dependency",
      },
    ]);
    expect(contextInternals.buildHotFiles(activeItems, 5)).toEqual([
      { path: "src/a.ts", references: 1, items: ["pm-open"] },
      { path: "src/b.ts", references: 1, items: ["pm-blocked"] },
    ]);
    expect(contextInternals.buildStaleness(activeItems, 7, now, 5).map((entry: { id: string }) => entry.id)).toEqual([
      "pm-epic",
      "pm-open",
      "pm-blocked",
      "pm-feature",
    ]);
    expect(contextInternals.buildRecentlyCreated(activeItems, statusRegistry, childrenByParent, 2)).toHaveLength(2);
    expect(contextInternals.buildUnparented(activeItems, statusRegistry, childrenByParent, 5)).toEqual([]);
    expect(contextInternals.buildTestHealth(activeItems)).toMatchObject({
      items_with_tests: 2,
      items_with_recent_runs: 2,
      recent_runs: { passed: 2, failed: 1, skipped: 1 },
    });
    expect(contextInternals.summarizeAgenda([{ item_id: "pm-open" }, { item_id: "pm-open" }, { item_id: "pm-blocked" }] as never)).toEqual({
      deadlines: 0,
      events: 3,
      items: 2,
      reminders: 0,
      scheduled: 3,
    });
    expect(
      contextInternals.mergeSortedWarnings(["z_warning", "a_warning"], ["m_warning", "a_warning"]),
    ).toEqual(["a_warning", "m_warning", "z_warning"]);
  });

  it("covers context helper fallback branches and markdown edge formatting", async () => {
    const statusRegistry = resolveRuntimeStatusRegistry(SETTINGS_DEFAULTS.schema);
    const sparseRegistry = {
      ...statusRegistry,
      alias_to_id: new Map<string, string>(),
      open_status: "custom_open",
      active_statuses: new Set<string>(),
      blocked_statuses: new Set<string>(["blocked"]),
      terminal_statuses: new Set<string>(["done"]),
    } as never;

    expect(contextInternals.statusRank("custom_open" as never, sparseRegistry)).toBe(6);
    expect(contextInternals.isClosedStatus("closed" as never, sparseRegistry)).toBe(true);
    expect(contextInternals.isInProgressStatus("in_progress" as never, sparseRegistry)).toBe(true);
    expect(contextInternals.isOpenStatus("custom_open" as never, sparseRegistry)).toBe(false);
    expect(contextInternals.completionPct(0, 0)).toBe(0);
    expect(contextInternals.sortableTimestamp("not-a-date")).toBe("");
    expect(contextInternals.dateTokenForTimestamp("20260613T0915Z")).toBe("2026-06-13");
    expect(contextInternals.buildBlockers([{ id: "pm-x", title: "No blocker", status: "blocked" }] as never, new Map(), 1)).toEqual([
      {
        id: "pm-x",
        title: "No blocker",
        blocked_by: null,
        blocked_by_title: null,
        blocked_by_status: null,
        blocked_reason: null,
        unblock_note: null,
      },
    ]);
    expect(
      contextInternals.buildTestHealth([
        { id: "pm-t1", tests: [{}], test_runs: [{}] },
      ] as never),
    ).toMatchObject({
      recent_runs: { passed: 0, failed: 0, skipped: 0 },
    });
    expect(
      contextInternals.buildWorkload(
        [
          { id: "pm-u1", title: "Unassigned", status: "custom_open", type: "Task", priority: 1, assignee: null },
        ] as never,
        sparseRegistry,
        5,
      ),
    ).toEqual([
      {
        assignee: null,
        active: 1,
        in_progress: 0,
        items: ["pm-u1"],
      },
    ]);

    const markdown = renderContextMarkdown({
      now: "2026-05-01T00:00:00.000Z",
      depth: "deep",
      filters: {},
      sections_included: ["hierarchy", "activity", "blockers", "workload"],
      summary: {
        active_items: 1,
        in_progress: 0,
        open: 1,
        blocked: 1,
        blocked_fallback_used: false,
        agenda_events: 1,
        total_items: 1,
        closed: 0,
        canceled: 0,
      },
      high_level: [],
      low_level: [],
      blocked_fallback: [],
      agenda: {
        summary: { events: 1, deadlines: 0, reminders: 0, scheduled: 1 },
        events: [
          {
            kind: "event",
            at: "2026-05-01T09:00:00.000Z",
            item_id: "pm-u1",
            item_title: "Unassigned",
            item_priority: 1,
            item_status: "open",
            event_title: null,
            event_recurring: false,
          },
        ],
      },
      hierarchy: [
        {
          id: "pm-parent",
          title: "Parent",
          type: "Epic",
          status: "open",
          children_total: 0,
          children_closed: 0,
          children_open: 0,
          children_in_progress: 0,
          children_blocked: 0,
          children: [
            {
              id: "pm-child",
              title: "Child",
              type: "Task",
              status: "open",
              children_total: 0,
              children_closed: 0,
              children_open: 0,
              children_in_progress: 0,
              children_blocked: 0,
            },
          ],
        },
      ],
      activity: [{ ts: "2026-05-01T08:00:00.000Z", id: "pm-u1", op: "update", author: "agent" }],
      blockers: [{ id: "pm-u1", title: "Unassigned", blocked_by: null, blocked_reason: null, unblock_note: null }],
      workload: [{ assignee: null, active: 1, in_progress: 0, items: ["pm-u1"] }],
    } as never);
    expect(markdown).toContain("- total_items: 1 (closed: 0, canceled: 0)");
    expect(markdown).toContain('- pm-u1 "Unassigned" blocked_by:-');
    expect(markdown).toContain("- (unassigned) active:1 wip:0 items:[pm-u1]");

    const emptyBlockersMarkdown = renderContextMarkdown({
      now: "2026-05-01T00:00:00.000Z",
      depth: "deep",
      filters: {},
      sections_included: ["hierarchy", "blockers"],
      summary: {
        active_items: 0,
        in_progress: 0,
        open: 0,
        blocked: 0,
        blocked_fallback_used: false,
        agenda_events: 0,
      },
      high_level: [],
      low_level: [],
      blocked_fallback: [],
      agenda: { summary: { events: 0, deadlines: 0, reminders: 0, scheduled: 0 }, events: [] },
      hierarchy: [
        {
          id: "pm-parent",
          title: "Parent",
          type: "Epic",
          status: "open",
          children_total: 0,
          children_closed: 0,
          children_open: 0,
          children_in_progress: 0,
          children_blocked: 0,
          children: [],
        },
      ],
      blockers: [],
    } as never);
    expect(emptyBlockersMarkdown).toContain("- sections: hierarchy");
    expect(emptyBlockersMarkdown).not.toContain("- sections: hierarchy, blockers");

    const omittedBlockersMarkdown = renderContextMarkdown({
      now: "2026-05-01T00:00:00.000Z",
      depth: "deep",
      filters: {},
      sections_included: ["blockers"],
      summary: {
        active_items: 0,
        in_progress: 0,
        open: 0,
        blocked: 0,
        blocked_fallback_used: false,
        agenda_events: 0,
      },
      high_level: [],
      low_level: [],
      blocked_fallback: [],
      agenda: { summary: { events: 0, deadlines: 0, reminders: 0, scheduled: 0 }, events: [] },
    } as never);
    expect(omittedBlockersMarkdown).not.toContain("- sections:");

    const activityModule = await import("../../../src/cli/commands/activity.js");
    const runActivitySpy = vi.spyOn(activityModule, "runActivity").mockResolvedValue({ compact_activity: undefined } as never);
    try {
      await expect(contextInternals.buildActivity(3, { path: "/tmp" } as never)).resolves.toEqual([]);
    } finally {
      runActivitySpy.mockRestore();
    }
  });

  it("covers additional context branch edges for sections, hierarchy math, and settings fallbacks", async () => {
    const statusRegistry = resolveRuntimeStatusRegistry(SETTINGS_DEFAULTS.schema);
    const parent = {
      id: "pm-parent",
      title: "Parent",
      type: "Epic",
      status: "open",
      priority: 1,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    const blockedChild = {
      ...parent,
      id: "pm-blocked-child",
      title: "Blocked child",
      type: "Task",
      status: "blocked",
      parent: "pm-parent",
    };
    const hierarchy = contextInternals.buildHierarchy([parent, blockedChild] as never, [parent] as never, statusRegistry, 5);
    expect(hierarchy[0]?.children_blocked).toBe(1);
    const progress = contextInternals.buildProgress([parent, blockedChild] as never, [parent] as never, statusRegistry, 5);
    expect(progress[0]?.blocked).toBe(1);
    const recurringMarkdown = renderContextMarkdown({
      now: "2026-05-01T00:00:00.000Z",
      depth: "deep",
      filters: {},
      sections_included: ["agenda", "hierarchy"],
      summary: {
        active_items: 1,
        in_progress: 0,
        open: 1,
        blocked: 0,
        blocked_fallback_used: false,
        agenda_events: 1,
        total_items: 2,
      },
      high_level: [],
      low_level: [],
      blocked_fallback: [],
      agenda: {
        summary: { events: 1, deadlines: 0, reminders: 0, scheduled: 1 },
        events: [
          {
            kind: "event",
            at: "2026-05-01T09:00:00.000Z",
            item_id: "pm-parent",
            item_title: "Parent",
            item_priority: 1,
            item_status: "open",
            event_title: null,
            event_recurring: true,
          },
        ],
      },
      hierarchy: [
        {
          id: "pm-parent",
          title: "Parent",
          type: "Epic",
          status: "open",
          children_total: 1,
          children_closed: 0,
          children_open: 1,
          children_in_progress: 0,
          children_blocked: 0,
          children: [
            {
              id: "pm-child",
              title: "Child",
              type: "Task",
              status: "open",
              children_total: 2,
              children_closed: 1,
              children_open: 1,
              children_in_progress: 0,
              children_blocked: 0,
            },
          ],
        },
      ],
    } as never);
    expect(recurringMarkdown).toContain("(recurring)");
    expect(recurringMarkdown).toContain("[1/2 done 50%]");
    expect(recurringMarkdown).toContain("(closed: 0, canceled: 0)");

    await withTempPmPath(async (context) => {
      createContextItem(context, { title: "Section dedupe", type: "Task", status: "open" });
      const deduped = await runContext({ section: ["activity", "activity"] as never }, { path: context.pmPath });
      expect(deduped.sections_included.filter((section) => section === "activity")).toEqual(["activity"]);

      const settingsPath = path.join(context.pmPath, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        context?: unknown;
        schema: {
          statuses: Array<{ roles?: string[] }>;
        };
      };
      delete settings.context;
      settings.schema.statuses = settings.schema.statuses.map((definition) => ({
        ...definition,
        roles: (definition.roles ?? []).filter(
          (role) => role !== "active" && role !== "default_open" && role !== "blocked" && role !== "draft",
        ),
      }));
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      const fallbackResult = await runContext({ depth: "standard" }, { path: context.pmPath });
      expect(fallbackResult.summary.active_items).toBeGreaterThanOrEqual(1);
    });
  });

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

  it("returns suggestions for an empty project context", async () => {
    await withTempPmPath(async (context) => {
      const result = await runContext({ date: "2026-05-01T00:00:00.000Z" }, { path: context.pmPath });

      expect(result.summary.active_items).toBe(0);
      expect(result.summary.blocked).toBe(0);
      expect(result.agenda.summary.events).toBe(0);
      expect(result.suggestions).toEqual([
        'pm create --type Task --title "..." to add a new work item',
        "pm list --status closed --limit 5 to review recent completions",
        "pm search <keywords> to find related past work",
        "pm aggregate for a full project status overview",
      ]);

      const markdown = renderContextMarkdown(result);
      expect(markdown).toContain("## Suggestions");
      expect(markdown).toContain("No active work items or upcoming events.");
      expect(markdown).toContain("pm aggregate");
    });
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

      const cliAlias = context.runCli(["context", "--json", "--max-items", "1"], { expectJson: true });
      expect(cliAlias.code).toBe(0);
      const aliasJson = cliAlias.json as { filters: { limit: string }; low_level: unknown[] };
      expect(aliasJson.filters.limit).toBe("1");
      expect(aliasJson.low_level).toHaveLength(1);

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
        deadline: "2026-06-01T00:00:00.000Z",
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
    expect(parseContextDepth("full", settings)).toBe("full");
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
    // full ignores per-section settings toggles and returns every known section.
    const fullSections = parseContextSections(undefined, "full", {
      ...settings,
      sections: { ...settings.sections, hierarchy: false },
    });
    expect(fullSections).toContain("hierarchy");
    expect(fullSections).toContain("tests");
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

      // `fields` is now a first-class context projection (covered separately);
      // the remaining list-only shaping flags must still never reach runList and
      // strip the focus-row tags array.
      const projectionPermutations: ContextOptions[] = [
        { compact: true } as unknown as ContextOptions,
        { brief: true } as unknown as ContextOptions,
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

      expect(result.recently_created?.[0]?.id).toBe(currentId);
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

  it("renders stale item and failing test health markdown details", () => {
    const markdown = renderContextMarkdown({
      now: "2026-05-01T00:00:00.000Z",
      depth: "deep",
      filters: {},
      sections_included: ["staleness", "tests"],
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
      blockers: [
        {
          id: "pm-blocked",
          title: "Blocked task",
          blocked_by: "pm-dependency",
          blocked_by_status: undefined,
          blocked_reason: "waiting",
          unblock_note: "retry",
        },
      ],
      staleness: [
        {
          id: "pm-stale",
          title: "Stale task",
          status: "open",
          stale_days: 9,
          updated_at: "2026-04-20T00:00:00.000Z",
        },
      ],
      tests: {
        items_with_tests: 1,
        items_with_recent_runs: 1,
        recent_runs: { passed: 0, failed: 1, skipped: 0 },
        items_failing: ["pm-stale"],
      },
    } as never);

    expect(markdown).toContain("## Stale items");
    expect(markdown).toContain('- pm-stale open stale:9d last:2026-04-20 "Stale task"');
    expect(markdown).toContain("## Blockers");
    expect(markdown).toContain('- pm-blocked "Blocked task" blocked_by:pm-dependency(?) reason:"waiting" unblock:"retry"');
    expect(markdown).toContain("## Test health");
    expect(markdown).toContain("- items_failing: [pm-stale]");
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

  it("--depth full surfaces every section without the default per-section cap", async () => {
    expect(
      contextInternals.resolveContextLimitAtScale(
        Number.MAX_SAFE_INTEGER,
        9_999,
      ),
    ).toBe(Number.MAX_SAFE_INTEGER);
    expect(
      contextInternals.resolveContextLimitAtScale(
        Number.MAX_SAFE_INTEGER,
        10_000,
      ),
    ).toBe(10);
    expect(contextInternals.resolveContextLimitAtScale(7, 10_000)).toBe(7);

    await withTempPmPath(async (context) => {
      for (let index = 0; index < 12; index += 1) {
        createContextItem(context, { title: `Full task ${index}`, type: "Task", status: "open" });
      }
      const result = await runContext({ depth: "full" }, { path: context.pmPath });
      expect(result.depth).toBe("full");
      // full = every known section, not the standard/deep subset.
      expect(result.sections_included).toEqual(expect.arrayContaining(["hierarchy", "blockers", "files", "tests"]));
      // No per-section cap: all 12 low-level items appear instead of the default 10.
      expect(result.low_level.length).toBe(12);
      expect(result.filters.limit).toBeNull();
    });
  });

  it("--parent scopes the snapshot to one item's subtree and rejects unknown anchors", async () => {
    await withTempPmPath(async (context) => {
      const epicId = createContextItem(context, { title: "Scoped epic", type: "Epic", status: "open" });
      const childId = createContextItem(context, { title: "Scoped child", type: "Task", status: "open", parent: epicId });
      createContextItem(context, { title: "Outside task", type: "Task", status: "open" });

      const scoped = await runContext({ parent: epicId, depth: "deep" }, { path: context.pmPath });
      expect(scoped.filters.parent).toBe(epicId);
      const scopedIds = [...scoped.high_level, ...scoped.low_level].map((item) => item.id).sort();
      expect(scopedIds).toEqual([childId, epicId].sort());
      expect(scoped.summary.total_items).toBe(2);

      const markdown = renderContextMarkdown(scoped);
      expect(markdown).toContain(`- scope: subtree of ${epicId}`);

      // The structural corpus read is unpaginated, so a tight --limit does NOT
      // shrink the corpus used to resolve the anchor → no false NOT_FOUND.
      const tightlyLimited = await runContext({ parent: epicId, limit: "1" }, { path: context.pmPath });
      expect(tightlyLimited.filters.parent).toBe(epicId);
      expect(tightlyLimited.next_cursor).toBeTypeOf("string");
      const continued = await runContext(
        { parent: epicId, limit: "1", after: tightlyLimited.next_cursor },
        { path: context.pmPath },
      );
      expect(
        [...continued.high_level, ...continued.low_level].map((item) => item.id),
      ).not.toContain(
        [...tightlyLimited.high_level, ...tightlyLimited.low_level][0]?.id,
      );

      await expect(runContext({ parent: "pm-missing" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    });
  });

  it("--parent resolves blocker metadata for references outside the subtree", async () => {
    await withTempPmPath(async (context) => {
      const epicId = createContextItem(context, { title: "Blocker epic", type: "Epic", status: "open" });
      const outsideId = createContextItem(context, { title: "Outside blocker", type: "Task", status: "open" });
      const blockedId = createContextItem(context, {
        title: "Blocked subtree task",
        type: "Task",
        status: "blocked",
        parent: epicId,
        blockedBy: outsideId,
      });

      const scoped = await runContext({ parent: epicId, depth: "deep" }, { path: context.pmPath });
      const blockerRow = (scoped.blockers ?? []).find((entry) => entry.id === blockedId);
      // itemMap is built from the full corpus, so the cross-subtree blocker keeps
      // its title/status instead of degrading to a bare id.
      expect(blockerRow).toMatchObject({
        blocked_by: outsideId,
        blocked_by_title: "Outside blocker",
        blocked_by_status: "open",
      });
    });
  });

  describe("focus-row field projection (--fields)", () => {
    it("parses, trims, and de-duplicates field names", () => {
      expect(parseContextFocusFields(undefined)).toBeUndefined();
      expect(parseContextFocusFields(" id , title , id ")).toEqual(["id", "title"]);
    });

    it("rejects unknown and empty projections with usage guidance", () => {
      expect(() => parseContextFocusFields("bogus")).toThrow(/not projectable: bogus/);
      try {
        parseContextFocusFields("bogus");
      } catch (error) {
        expect((error as PmCliError).exitCode).toBe(EXIT_CODE.USAGE);
      }
      expect(() => parseContextFocusFields("  ,  ")).toThrow(/at least one field/);
    });

    it("projects focus rows to the requested subset, filling missing fields with null", () => {
      const rows: ContextFocusItem[] = [
        {
          id: "pm-1",
          title: "First",
          type: "Task",
          status: "open",
          priority: 2,
          order: null,
          deadline: null,
          assignee: null,
          tags: ["a", "b"],
          updated_at: "2026-05-01T00:00:00.000Z",
          parent: null,
        },
      ];
      expect(projectContextFocusRows(rows, ["id", "tags", "created_at"])).toEqual([
        { id: "pm-1", tags: ["a", "b"], created_at: null },
      ]);
    });

    it("renders projected focus lines in markdown and drops the recently-created date prefix", () => {
      const markdown = renderContextMarkdown({
        now: "2026-05-01T00:00:00.000Z",
        depth: "standard",
        filters: {},
        sections_included: ["recently_created"],
        focus_fields: ["id", "priority", "tags", "deadline"],
        summary: {
          active_items: 1,
          in_progress: 0,
          open: 1,
          blocked: 0,
          blocked_fallback_used: false,
          agenda_events: 0,
        },
        high_level: [{ id: "pm-hi", priority: 1, tags: ["epic"] }],
        low_level: [],
        blocked_fallback: [],
        agenda: { summary: { events: 0, deadlines: 0, reminders: 0, scheduled: 0 }, events: [] },
        recently_created: [{ id: "pm-new", priority: 3, tags: [] }],
      } as never);
      // Missing scalar fields render as "-"; arrays join with commas.
      expect(markdown).toContain("- id:pm-hi priority:1 tags:epic deadline:-");
      // No leading date token for the recently-created row under --fields.
      expect(markdown).toContain("- id:pm-new priority:3 tags: deadline:-");
      expect(markdown).not.toMatch(/- \d{4}-\d{2}-\d{2} id:pm-new/);
    });

    it("applies projection across focus sections through runContext", async () => {
      await withTempPmPath(async (context) => {
        createContextItem(context, { title: "Epic root", type: "Epic", status: "open" });
        createContextItem(context, { title: "Lone task", type: "Task", status: "open" });
        const projected = await runContext({ depth: "deep", fields: "id,priority" }, { path: context.pmPath });
        expect(projected.focus_fields).toEqual(["id", "priority"]);
        for (const row of [...projected.high_level, ...projected.low_level, ...(projected.unparented ?? []), ...(projected.recently_created ?? [])]) {
          expect(Object.keys(row).sort()).toEqual(["id", "priority"]);
        }
      });
    });

    it("projects focus rows even when section-derived focus arrays are absent (brief depth)", async () => {
      await withTempPmPath(async (context) => {
        createContextItem(context, { title: "Brief task", type: "Task", status: "open" });
        const projected = await runContext({ depth: "brief", fields: "id" }, { path: context.pmPath });
        expect(projected.focus_fields).toEqual(["id"]);
        expect(projected.recently_created).toBeUndefined();
        expect(projected.unparented).toBeUndefined();
        for (const row of projected.low_level) {
          expect(Object.keys(row)).toEqual(["id"]);
        }
      });
    });
  });
});
