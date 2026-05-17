import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runList } from "../../src/cli/commands/list.js";
import { EXIT_CODE } from "../../src/core/shared/constants.js";
import { PmCliError } from "../../src/core/shared/errors.js";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

function createItem(context: TempPmContext, params: {
  title: string;
  status: "open" | "triage" | "blocked" | "closed";
  priority: string;
  tags: string;
  deadline: string;
  assignee?: string;
  parent?: string;
  sprint?: string;
  release?: string;
  body?: string;
}): string {
  const args = [
    "create",
    "--json",
    "--title",
    params.title,
    "--description",
    `${params.title} description`,
    "--type",
    "Task",
    "--status",
    params.status,
    "--priority",
    params.priority,
    "--tags",
    params.tags,
    "--body",
    params.body ?? "",
    "--deadline",
    params.deadline,
    "--estimate",
    "15",
    "--acceptance-criteria",
    `${params.title} acceptance`,
    "--author",
    "test-author",
    "--message",
    `Create ${params.title}`,
    "--assignee",
    params.assignee ?? "seed-assignee",
    "--dep",
    "id=pm-seed-related,kind=related,author=seed-author,created_at=now",
    "--comment",
    "author=seed-author,created_at=now,text=seed comment",
    "--note",
    "author=seed-author,created_at=now,text=seed note",
    "--learning",
    "author=seed-author,created_at=now,text=seed learning",
    "--file",
    "path=README.md,scope=project,note=seed file",
    "--test",
    "command=node dist/cli.js --version,scope=project,note=seed test",
    "--doc",
    "path=README.md,scope=project,note=seed doc",
  ];
  if (params.sprint !== undefined) {
    args.push("--sprint", params.sprint);
  }
  if (params.parent !== undefined) {
    args.push("--parent", params.parent);
  }
  if (params.release !== undefined) {
    args.push("--release", params.release);
  }
  const result = context.runCli(args, { expectJson: true });
  expect(result.code).toBe(0);
  return (result.json as { item: { id: string } }).item.id;
}

