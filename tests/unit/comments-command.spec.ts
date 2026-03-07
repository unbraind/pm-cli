import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runComments } from "../../src/cli/commands/comments.js";
import { EXIT_CODE } from "../../src/constants.js";
import { PmCliError } from "../../src/errors.js";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

function createTask(context: TempPmContext, title: string): string {
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
      "comments,unit",
      "--body",
      "",
      "--deadline",
      "none",
      "--estimate",
      "10",
      "--acceptance-criteria",
      `${title} acceptance`,
      "--author",
      "seed-author",
      "--message",
      `Create ${title}`,
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
  expect(created.code).toBe(0);
  return (created.json as { item: { id: string } }).item.id;
}

describe("runComments", () => {
  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-comments-not-init-"));
    try {
      await expect(runComments("pm-missing", {}, { path: tempDir })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
      await expect(runComments("pm-missing", { add: "comment text" }, { path: tempDir })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("lists comments, enforces limit semantics, and validates limit inputs", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "comments-limit");

      const empty = await runComments(id, {}, { path: context.pmPath });
      expect(empty.count).toBe(0);
      expect(empty.comments).toEqual([]);

      await expect(runComments("pm-does-not-exist", {}, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });

      await runComments(id, { add: "first comment", author: "first-author" }, { path: context.pmPath });
      await runComments(id, { add: "second comment" }, { path: context.pmPath });
      await runComments(id, { add: "third comment" }, { path: context.pmPath });

      const all = await runComments(id, {}, { path: context.pmPath });
      expect(all.count).toBe(3);
      expect(all.comments.map((entry) => entry.text)).toEqual(["first comment", "second comment", "third comment"]);

      const limited = await runComments(id, { limit: "2" }, { path: context.pmPath });
      expect(limited.count).toBe(2);
      expect(limited.comments.map((entry) => entry.text)).toEqual(["second comment", "third comment"]);

      const floored = await runComments(id, { limit: "1.9" }, { path: context.pmPath });
      expect(floored.count).toBe(1);
      expect(floored.comments[0].text).toBe("third comment");

      const zero = await runComments(id, { limit: "0" }, { path: context.pmPath });
      expect(zero.count).toBe(0);
      expect(zero.comments).toEqual([]);

      await expect(runComments(id, { limit: "-1" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runComments(id, { limit: "not-a-number" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("rejects empty comment text", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "comments-empty");
      await expect(runComments(id, { add: "   " }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("resolves author from explicit input, env fallback, settings fallback, and unknown fallback", async () => {
    await withTempPmPath(async (context) => {
      const explicitId = createTask(context, "comments-explicit-author");
      const explicit = await runComments(
        explicitId,
        {
          add: "explicit author comment",
          author: " explicit-author ",
          message: "add explicit author comment",
        },
        { path: context.pmPath },
      );
      expect(explicit.comments.at(-1)?.author).toBe("explicit-author");

      const envId = createTask(context, "comments-env-author");
      const envResult = await runComments(envId, { add: "env author comment" }, { path: context.pmPath });
      expect(envResult.comments.at(-1)?.author).toBe("test-author");

      const previousPmAuthor = process.env.PM_AUTHOR;
      delete process.env.PM_AUTHOR;
      try {
        const settingsPath = path.join(context.pmPath, "settings.json");
        const settings = JSON.parse(await readFile(settingsPath, "utf8")) as { author_default?: string };
        settings.author_default = "settings-author";
        await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

        const settingsId = createTask(context, "comments-settings-author");
        const settingsResult = await runComments(settingsId, { add: "settings author comment" }, { path: context.pmPath });
        expect(settingsResult.comments.at(-1)?.author).toBe("settings-author");

        const unknownId = createTask(context, "comments-unknown-author");
        const unknownResult = await runComments(
          unknownId,
          {
            add: "unknown author comment",
            author: "   ",
          },
          { path: context.pmPath },
        );
        expect(unknownResult.comments.at(-1)?.author).toBe("unknown");
      } finally {
        if (previousPmAuthor === undefined) {
          delete process.env.PM_AUTHOR;
        } else {
          process.env.PM_AUTHOR = previousPmAuthor;
        }
      }
    });
  });
});
