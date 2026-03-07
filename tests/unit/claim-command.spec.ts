import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runClaim, runRelease } from "../../src/cli/commands/claim.js";
import { EXIT_CODE } from "../../src/constants.js";
import { PmCliError } from "../../src/errors.js";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

function createTask(
  context: TempPmContext,
  params: {
    title: string;
    status: "open" | "closed";
    assignee?: string;
  },
): string {
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
      "1",
      "--tags",
      "testing",
      "--body",
      "",
      "--deadline",
      "none",
      "--estimate",
      "10",
      "--acceptance-criteria",
      `${params.title} acceptance`,
      "--author",
      "test-author",
      "--message",
      `Create ${params.title}`,
      "--assignee",
      params.assignee ?? "none",
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
  const payload = result.json as { item?: { id?: string } };
  expect(typeof payload.item?.id).toBe("string");
  return payload.item?.id ?? "";
}

describe("runClaim/runRelease", () => {
  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-claim-not-init-"));
    try {
      await expect(runClaim("pm-missing", false, { path: tempDir })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
      await expect(runRelease("pm-missing", false, { path: tempDir })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("claims unassigned items for current author", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, { title: "claim-open", status: "open" });
      const result = await runClaim(id, false, { path: context.pmPath });
      expect(result.claimed_by).toBe("test-author");
      expect(result.previous_assignee).toBeNull();
      expect(result.forced).toBe(false);
      expect(result.item.assignee).toBe("test-author");
    });
  });

  it("rejects claiming terminal items unless forced", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, { title: "claim-closed", status: "closed" });
      await expect(runClaim(id, false, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.CONFLICT,
      });

      const forcedResult = await runClaim(id, true, { path: context.pmPath });
      expect(forcedResult.forced).toBe(true);
      expect(forcedResult.item.assignee).toBe("test-author");
    });
  });

  it("supports re-claiming already-owned items and blocks foreign assignees unless forced", async () => {
    await withTempPmPath(async (context) => {
      const mine = createTask(context, {
        title: "claim-current-assignee",
        status: "open",
        assignee: "test-author",
      });
      const mineResult = await runClaim(mine, false, { path: context.pmPath });
      expect(mineResult.previous_assignee).toBe("test-author");
      expect(mineResult.forced).toBe(false);

      const foreign = createTask(context, {
        title: "claim-foreign-assignee",
        status: "open",
        assignee: "other-author",
      });
      await expect(runClaim(foreign, false, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.CONFLICT,
      });

      const forced = await runClaim(foreign, true, { path: context.pmPath });
      expect(forced.previous_assignee).toBe("other-author");
      expect(forced.forced).toBe(true);
      expect(forced.item.assignee).toBe("test-author");
    });
  });

  it("returns unchanged when releasing unassigned items", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, { title: "release-unassigned", status: "open" });
      const result = await runRelease(id, false, { path: context.pmPath });
      expect(result.previous_assignee).toBeNull();
      expect(result.forced).toBe(false);
      expect(result.item.assignee).toBeUndefined();
    });
  });

  it("releases current author assignments and blocks foreign assignees unless forced", async () => {
    await withTempPmPath(async (context) => {
      const current = createTask(context, {
        title: "release-current-assignee",
        status: "open",
        assignee: "test-author",
      });
      const currentResult = await runRelease(current, false, { path: context.pmPath });
      expect(currentResult.previous_assignee).toBe("test-author");
      expect(currentResult.forced).toBe(false);
      expect(currentResult.item.assignee).toBeUndefined();

      const foreign = createTask(context, {
        title: "release-foreign-assignee",
        status: "open",
        assignee: "other-author",
      });
      await expect(runRelease(foreign, false, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.CONFLICT,
      });

      const forced = await runRelease(foreign, true, { path: context.pmPath });
      expect(forced.previous_assignee).toBe("other-author");
      expect(forced.forced).toBe(true);
      expect(forced.item.assignee).toBeUndefined();
    });
  });

  it("covers missing PM_AUTHOR fallback for claim and release", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, { title: "author-fallback", status: "open" });
      const previousAuthor = process.env.PM_AUTHOR;
      delete process.env.PM_AUTHOR;
      try {
        const claimResult = await runClaim(id, false, { path: context.pmPath });
        expect(claimResult.item.assignee).toBe("unknown");

        const releaseResult = await runRelease(id, false, { path: context.pmPath });
        expect(releaseResult.item.assignee).toBeUndefined();
      } finally {
        if (previousAuthor === undefined) {
          delete process.env.PM_AUTHOR;
        } else {
          process.env.PM_AUTHOR = previousAuthor;
        }
      }
    });
  });

  it("uses explicit author and message metadata when provided", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, { title: "explicit-mutation-metadata", status: "open" });
      const previousAuthor = process.env.PM_AUTHOR;
      process.env.PM_AUTHOR = "env-default-author";
      try {
        await runClaim(id, false, { path: context.pmPath }, { author: "claim-author", message: "claim message" });
        const claimHistory = context.runCli(["history", id, "--json", "--limit", "1"], { expectJson: true });
        expect(claimHistory.code).toBe(0);
        const claimEntry = (claimHistory.json as { history: Array<{ op: string; author: string; message?: string }> }).history[0];
        expect(claimEntry.op).toBe("claim");
        expect(claimEntry.author).toBe("claim-author");
        expect(claimEntry.message).toBe("claim message");

        await runRelease(id, true, { path: context.pmPath }, { author: "release-author", message: "release message" });
        const releaseHistory = context.runCli(["history", id, "--json", "--limit", "1"], { expectJson: true });
        expect(releaseHistory.code).toBe(0);
        const releaseEntry = (releaseHistory.json as { history: Array<{ op: string; author: string; message?: string }> })
          .history[0];
        expect(releaseEntry.op).toBe("release");
        expect(releaseEntry.author).toBe("release-author");
        expect(releaseEntry.message).toBe("release message");
      } finally {
        if (previousAuthor === undefined) {
          delete process.env.PM_AUTHOR;
        } else {
          process.env.PM_AUTHOR = previousAuthor;
        }
      }
    });
  });
});
