import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runDelete } from "../../src/cli/commands/delete.js";
import { EXIT_CODE } from "../../src/constants.js";
import { PmCliError } from "../../src/errors.js";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

interface CreateTaskOptions {
  status?: "draft" | "open" | "in_progress" | "blocked" | "closed" | "canceled";
  assignee?: string;
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
      options.status ?? "open",
      "--priority",
      "1",
      "--tags",
      "delete,unit",
      "--body",
      "",
      "--deadline",
      "none",
      "--estimate",
      "20",
      "--acceptance-criteria",
      `${title} acceptance`,
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

function itemPathForTask(context: TempPmContext, id: string): string {
  return path.join(context.pmPath, "tasks", `${id}.md`);
}

function latestDeleteHistoryEntry(
  context: TempPmContext,
  id: string,
): { op: string; author: string; message?: string; patch: unknown[] } | undefined {
  const history = context.runCli(["history", id, "--json"], { expectJson: true });
  expect(history.code).toBe(0);
  const entries = (history.json as { history: Array<{ op: string; author: string; message?: string; patch: unknown[] }> }).history;
  return [...entries].reverse().find((entry) => entry.op === "delete");
}

describe("runDelete", () => {
  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-delete-not-init-"));
    try {
      await expect(runDelete("pm-missing", {}, { path: tempDir })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails with not-found when item does not exist", async () => {
    await withTempPmPath(async (context) => {
      await expect(runDelete("pm-missing", {}, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    });
  });

  it("deletes the item file and appends delete history", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "delete-open-item");
      const result = await runDelete(
        id,
        {
          author: " explicit-author ",
          message: "Delete unit fixture",
        },
        { path: context.pmPath },
      );

      expect(result.warnings).toEqual([]);
      expect(result.changed_fields).toEqual(["deleted"]);
      expect(result.item.id).toBe(id);
      await expect(access(itemPathForTask(context, id))).rejects.toBeDefined();

      const deleteEntry = latestDeleteHistoryEntry(context, id);
      expect(deleteEntry?.author).toBe("explicit-author");
      expect(deleteEntry?.message).toBe("Delete unit fixture");
      expect(deleteEntry?.patch.length).toBeGreaterThan(0);

      const getAfterDelete = context.runCli(["get", id, "--json"], { expectJson: true });
      expect(getAfterDelete.code).toBe(EXIT_CODE.NOT_FOUND);
    });
  });

  it("uses settings author fallback when option and PM_AUTHOR are unset", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "delete-settings-author");
      const previousPmAuthor = process.env.PM_AUTHOR;
      delete process.env.PM_AUTHOR;

      try {
        const settingsPath = path.join(context.pmPath, "settings.json");
        const settings = JSON.parse(await readFile(settingsPath, "utf8")) as { author_default?: string };
        settings.author_default = "settings-author";
        await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

        const result = await runDelete(
          id,
          {
            message: "Delete with settings fallback author",
          },
          { path: context.pmPath },
        );
        expect(result.changed_fields).toEqual(["deleted"]);

        const deleteEntry = latestDeleteHistoryEntry(context, id);
        expect(deleteEntry?.author).toBe("settings-author");
      } finally {
        if (previousPmAuthor === undefined) {
          delete process.env.PM_AUTHOR;
        } else {
          process.env.PM_AUTHOR = previousPmAuthor;
        }
      }
    });
  });

  it("rejects foreign assignment unless forced and supports unknown author fallback", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "delete-foreign-assigned-item", { assignee: "foreign-author" });
      await expect(runDelete(id, {}, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.CONFLICT,
      });

      const previousPmAuthor = process.env.PM_AUTHOR;
      delete process.env.PM_AUTHOR;
      try {
        const forced = await runDelete(
          id,
          {
            author: "   ",
            message: "forced delete",
            force: true,
          },
          { path: context.pmPath },
        );
        expect(forced.changed_fields).toEqual(["deleted"]);
        await expect(access(itemPathForTask(context, id))).rejects.toBeDefined();

        const deleteEntry = latestDeleteHistoryEntry(context, id);
        expect(deleteEntry?.author).toBe("unknown");
      } finally {
        if (previousPmAuthor === undefined) {
          delete process.env.PM_AUTHOR;
        } else {
          process.env.PM_AUTHOR = previousPmAuthor;
        }
      }
    });
  });

  it("restores item file when history append fails during delete", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "delete-history-failure-rollback");
      const historyDir = path.join(context.pmPath, "history");
      await rm(historyDir, { recursive: true, force: true });
      await writeFile(historyDir, "blocking-file", "utf8");
      await access(itemPathForTask(context, id));

      await expect(runDelete(id, { message: "trigger rollback path" }, { path: context.pmPath })).rejects.toBeInstanceOf(
        Error,
      );

      const restoredItem = await readFile(itemPathForTask(context, id), "utf8");
      expect(restoredItem).toContain(id);
    });
  });
});
