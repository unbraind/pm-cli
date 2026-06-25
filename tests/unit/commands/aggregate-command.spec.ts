import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { _testOnlyAggregateCommand, runAggregate } from "../../../src/cli/commands/aggregate.js";
import { runNormalize } from "../../../src/cli/commands/normalize.js";
import { resolveRuntimeStatusRegistry } from "../../../src/core/schema/runtime-schema.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { SETTINGS_DEFAULTS } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import { withTempPmPath, type TempPmContext } from "../../helpers/withTempPmPath.js";

// Strip the derived display label so the existing structural assertions stay
// focused on group/count fields; group_label is asserted on its own below.
function stripGroupLabel<T extends { group_label?: string }>(row: T): Omit<T, "group_label"> {
  const { group_label: _label, ...rest } = row;
  return rest;
}

function createItem(
  context: TempPmContext,
  params: {
    title: string;
    type: "Feature" | "Task" | "Issue" | "Chore";
    status: "draft" | "open" | "in_progress" | "closed";
    parent?: string;
    priority?: number;
    tags?: string;
    assignee?: string | null;
    sprint?: string;
    release?: string;
    blockedReason?: string;
    closeReason?: string;
    resolution?: string;
    expectedResult?: string;
    actualResult?: string;
  },
): string {
  const resolvedAssignee = params.assignee === undefined || params.assignee === null ? "none" : params.assignee;
  const args = [
    "create",
    "--json",
    "--title",
    params.title,
    "--description",
    `${params.title} description`,
    "--type",
    params.type,
    "--status",
    params.status,
    "--priority",
    String(params.priority ?? 1),
    "--tags",
    params.tags ?? "aggregate,unit",
    "--body",
    "",
    "--deadline",
    "none",
    "--estimate",
    "15",
    "--acceptance-criteria",
    `${params.title} acceptance`,
    "--author",
    "test-author",
    "--message",
    `Create ${params.title}`,
    "--assignee",
    resolvedAssignee,
    "--dep",
    "none",
    "--comment",
    "none",
    "--note",
    "none",
    "--learning",
    "none",
    "--file",
    "none",
    "--test",
    "none",
    "--doc",
    "none",
  ];
  if (params.parent) {
    args.push("--parent", params.parent);
  }
  if (params.sprint) {
    args.push("--sprint", params.sprint);
  }
  if (params.release) {
    args.push("--release", params.release);
  }
  if (params.blockedReason) {
    args.push("--blocked-reason", params.blockedReason);
  }
  if (params.closeReason) {
    args.push("--close-reason", params.closeReason);
  }
  if (params.resolution) {
    args.push("--resolution", params.resolution);
  }
  if (params.expectedResult) {
    args.push("--expected-result", params.expectedResult);
  }
  if (params.actualResult) {
    args.push("--actual-result", params.actualResult);
  }
  const created = context.runCli(args, { expectJson: true });
  expect(created.code).toBe(0);
  return (created.json as { item: { id: string } }).item.id;
}

