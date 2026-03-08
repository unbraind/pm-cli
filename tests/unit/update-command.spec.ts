import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runUpdate } from "../../src/cli/commands/update.js";
import { EXIT_CODE } from "../../src/constants.js";
import { PmCliError } from "../../src/errors.js";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

interface CreateTaskOptions {
  assignee?: string;
  deadline?: string;
  estimate?: string;
  acceptanceCriteria?: string;
}

function createTask(context: TempPmContext, title: string, options: CreateTaskOptions = {}): string {
  const created = context.runCli(
    [
      "create",
      "--json",
      "--title",
      title,
      "--description",
      `${title} description`,
      "--type",
      "Task",
      "--status",
      "open",
      "--priority",
      "1",
      "--tags",
      "update,unit",
      "--body",
      "",
      "--deadline",
      options.deadline ?? "2026-03-01T00:00:00.000Z",
      "--estimate",
      options.estimate ?? "30",
      "--acceptance-criteria",
      options.acceptanceCriteria ?? `${title} acceptance`,
      "--author",
      "seed-author",
      "--message",
      `Create ${title}`,
      "--assignee",
      options.assignee ?? "none",
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

  expect(created.code).toBe(0);
  return (created.json as { item: { id: string } }).item.id;
}

function latestUpdateAuthor(context: TempPmContext, id: string): string | undefined {
  const history = context.runCli(["history", id, "--json"], { expectJson: true });
  expect(history.code).toBe(0);
  const entries = (history.json as { history: Array<{ op: string; author: string }> }).history;
  return [...entries].reverse().find((entry) => entry.op === "update")?.author;
}

describe("runUpdate", () => {
  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-update-not-init-"));
    try {
      await expect(runUpdate("pm-missing", { description: "new description" }, { path: tempDir })).rejects.toMatchObject<
        PmCliError
      >({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("requires at least one update flag", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-no-flags");
      await expect(runUpdate(id, {}, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("updates scalar fields with valid values", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-explicit-values");
      const result = await runUpdate(
        id,
        {
          title: "updated title",
          description: "updated description",
          status: "blocked",
          priority: "4",
          type: "Issue",
          tags: "zeta,alpha,alpha",
          deadline: "+1d",
          estimatedMinutes: "45",
          acceptanceCriteria: "new acceptance",
          assignee: " next-assignee ",
          parent: " pm-parent-next ",
          reviewer: " reviewer-next ",
          risk: "critical",
          sprint: " sprint-next ",
          release: " release-next ",
          blockedBy: " pm-blocking-next ",
          blockedReason: " blocked waiting reason ",
          author: " explicit-author ",
          message: "apply explicit update",
        },
        { path: context.pmPath },
      );

      expect(result.warnings).toEqual([]);
      expect(result.changed_fields).toEqual(
        expect.arrayContaining([
          "title",
          "description",
          "status",
          "priority",
          "type",
          "tags",
          "deadline",
          "estimated_minutes",
          "acceptance_criteria",
          "assignee",
          "parent",
          "reviewer",
          "risk",
          "sprint",
          "release",
          "blocked_by",
          "blocked_reason",
        ]),
      );

      const item = result.item as Record<string, unknown>;
      expect(item.title).toBe("updated title");
      expect(item.description).toBe("updated description");
      expect(item.status).toBe("blocked");
      expect(item.priority).toBe(4);
      expect(item.type).toBe("Issue");
      expect(item.tags).toEqual(["alpha", "zeta"]);
      expect(typeof item.deadline).toBe("string");
      expect(Number.isNaN(Date.parse(String(item.deadline)))).toBe(false);
      expect(item.estimated_minutes).toBe(45);
      expect(item.acceptance_criteria).toBe("new acceptance");
      expect(item.assignee).toBe("next-assignee");
      expect(item.parent).toBe("pm-parent-next");
      expect(item.reviewer).toBe("reviewer-next");
      expect(item.risk).toBe("critical");
      expect(item.sprint).toBe("sprint-next");
      expect(item.release).toBe("release-next");
      expect(item.blocked_by).toBe("pm-blocking-next");
      expect(item.blocked_reason).toBe("blocked waiting reason");
      expect(latestUpdateAuthor(context, id)).toBe("explicit-author");
    });
  });

  it("supports explicit none-unset semantics and clears assignee for canceled status", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-unset-fields", { assignee: "active-owner" });
      const result = await runUpdate(
        id,
        {
          description: "closed description",
          status: "canceled",
          deadline: "none",
          estimatedMinutes: "none",
          acceptanceCriteria: "none",
          assignee: "none",
          parent: "none",
          reviewer: "none",
          risk: "none",
          sprint: "none",
          release: "none",
          blockedBy: "none",
          blockedReason: "none",
          author: "active-owner",
          message: "cancel and clear optional fields",
        },
        { path: context.pmPath },
      );

      expect(result.changed_fields).toEqual(
        expect.arrayContaining([
          "description",
          "status",
          "deadline",
          "estimated_minutes",
          "acceptance_criteria",
          "assignee",
          "parent",
          "reviewer",
          "risk",
          "sprint",
          "release",
          "blocked_by",
          "blocked_reason",
        ]),
      );

      const item = result.item as Record<string, unknown>;
      expect(item.status).toBe("canceled");
      expect(item.deadline).toBeUndefined();
      expect(item.estimated_minutes).toBeUndefined();
      expect(item.acceptance_criteria).toBeUndefined();
      expect(item.assignee).toBeUndefined();
      expect(item.parent).toBeUndefined();
      expect(item.reviewer).toBeUndefined();
      expect(item.risk).toBeUndefined();
      expect(item.sprint).toBeUndefined();
      expect(item.release).toBeUndefined();
      expect(item.blocked_by).toBeUndefined();
      expect(item.blocked_reason).toBeUndefined();
    });
  });

  it("clears assignee when assignee is blank whitespace", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-blank-assignee");
      const result = await runUpdate(
        id,
        {
          description: "clear assignee with whitespace",
          assignee: "   ",
        },
        { path: context.pmPath },
      );

      const item = result.item as Record<string, unknown>;
      expect(item.assignee).toBeUndefined();
    });
  });

  it("validates enum and numeric inputs", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-invalid-values");

      await expect(runUpdate(id, { status: "not-a-status" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runUpdate(id, { status: "closed" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: 'Invalid --status value "closed". Use "pm close <ID> <TEXT>" to close an item.',
      });
      await expect(runUpdate(id, { type: "NotAType" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runUpdate(id, { priority: "9" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runUpdate(id, { priority: "nope" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runUpdate(id, { risk: "extreme" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("resolves update author from env, settings, and unknown fallback", async () => {
    await withTempPmPath(async (context) => {
      const envAuthorId = createTask(context, "update-env-author");
      await runUpdate(
        envAuthorId,
        {
          description: "env-based author update",
          message: "env author",
        },
        { path: context.pmPath },
      );
      expect(latestUpdateAuthor(context, envAuthorId)).toBe("test-author");

      const previousPmAuthor = process.env.PM_AUTHOR;
      delete process.env.PM_AUTHOR;
      try {
        const settingsPath = path.join(context.pmPath, "settings.json");
        const settings = JSON.parse(await readFile(settingsPath, "utf8")) as { author_default?: string };
        settings.author_default = "settings-author";
        await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

        const settingsAuthorId = createTask(context, "update-settings-author");
        await runUpdate(
          settingsAuthorId,
          {
            description: "settings-based author update",
            message: "settings author",
          },
          { path: context.pmPath },
        );
        expect(latestUpdateAuthor(context, settingsAuthorId)).toBe("settings-author");

        settings.author_default = "   ";
        await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

        const unknownAuthorId = createTask(context, "update-unknown-author");
        await runUpdate(
          unknownAuthorId,
          {
            description: "unknown author update",
            author: "   ",
            message: "unknown author",
          },
          { path: context.pmPath },
        );
        expect(latestUpdateAuthor(context, unknownAuthorId)).toBe("unknown");
      } finally {
        if (previousPmAuthor === undefined) {
          delete process.env.PM_AUTHOR;
        } else {
          process.env.PM_AUTHOR = previousPmAuthor;
        }
      }
    });
  });

  it("blocks foreign assignment updates unless forced", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "update-force", { assignee: "foreign-assignee" });

      await expect(runUpdate(id, { description: "blocked update" }, { path: context.pmPath })).rejects.toMatchObject<
        PmCliError
      >({
        exitCode: EXIT_CODE.CONFLICT,
      });

      const forced = await runUpdate(
        id,
        {
          description: "forced update",
          force: true,
          message: "force update for foreign assignment",
        },
        { path: context.pmPath },
      );

      const item = forced.item as Record<string, unknown>;
      expect(item.description).toBe("forced update");
    });
  });
});