describe("runList", () => {
  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-list-not-init-"));
    try {
      await expect(runList(undefined, {}, { path: tempDir })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("applies status/field filters and limit", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, {
        title: "Open Alpha",
        status: "open",
        priority: "0",
        tags: "alpha,core",
        deadline: "+1d",
      });
      createItem(context, {
        title: "Blocked Beta",
        status: "blocked",
        priority: "2",
        tags: "beta",
        deadline: "+2d",
      });
      createItem(context, {
        title: "Closed Gamma",
        status: "closed",
        priority: "1",
        tags: "gamma",
        deadline: "+3d",
      });

      const openResult = await runList(
        "open",
        { type: "Task", tag: "alpha", priority: "0", limit: "1" },
        { path: context.pmPath },
      );
      expect(openResult.count).toBe(1);
      expect(openResult.items[0].status).toBe("open");
      expect(openResult.items[0].tags).toContain("alpha");
      expect(openResult.filters.limit).toBe("1");

      const blockedResult = await runList("blocked", {}, { path: context.pmPath });
      expect(blockedResult.count).toBe(1);
      expect(blockedResult.items[0].status).toBe("blocked");

      const offsetResult = await runList(undefined, { offset: "1", limit: "1" }, { path: context.pmPath });
      expect(offsetResult.count).toBe(1);
      expect(offsetResult.items[0].title).toBe("Blocked Beta");
      expect(offsetResult.filters.offset).toBe("1");
      expect(offsetResult.filters.limit).toBe("1");

      const deadlineFiltered = await runList(
        undefined,
        { deadlineBefore: "+2d", deadlineAfter: "+1d" },
        { path: context.pmPath },
      );
      expect(deadlineFiltered.count).toBeGreaterThanOrEqual(1);

      const flexibleDateString = await runList(
        undefined,
        { deadlineBefore: "2030-01-01T00-00Z" },
        { path: context.pmPath },
      );
      expect(flexibleDateString.count).toBe(3);

      const monthRelativeFilter = await runList(undefined, { deadlineAfter: "+1m" }, { path: context.pmPath });
      expect(monthRelativeFilter.count).toBe(0);
    });
  });

  it("maps list-open filters to workflow open_status", async () => {
    await withTempPmPath(async (context) => {
      const statusesPath = path.join(context.pmPath, "schema", "statuses.json");
      const workflowsPath = path.join(context.pmPath, "schema", "workflows.json");
      await writeFile(
        statusesPath,
        `${JSON.stringify(
          {
            statuses: [
              { id: "draft", roles: ["draft"] },
              { id: "triage", roles: ["active", "default_open"] },
              { id: "open", roles: ["active"] },
              { id: "in_progress", roles: ["active"] },
              { id: "blocked", roles: ["blocked"] },
              { id: "closed", roles: ["terminal", "terminal_done", "default_close"] },
              { id: "canceled", roles: ["terminal", "terminal_canceled", "default_cancel"] },
            ],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(
        workflowsPath,
        `${JSON.stringify(
          {
            workflow: {
              draft_status: "draft",
              open_status: "triage",
              in_progress_status: "in_progress",
              blocked_status: "blocked",
              close_status: "closed",
              canceled_status: "canceled",
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      createItem(context, {
        title: "Workflow Triage Item",
        status: "triage",
        priority: "1",
        tags: "workflow,triage",
        deadline: "+1d",
      });
      createItem(context, {
        title: "Workflow Open Item",
        status: "open",
        priority: "1",
        tags: "workflow,open",
        deadline: "+1d",
      });

      const openResult = await runList("open", {}, { path: context.pmPath });
      expect(openResult.count).toBe(1);
      expect(openResult.items[0].status).toBe("triage");
      expect(openResult.items[0].title).toBe("Workflow Triage Item");
      expect(openResult.filters.status).toBe("triage");
    });
  });

  it("includes item body only when includeBody is enabled", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, {
        title: "Body Projection",
        status: "open",
        priority: "1",
        tags: "body,test",
        deadline: "+1d",
        body: "Projected list body",
      });

      const withoutBody = await runList("open", {}, { path: context.pmPath });
      expect(withoutBody.count).toBe(1);
      expect(withoutBody.filters.include_body).toBeNull();
      expect(withoutBody.items[0]).not.toHaveProperty("body");

      const withBody = await runList("open", { includeBody: true }, { path: context.pmPath });
      expect(withBody.count).toBe(1);
      expect(withBody.filters.include_body).toBe(true);
      expect(withBody.items[0]).toHaveProperty("body", "Projected list body");
    });
  });

  it("excludes terminal statuses when excludeTerminal is true", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, {
        title: "Open Item",
        status: "open",
        priority: "1",
        tags: "test",
        deadline: "+1d",
      });
      createItem(context, {
        title: "Blocked Item",
        status: "blocked",
        priority: "2",
        tags: "test",
        deadline: "+2d",
      });
      createItem(context, {
        title: "Closed Item",
        status: "closed",
        priority: "0",
        tags: "test",
        deadline: "+3d",
      });

      // excludeTerminal=true: should exclude closed and blocked is still shown
      const activeOnly = await runList(undefined, { excludeTerminal: true }, { path: context.pmPath });
      expect(activeOnly.count).toBe(2);
      expect(activeOnly.items.every((item) => item.status !== "closed" && item.status !== "canceled")).toBe(true);

      // excludeTerminal=false (or undefined): should include all items
      const allItems = await runList(undefined, {}, { path: context.pmPath });
      expect(allItems.count).toBe(3);

      // status filter takes precedence over excludeTerminal (status filter is exact match)
      const closedExplicit = await runList("closed", { excludeTerminal: true }, { path: context.pmPath });
      expect(closedExplicit.count).toBe(0);

      // explicit --status on bare list should override active-only default filtering
      const closedViaStatusOption = await runList(undefined, { status: "closed", excludeTerminal: true }, { path: context.pmPath });
      expect(closedViaStatusOption.count).toBe(1);
      expect(closedViaStatusOption.items[0].status).toBe("closed");
    });
  });

  it("validates filter values", async () => {
    await withTempPmPath(async (context) => {
      await expect(runList(undefined, { priority: "8" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runList(undefined, { priority: "1.5" }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runList(undefined, { deadlineBefore: "bad-deadline" }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runList(undefined, { type: "NotAType" }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runList(undefined, { limit: "-1" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runList(undefined, { limit: "1.25" }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runList(undefined, { offset: "-1" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runList(undefined, { offset: "1.5" }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("applies non-matching type/tag/priority filters", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, {
        title: "Filter Target",
        status: "open",
        priority: "1",
        tags: "alpha,core",
        deadline: "+1d",
      });

      const wrongType = await runList(undefined, { type: "Issue" }, { path: context.pmPath });
      expect(wrongType.count).toBe(0);

      const normalizedType = await runList(undefined, { type: "task" }, { path: context.pmPath });
      expect(normalizedType.count).toBe(1);

      const wrongTag = await runList(undefined, { tag: "missing-tag" }, { path: context.pmPath });
      expect(wrongTag.count).toBe(0);

      const wrongPriority = await runList(undefined, { priority: "4" }, { path: context.pmPath });
      expect(wrongPriority.count).toBe(0);
    });
  });

  it("applies assignee and assignee-filter semantics for assignment state", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, {
        title: "Assigned Item",
        status: "open",
        priority: "1",
        tags: "test",
        deadline: "+1d",
        assignee: "agent-a",
      });
      const unassignedId = createItem(context, {
        title: "Unassigned Item",
        status: "open",
        priority: "2",
        tags: "test",
        deadline: "+1d",
      });
      const unsetResult = context.runCli(
        ["update", unassignedId, "--json", "--unset", "assignee", "--author", "seed-assignee"],
        { expectJson: true },
      );
      expect(unsetResult.code).toBe(0);

      const byAssignee = await runList(undefined, { assignee: "agent-a" }, { path: context.pmPath });
      expect(byAssignee.count).toBe(1);
      expect(byAssignee.items[0].assignee).toBe("agent-a");
      expect(byAssignee.filters.assignee).toBe("agent-a");

      const unassigned = await runList(undefined, { assigneeFilter: "unassigned" }, { path: context.pmPath });
      expect(unassigned.count).toBe(1);
      expect(unassigned.items[0].title).toBe("Unassigned Item");
      expect(unassigned.filters.assignee_filter).toBe("unassigned");

      await expect(runList(undefined, { assignee: "none" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });

      const noMatch = await runList(undefined, { assignee: "agent-z" }, { path: context.pmPath });
      expect(noMatch.count).toBe(0);
    });
  });

  it("applies sprint and release filters", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, {
        title: "Sprint Item",
        status: "open",
        priority: "1",
        tags: "test",
        deadline: "+1d",
        sprint: "sprint-1",
        release: "v1.0",
      });
      createItem(context, {
        title: "Other Sprint Item",
        status: "open",
        priority: "2",
        tags: "test",
        deadline: "+1d",
        sprint: "sprint-2",
        release: "v2.0",
      });

      const bySprint = await runList(undefined, { sprint: "sprint-1" }, { path: context.pmPath });
      expect(bySprint.count).toBe(1);
      expect(bySprint.items[0].title).toBe("Sprint Item");
      expect(bySprint.filters.sprint).toBe("sprint-1");

      const byRelease = await runList(undefined, { release: "v2.0" }, { path: context.pmPath });
      expect(byRelease.count).toBe(1);
      expect(byRelease.items[0].title).toBe("Other Sprint Item");
      expect(byRelease.filters.release).toBe("v2.0");

      const noSprintMatch = await runList(undefined, { sprint: "sprint-99" }, { path: context.pmPath });
      expect(noSprintMatch.count).toBe(0);

      const noReleaseMatch = await runList(undefined, { release: "v99.0" }, { path: context.pmPath });
      expect(noReleaseMatch.count).toBe(0);
    });
  });

  it("applies parent filters for hierarchical list views", async () => {
    await withTempPmPath(async (context) => {
      const parentA = createItem(context, {
        title: "Parent A",
        status: "open",
        priority: "1",
        tags: "hierarchy,parent",
        deadline: "+1d",
      });
      const parentB = createItem(context, {
        title: "Parent B",
        status: "open",
        priority: "1",
        tags: "hierarchy,parent",
        deadline: "+1d",
      });
      createItem(context, {
        title: "Child A1",
        status: "open",
        priority: "2",
        tags: "hierarchy,child",
        deadline: "+1d",
        parent: parentA,
      });
      createItem(context, {
        title: "Child B1",
        status: "open",
        priority: "2",
        tags: "hierarchy,child",
        deadline: "+1d",
        parent: parentB,
      });
      createItem(context, {
        title: "Unparented Child",
        status: "open",
        priority: "2",
        tags: "hierarchy,child",
        deadline: "+1d",
      });

      const parentFiltered = await runList(undefined, { parent: parentA }, { path: context.pmPath });
      expect(parentFiltered.count).toBe(1);
      expect(parentFiltered.items[0].title).toBe("Child A1");
      expect(parentFiltered.items[0].parent).toBe(parentA);
      expect(parentFiltered.filters.parent).toBe(parentA);

      const parentMiss = await runList(undefined, { parent: "pm-missing-parent" }, { path: context.pmPath });
      expect(parentMiss.count).toBe(0);
      expect(parentMiss.filters.parent).toBe("pm-missing-parent");
    });
  });

  it("supports compact and custom field projections", async () => {
    await withTempPmPath(async (context) => {
      const id = createItem(context, {
        title: "Projection Target",
        status: "open",
        priority: "1",
        tags: "projection,list",
        deadline: "+1d",
      });

      const compact = await runList(undefined, { compact: true }, { path: context.pmPath });
      expect(compact.projection).toEqual({
        mode: "compact",
        fields: ["id", "title", "status", "type", "priority", "parent", "updated_at"],
      });
      const compactItem = compact.items[0] as unknown as Record<string, unknown>;
      expect(Object.keys(compactItem)).toEqual(["id", "title", "status", "type", "priority", "parent", "updated_at"]);
      expect(compactItem.id).toBe(id);

      const fields = await runList(undefined, { fields: "id,title,parent" }, { path: context.pmPath });
      expect(fields.projection).toEqual({
        mode: "fields",
        fields: ["id", "title", "parent"],
      });
      const fieldItem = fields.items[0] as unknown as Record<string, unknown>;
      expect(Object.keys(fieldItem)).toEqual(["id", "title", "parent"]);
      expect(fieldItem.id).toBe(id);
      expect(fieldItem.title).toBe("Projection Target");

      const full = await runList(undefined, { full: true }, { path: context.pmPath });
      expect(full.projection).toEqual({
        mode: "full",
        fields: null,
      });
      expect(full.items[0]).toHaveProperty("priority");
    });
  });

  it("supports CSV status filters for multi-status agent queries", async () => {
    await withTempPmPath(async (context) => {
      const openId = createItem(context, {
        title: "Open CSV Target",
        status: "open",
        priority: "1",
        tags: "status,csv",
        deadline: "+1d",
      });
      const blockedId = createItem(context, {
        title: "Blocked CSV Target",
        status: "blocked",
        priority: "1",
        tags: "status,csv",
        deadline: "+1d",
      });
      createItem(context, {
        title: "Closed CSV Miss",
        status: "closed",
        priority: "1",
        tags: "status,csv",
        deadline: "+1d",
      });

      const result = await runList(undefined, { status: "open,blocked", tag: "status" }, { path: context.pmPath });

      expect(result.filters.status).toEqual(["open", "blocked"]);
      expect(result.items.map((item) => item.id).sort()).toEqual([blockedId, openId].sort());
    });
  });

  it("supports configurable list sorting and ordering", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, {
        title: "Bravo",
        status: "open",
        priority: "2",
        tags: "sort,list",
        deadline: "+2d",
      });
      createItem(context, {
        title: "Alpha",
        status: "open",
        priority: "0",
        tags: "sort,list",
        deadline: "none",
      });
      createItem(context, {
        title: "Charlie",
        status: "open",
        priority: "1",
        tags: "sort,list",
        deadline: "+1d",
      });

      const byTitleAsc = await runList(undefined, { sort: "title", order: "asc" }, { path: context.pmPath });
      expect(byTitleAsc.sorting).toEqual({
        sort: "title",
        order: "asc",
      });
      expect(byTitleAsc.items.map((item) => item.title)).toEqual(["Alpha", "Bravo", "Charlie"]);

      const byPriorityDesc = await runList(undefined, { sort: "priority", order: "desc" }, { path: context.pmPath });
      expect(byPriorityDesc.sorting).toEqual({
        sort: "priority",
        order: "desc",
      });
      expect(byPriorityDesc.items.map((item) => item.priority)).toEqual([2, 1, 0]);

      const byDeadlineAsc = await runList(undefined, { sort: "deadline", order: "asc" }, { path: context.pmPath });
      expect(byDeadlineAsc.items.map((item) => item.title)).toEqual(["Charlie", "Bravo", "Alpha"]);
    });
  });

  it("validates projection and sort option combinations", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, {
        title: "Validation target",
        status: "open",
        priority: "1",
        tags: "validation,list",
        deadline: "+1d",
      });

      await expect(runList(undefined, { compact: true, fields: "id" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runList(undefined, { full: true, fields: "id" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runList(undefined, { fields: "   " }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runList(undefined, { order: "asc" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runList(undefined, { sort: "unknown" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runList(undefined, { sort: "title", order: "sideways" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });
});