describe("aggregate command helper coverage", () => {
  it("normalizes grouping, numeric aggregation, sorting, and status completion helpers", () => {
    const statusRegistry = resolveRuntimeStatusRegistry(SETTINGS_DEFAULTS.schema);

    expect(_testOnlyAggregateCommand.parseStatus(undefined, statusRegistry)).toBeUndefined();
    expect(_testOnlyAggregateCommand.parseStatus("all", statusRegistry)).toBeUndefined();
    expect(_testOnlyAggregateCommand.parseStatus("open", statusRegistry)).toBe("open");
    expect(() => _testOnlyAggregateCommand.parseStatus("all,open", statusRegistry)).toThrow(PmCliError);
    expect(() => _testOnlyAggregateCommand.parseStatus("open,closed", statusRegistry)).toThrow(PmCliError);
    expect(() => _testOnlyAggregateCommand.parseStatus("not-a-status", statusRegistry)).toThrow(PmCliError);
    expect(_testOnlyAggregateCommand.parseGroupBy(undefined)).toEqual(["status"]);
    expect(_testOnlyAggregateCommand.parseGroupBy("type, priority")).toEqual(["type", "priority"]);
    expect(() => _testOnlyAggregateCommand.parseGroupBy(" ")).toThrow(PmCliError);
    expect(() => _testOnlyAggregateCommand.parseGroupBy(",")).toThrow(PmCliError);
    expect(() => _testOnlyAggregateCommand.parseGroupBy("missing")).toThrow(PmCliError);

    expect(_testOnlyAggregateCommand.parseNumericAggregation({})).toBeNull();
    expect(_testOnlyAggregateCommand.parseNumericAggregation({ sum: " estimate " })).toEqual({
      field: "estimate",
      sum: true,
      avg: false,
    });
    expect(_testOnlyAggregateCommand.parseNumericAggregation({ avg: "estimate" })).toEqual({
      field: "estimate",
      sum: false,
      avg: true,
    });
    expect(_testOnlyAggregateCommand.parseNumericAggregation({ sum: "estimate", avg: "estimate" })).toEqual({
      field: "estimate",
      sum: true,
      avg: true,
    });
    expect(() => _testOnlyAggregateCommand.parseNumericAggregation({ sum: "estimate", avg: "priority" })).toThrow(
      PmCliError,
    );

    expect(_testOnlyAggregateCommand.normalizeTagGroupValue([" Beta ", "", "alpha", "beta"])).toBe("alpha,beta");
    expect(_testOnlyAggregateCommand.normalizeTagGroupValue([" ", ""])).toBeNull();

    const item = {
      parent: "pm-parent",
      type: "Task",
      priority: 2,
      status: "open",
      assignee: "agent",
      tags: ["zeta", "alpha"],
      sprint: "S1",
      release: "R1",
    } as const;
    expect(_testOnlyAggregateCommand.resolveGroupValue("parent", item)).toBe("pm-parent");
    expect(_testOnlyAggregateCommand.resolveGroupValue("assignee", { ...item, assignee: undefined })).toBeNull();
    expect(_testOnlyAggregateCommand.resolveGroupValue("tags", item)).toBe("alpha,zeta");
    expect(_testOnlyAggregateCommand.resolveGroupValue("sprint", { ...item, sprint: undefined })).toBeNull();
    expect(_testOnlyAggregateCommand.resolveGroupValue("release", { ...item, release: undefined })).toBeNull();
    expect(_testOnlyAggregateCommand.resolveGroupValue("unknown" as never, item)).toBeNull();

    expect(_testOnlyAggregateCommand.compareNullableGroupValue(null, "a")).toBe(1);
    expect(_testOnlyAggregateCommand.compareNullableGroupValue("a", null)).toBe(-1);
    expect(_testOnlyAggregateCommand.compareNullableGroupValue(1, 3)).toBe(-2);
    expect(_testOnlyAggregateCommand.buildGroupKey(["type", "status"], { type: "Task", status: "open" })).toBe(
      'type:"Task"|status:"open"',
    );
    expect(
      _testOnlyAggregateCommand.compareAggregateRows(
        { group: { priority: 2 }, count: 1 },
        { group: { priority: 1 }, count: 1 },
        ["priority"],
      ),
    ).toBe(1);
    expect(
      _testOnlyAggregateCommand.compareAggregateRows(
        { group: { priority: 1 }, count: 1 },
        { group: { priority: 1 }, count: 2 },
        ["priority"],
      ),
    ).toBe(0);

    expect(_testOnlyAggregateCommand.readNumericAggregateValue({ estimate: 3 } as never, "estimate")).toBe(3);
    expect(_testOnlyAggregateCommand.readNumericAggregateValue({ estimate: " 4 " } as never, "estimate")).toBe(4);
    expect(_testOnlyAggregateCommand.readNumericAggregateValue({ estimate: " " } as never, "estimate")).toBeNull();
    expect(_testOnlyAggregateCommand.readNumericAggregateValue({ estimate: "nope" } as never, "estimate")).toBeNull();
    expect(_testOnlyAggregateCommand.completionPct(0, 0)).toBe(0);
    expect(_testOnlyAggregateCommand.completionPct(1, 3)).toBe(33.33);

    const accumulator = {
      row: { group: {}, count: 0 },
      numeric_count: 0,
      numeric_sum: 0,
      null_count: 0,
      open_count: 0,
      in_progress_count: 0,
      closed_count: 0,
      other_count: 0,
    };
    const registryWithCustomActive = {
      ...statusRegistry,
      active_statuses: new Set([...statusRegistry.active_statuses, "custom_status"]),
    };
    _testOnlyAggregateCommand.updateCompletionCounts(accumulator, "open", statusRegistry);
    _testOnlyAggregateCommand.updateCompletionCounts(accumulator, "in_progress", statusRegistry);
    _testOnlyAggregateCommand.updateCompletionCounts(accumulator, "blocked", statusRegistry);
    _testOnlyAggregateCommand.updateCompletionCounts(accumulator, "closed", statusRegistry);
    _testOnlyAggregateCommand.updateCompletionCounts(accumulator, "draft", statusRegistry);
    _testOnlyAggregateCommand.updateCompletionCounts(
      accumulator,
      "custom_status" as ItemStatus,
      registryWithCustomActive,
    );
    expect(accumulator).toMatchObject({
      open_count: 1,
      in_progress_count: 2,
      closed_count: 1,
      other_count: 2,
    });
  });
});

