import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runList } from "../../src/cli/commands/list.js";
import { EXIT_CODE } from "../../src/constants.js";
import { PmCliError } from "../../src/errors.js";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

function createItem(context: TempPmContext, params: {
  title: string;
  status: "open" | "blocked" | "closed";
  priority: string;
  tags: string;
  deadline: string;
  assignee?: string;
  sprint?: string;
  release?: string;
}): void {
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
    "",
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
    params.assignee ?? "none",
    "--sprint",
    params.sprint ?? "none",
    "--release",
    params.release ?? "none",
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
  const result = context.runCli(args, { expectJson: true });
  expect(result.code).toBe(0);
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

      const deadlineFiltered = await runList(
        undefined,
        { deadlineBefore: "+2d", deadlineAfter: "+1d" },
        { path: context.pmPath },
      );
      expect(deadlineFiltered.count).toBeGreaterThanOrEqual(1);
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

  it("applies assignee filter including none sentinel for unassigned", async () => {
    await withTempPmPath(async (context) => {
      createItem(context, {
        title: "Assigned Item",
        status: "open",
        priority: "1",
        tags: "test",
        deadline: "+1d",
        assignee: "agent-a",
      });
      createItem(context, {
        title: "Unassigned Item",
        status: "open",
        priority: "2",
        tags: "test",
        deadline: "+1d",
      });

      const byAssignee = await runList(undefined, { assignee: "agent-a" }, { path: context.pmPath });
      expect(byAssignee.count).toBe(1);
      expect(byAssignee.items[0].assignee).toBe("agent-a");
      expect(byAssignee.filters.assignee).toBe("agent-a");

      const unassigned = await runList(undefined, { assignee: "none" }, { path: context.pmPath });
      expect(unassigned.count).toBe(1);
      expect(unassigned.items[0].title).toBe("Unassigned Item");

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
});
