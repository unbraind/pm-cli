import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runAggregate } from "../../src/cli/commands/aggregate.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import { PmCliError } from "../../src/core/shared/errors.js";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

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
  const created = context.runCli(args, { expectJson: true });
  expect(created.code).toBe(0);
  return (created.json as { item: { id: string } }).item.id;
}

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
      expect(result.groups).toEqual([
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
      expect(result.groups).toEqual([
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
      expect(result.groups).toEqual([
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
      expect(result.groups).toEqual([
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
      expect(byStatus.groups).toEqual([
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
      expect(byPriorityAssignee.groups).toEqual([
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
      expect(byTags.groups).toEqual([
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
      expect(bySprintRelease.groups).toEqual([
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
      expect(result.groups).toEqual([
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

      expect(result.groups).toEqual([
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