describe("runAggregate", () => {
  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-aggregate-not-init-"));
    try {
      await expect(runAggregate({ groupBy: "parent,type", count: true }, { path: tempDir })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("groups child counts by parent and type", async () => {
    await withTempPmPath(async (context) => {
      const parentId = createItem(context, {
        title: "Aggregate Parent Feature",
        type: "Feature",
        status: "open",
      });
      createItem(context, {
        title: "Aggregate Child Task A",
        type: "Task",
        status: "open",
        parent: parentId,
      });
      createItem(context, {
        title: "Aggregate Child Task B",
        type: "Task",
        status: "closed",
        parent: parentId,
      });
      createItem(context, {
        title: "Aggregate Child Issue",
        type: "Issue",
        status: "open",
        parent: parentId,
      });
      createItem(context, {
        title: "Unparented Task",
        type: "Task",
        status: "open",
      });

      const result = await runAggregate(
        {
          groupBy: "parent,type",
          count: true,
        },
        { path: context.pmPath },
      );

      expect(result.filters.group_by).toEqual(["parent", "type"]);
      expect(result.count).toBe(2);
      expect(result.groups.map(stripGroupLabel)).toEqual([
        {
          group: {
            parent: parentId,
            type: "Issue",
          },
          count: 1,
        },
        {
          group: {
            parent: parentId,
            type: "Task",
          },
          count: 2,
        },
      ]);
      expect(result.totals.items_considered).toBe(5);
      expect(result.totals.items_skipped_unparented).toBe(2);
      expect(result.totals.items_grouped).toBe(3);
    });
  });

  it("includes unparented groups when includeUnparented is enabled", async () => {
    await withTempPmPath(async (context) => {
      const parentId = createItem(context, {
        title: "Aggregate Parent",
        type: "Feature",
        status: "open",
      });
      createItem(context, {
        title: "Parented Child Task",
        type: "Task",
        status: "open",
        parent: parentId,
      });
      createItem(context, {
        title: "Unparented Task",
        type: "Task",
        status: "open",
      });

      const result = await runAggregate(
        {
          groupBy: "parent,type",
          count: true,
          includeUnparented: true,
          type: "Task",
        },
        { path: context.pmPath },
      );

      expect(result.count).toBe(2);
      expect(result.groups.map(stripGroupLabel)).toEqual([
        {
          group: {
            parent: parentId,
            type: "Task",
          },
          count: 1,
        },
        {
          group: {
            parent: null,
            type: "Task",
          },
          count: 1,
        },
      ]);
      expect(result.totals.items_skipped_unparented).toBe(0);
      expect(result.totals.items_grouped).toBe(2);
    });
  });

  it("emits only requested group dimensions for type-only grouping", async () => {
    await withTempPmPath(async (context) => {
      const parentId = createItem(context, {
        title: "Type Group Parent",
        type: "Feature",
        status: "open",
      });
      createItem(context, {
        title: "Type Group Child Task",
        type: "Task",
        status: "open",
        parent: parentId,
      });
      createItem(context, {
        title: "Type Group Unparented Task",
        type: "Task",
        status: "open",
      });

      const result = await runAggregate(
        {
          groupBy: "type",
          count: true,
          type: "Task",
        },
        { path: context.pmPath },
      );

      expect(result.filters.group_by).toEqual(["type"]);
      expect(result.count).toBe(1);
      expect(result.groups.map(stripGroupLabel)).toEqual([
        {
          group: {
            type: "Task",
          },
          count: 2,
        },
      ]);
      expect(Object.keys(result.groups[0]!.group)).toEqual(["type"]);
      expect(result.totals.items_skipped_unparented).toBe(0);
      expect(result.totals.items_grouped).toBe(2);
    });
  });

  it("renders explicit display labels, including (unassigned) for blank assignee groups (GH-225)", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, { title: "Assigned Task", type: "Task", status: "open", assignee: "alice" });
      createItem(context, { title: "Unassigned Task A", type: "Task", status: "open", assignee: null });
      createItem(context, { title: "Unassigned Task B", type: "Task", status: "closed", assignee: null });

      const byAssignee = await runAggregate(
        { groupBy: "assignee", count: true },
        { path: context.pmPath },
      );
      const labels = new Map(byAssignee.groups.map((row) => [row.group_label, row.count]));
      expect(labels.get("(unassigned)")).toBe(2);
      expect(labels.get("alice")).toBe(1);
      // The structured group value keeps the raw null for machine consumers.
      const unassigned = byAssignee.groups.find((row) => row.group_label === "(unassigned)");
      expect(unassigned?.group.assignee).toBeNull();

      // Multi-field grouping joins per-field labels so composite groups stay unambiguous.
      const composite = await runAggregate(
        { groupBy: "assignee,type", count: true },
        { path: context.pmPath },
      );
      expect(composite.groups.map((row) => row.group_label)).toContain("assignee=(unassigned) | type=Task");
    });
  });

  it("adds completion counters and percentage per aggregate group", async () => {
    await withTempPmPath(async (context) => {
      const parentId = createItem(context, {
        title: "Completion Parent",
        type: "Feature",
        status: "open",
      });
      createItem(context, {
        title: "Completion Open Task",
        type: "Task",
        status: "open",
        parent: parentId,
      });
      createItem(context, {
        title: "Completion Active Task",
        type: "Task",
        status: "in_progress",
        parent: parentId,
      });
      createItem(context, {
        title: "Completion Closed Task",
        type: "Task",
        status: "closed",
        parent: parentId,
      });
      createItem(context, {
        title: "Completion Draft Task",
        type: "Task",
        status: "draft",
        parent: parentId,
      });

      const result = await runAggregate(
        {
          groupBy: "parent,type",
          completion: true,
        },
        { path: context.pmPath },
      );

      expect(result.filters.completion).toBe(true);
      expect(result.groups.map(stripGroupLabel)).toEqual([
        {
          group: {
            parent: parentId,
            type: "Task",
          },
          count: 4,
          open: 1,
          in_progress: 1,
          closed: 1,
          other: 1,
          completion_pct: 25,
        },
      ]);
    });
  });

  it("supports expanded group-by dimensions", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, {
        title: "Expanded Group Task A",
        type: "Task",
        status: "open",
        priority: 2,
        assignee: "alice",
        tags: "alpha,beta",
        sprint: "sprint-1",
        release: "release-1",
      });
      createItem(context, {
        title: "Expanded Group Task B",
        type: "Task",
        status: "closed",
        priority: 1,
        assignee: null,
        tags: "alpha",
        sprint: "sprint-1",
        release: "release-1",
      });
      createItem(context, {
        title: "Expanded Group Issue",
        type: "Issue",
        status: "open",
        priority: 2,
        assignee: "bob",
        tags: "beta",
      });

      const byStatus = await runAggregate(
        {
          groupBy: "status",
          count: true,
        },
        { path: context.pmPath },
      );
      expect(byStatus.filters.group_by).toEqual(["status"]);
      expect(byStatus.groups.map(stripGroupLabel)).toEqual([
        {
          group: {
            status: "closed",
          },
          count: 1,
        },
        {
          group: {
            status: "open",
          },
          count: 2,
        },
      ]);

      const byPriorityAssignee = await runAggregate(
        {
          groupBy: "priority,assignee",
          count: true,
        },
        { path: context.pmPath },
      );
      expect(byPriorityAssignee.groups.map(stripGroupLabel)).toEqual([
        {
          group: {
            priority: 1,
            assignee: null,
          },
          count: 1,
        },
        {
          group: {
            priority: 2,
            assignee: "alice",
          },
          count: 1,
        },
        {
          group: {
            priority: 2,
            assignee: "bob",
          },
          count: 1,
        },
      ]);

      const byTags = await runAggregate(
        {
          groupBy: "tags",
          count: true,
        },
        { path: context.pmPath },
      );
      expect(byTags.groups.map(stripGroupLabel)).toEqual([
        {
          group: {
            tags: "alpha",
          },
          count: 1,
        },
        {
          group: {
            tags: "alpha,beta",
          },
          count: 1,
        },
        {
          group: {
            tags: "beta",
          },
          count: 1,
        },
      ]);

      const bySprintRelease = await runAggregate(
        {
          groupBy: "sprint,release",
          count: true,
        },
        { path: context.pmPath },
      );
      expect(bySprintRelease.groups.map(stripGroupLabel)).toEqual([
        {
          group: {
            sprint: "sprint-1",
            release: "release-1",
          },
          count: 2,
        },
        {
          group: {
            sprint: null,
            release: null,
          },
          count: 1,
        },
      ]);
    });
  });

  it("computes numeric aggregates and preserves forwarded list filters", async () => {
    await withTempPmPath(async (context) => {
      const parentId = createItem(context, {
        title: "Numeric Aggregate Parent",
        type: "Feature",
        status: "open",
        release: "release-numeric",
      });
      createItem(context, {
        title: "Numeric Aggregate Task A",
        type: "Task",
        status: "open",
        parent: parentId,
        priority: 2,
        tags: "numeric,alpha",
        assignee: "alice",
        sprint: "sprint-numeric",
        release: "release-numeric",
      });
      createItem(context, {
        title: "Numeric Aggregate Task B",
        type: "Task",
        status: "closed",
        parent: parentId,
        priority: 4,
        tags: "numeric,beta",
        assignee: "alice",
        sprint: "sprint-numeric",
        release: "release-numeric",
      });
      createItem(context, {
        title: "Numeric Aggregate Task C",
        type: "Task",
        status: "open",
        parent: parentId,
        priority: 1,
        tags: "other",
        assignee: "bob",
        sprint: "sprint-other",
        release: "release-other",
      });

      const result = await runAggregate(
        {
          groupBy: "type",
          sum: "priority",
          avg: "priority",
          type: "Task",
          tag: "numeric",
          parent: parentId,
          assignee: "alice",
          assigneeFilter: "assigned",
          sprint: "sprint-numeric",
          release: "release-numeric",
        },
        { path: context.pmPath },
      );

      expect(result.filters).toMatchObject({
        group_by: ["type"],
        numeric_field: "priority",
        sum: "priority",
        avg: "priority",
        type: "Task",
        tag: "numeric",
        parent: parentId,
        assignee: "alice",
        assignee_filter: "assigned",
        sprint: "sprint-numeric",
        release: "release-numeric",
      });
      expect(result.groups.map(stripGroupLabel)).toEqual([
        {
          group: {
            type: "Task",
          },
          count: 2,
          null_count: 0,
          sum: 6,
          avg: 3,
        },
      ]);
      expect(result.totals.items_considered).toBe(2);
    });
  });

  it("treats aggregate --status all as an all-status sentinel", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, {
        title: "Aggregate Open Task",
        type: "Task",
        status: "open",
      });
      createItem(context, {
        title: "Aggregate Closed Task",
        type: "Task",
        status: "closed",
      });

      const result = await runAggregate(
        {
          groupBy: "status",
          count: true,
          status: "all",
        },
        { path: context.pmPath },
      );

      expect(result.filters.status).toBeNull();
      expect(result.groups.map(stripGroupLabel)).toEqual([
        {
          group: {
            status: "closed",
          },
          count: 1,
        },
        {
          group: {
            status: "open",
          },
          count: 1,
        },
      ]);
    });
  });

  it("reports null numeric aggregates for fields not present on listed items", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, {
        title: "Missing Numeric Task",
        type: "Task",
        status: "open",
      });

      const result = await runAggregate(
        {
          groupBy: "type",
          avg: "missing_numeric_field",
        },
        { path: context.pmPath },
      );

      expect(result.groups.map(stripGroupLabel)).toEqual([
        {
          group: {
            type: "Task",
          },
          count: 1,
          null_count: 1,
          avg: null,
        },
      ]);
    });
  });

  it("increments null_count when repeated groups have null numeric values", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, {
        title: "Missing Numeric Task A",
        type: "Task",
        status: "open",
      });
      createItem(context, {
        title: "Missing Numeric Task B",
        type: "Task",
        status: "open",
      });

      const result = await runAggregate(
        {
          groupBy: "status",
          avg: "missing_numeric_field",
          type: "Task",
        },
        { path: context.pmPath },
      );

      expect(result.groups.map(stripGroupLabel)).toEqual([
        {
          group: {
            status: "open",
          },
          count: 2,
          null_count: 2,
          avg: null,
        },
      ]);
    });
  });

  it("accumulates null numeric values into an existing aggregate group", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, {
        title: "Numeric Existing Group A",
        type: "Task",
        status: "open",
        tags: "numeric-existing",
      });
      const secondId = createItem(context, {
        title: "Numeric Existing Group B",
        type: "Task",
        status: "open",
        tags: "numeric-existing",
      });
      context.runCli(["update", secondId, "--estimate", "none", "--message", "clear estimate", "--json"], { expectJson: true });

      const result = await runAggregate(
        {
          groupBy: "status",
          sum: "estimated_minutes",
          avg: "estimated_minutes",
          tag: "numeric-existing",
        },
        { path: context.pmPath },
      );

      expect(result.groups.map(stripGroupLabel)).toEqual([
        {
          group: {
            status: "open",
          },
          count: 2,
          null_count: 1,
          sum: 15,
          avg: 15,
        },
      ]);
    });
  });

  it("supports sum-only numeric aggregation and emits forwarded list warnings", async () => {
    await withTempPmPath(async (context) => {
      vi.resetModules();
      const runListMock = vi.fn(async () => ({
        items: [
          {
            type: "Task",
            status: "open",
            priority: 3,
            tags: [],
          },
        ],
        warnings: ["aggregate:list-warning"],
      }));
      vi.doMock("../../../src/cli/commands/list.js", () => ({
        runList: runListMock,
      }));

      try {
        const aggregateModule = await import("../../../src/cli/commands/aggregate.js");
        const result = await aggregateModule.runAggregate(
          {
            groupBy: "status",
            sum: "priority",
          },
          { path: context.pmPath },
        );

        expect(runListMock).toHaveBeenCalledTimes(1);
        expect(result.warnings).toEqual(["aggregate:list-warning"]);
        expect(result.groups.map(stripGroupLabel)).toEqual([
          {
            group: {
              status: "open",
            },
            count: 1,
            null_count: 0,
            sum: 3,
          },
        ]);
      } finally {
        vi.doUnmock("../../../src/cli/commands/list.js");
        vi.resetModules();
      }
    });
  });

  it("validates required and supported options", async () => {
    await withTempPmPath(async (context) => {
      const defaultCountResult = await runAggregate({ groupBy: "parent,type" }, { path: context.pmPath });
      expect(defaultCountResult.filters.count).toBe(true);
      await expect(
        runAggregate(
          {
            groupBy: "parent,unknown",
            count: true,
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runAggregate({ count: true, status: "invalid-status" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>(
        {
          exitCode: EXIT_CODE.USAGE,
        },
      );
      await expect(
        runAggregate(
          {
            groupBy: "parent,type",
            count: false,
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runAggregate({ groupBy: "   ", count: true }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: "--group-by requires at least one field name",
      });
      await expect(runAggregate({ sum: "priority", avg: "estimate" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: "Aggregate --sum and --avg must target the same numeric field",
      });
    });
  });
});

describe("runNormalize", () => {
  it("fails before list/update work when the tracker is missing or the status filter is invalid", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-normalize-not-init-"));
    try {
      await expect(
        runNormalize(
          {
            status: "open",
            list: {},
          },
          { path: tempDir },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }

    await withTempPmPath(async (context) => {
      await expect(
        runNormalize(
          {
            status: "definitely-not-a-status",
            list: {},
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("plans and applies lifecycle metadata normalization without touching clean items", async () => {
    await withTempPmPath(async (context) => {
      const activeId = createItem(context, {
        title: "Normalize Active Metadata",
        type: "Task",
        status: "open",
        blockedReason: "Closed because dependency finished",
        resolution: "todo",
        actualResult: "N/A",
      });
      const closedId = createItem(context, {
        title: "Normalize Closed Metadata",
        type: "Task",
        status: "closed",
        resolution: "todo",
        expectedResult: "unknown",
        actualResult: "placeholder",
      });
      const cleanId = createItem(context, {
        title: "Normalize Clean Active",
        type: "Task",
        status: "open",
      });

      const dryRun = await runNormalize(
        {
          list: {},
          dryRun: true,
          apply: false,
        },
        { path: context.pmPath },
      );

      expect(dryRun).toMatchObject({
        mode: "dry_run",
        dry_run: true,
        matched_count: 3,
        ids: [],
      });
      expect(dryRun.rules).toEqual([
        "active_closure_like_metadata",
        "closed_resolution_backfill",
      ]);
      expect(dryRun.warnings).toEqual([
        "normalize_active_closure_like_metadata:1",
        "normalize_closed_resolution_backfill:1",
      ]);
      const plansById = new Map(dryRun.item_plans.map((plan) => [plan.id, plan]));
      expect(plansById.get(activeId)?.changes).toEqual([
        {
          field: "actual_result",
          before: "N/A",
          after: null,
          rule: "active_closure_like_metadata",
        },
        {
          field: "resolution",
          before: "todo",
          after: null,
          rule: "active_closure_like_metadata",
        },
      ]);
      expect(plansById.get(cleanId)?.changes).toEqual([]);
      expect(plansById.get(closedId)?.changes).toEqual([
        {
          field: "actual_result",
          before: "placeholder",
          // GH-249: `pm create --status closed` now records a close_reason under
          // governance.require_close_reason, so the backfill cites the existing
          // close_reason as the detailed closure evidence.
          after: "Actual closure outcome normalized from closed status; existing close_reason remains the detailed closure evidence.",
          rule: "closed_resolution_backfill",
        },
        {
          field: "expected_result",
          before: "unknown",
          after: "Expected closure outcome normalized from closed status; existing close_reason remains the detailed closure evidence.",
          rule: "closed_resolution_backfill",
        },
        {
          field: "resolution",
          before: "todo",
          after: "Resolution normalized from closed status; existing close_reason remains the detailed closure evidence.",
          rule: "closed_resolution_backfill",
        },
      ]);

      await expect(
        runNormalize(
          {
            list: {},
            dryRun: true,
            apply: true,
          },
          { path: context.pmPath },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });

      const applied = await runNormalize(
        {
          list: {},
          apply: true,
          author: "normalize-test",
          message: "Apply normalize test",
        },
        { path: context.pmPath },
      );

      expect(applied).toMatchObject({
        mode: "apply",
        dry_run: false,
        matched_count: 3,
        updated_count: 2,
        skipped_count: 1,
        failed_count: 0,
      });
      expect(applied.ids).toEqual(expect.arrayContaining([activeId, closedId]));
      expect(applied.ids).toHaveLength(2);
      const rowsById = new Map(applied.rows?.map((row) => [row.id, row]));
      expect(rowsById.get(activeId)).toEqual(
        expect.objectContaining({
          id: activeId,
          status: "updated",
          changed_fields: expect.arrayContaining(["resolution", "actual_result"]),
        }),
      );
      expect(rowsById.get(cleanId)).toEqual({
        id: cleanId,
        status: "skipped",
      });
      expect(rowsById.get(closedId)).toEqual(
        expect.objectContaining({
          id: closedId,
          status: "updated",
          changed_fields: expect.arrayContaining(["resolution", "expected_result", "actual_result"]),
        }),
      );
    });
  });
});
