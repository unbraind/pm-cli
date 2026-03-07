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
}): void {
  const result = context.runCli(
    [
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
      "none",
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
    ],
    { expectJson: true },
  );
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
});
