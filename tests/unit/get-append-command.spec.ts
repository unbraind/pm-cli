import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runAppend } from "../../src/cli/commands/append.js";
import { runGet } from "../../src/cli/commands/get.js";
import { EXIT_CODE } from "../../src/constants.js";
import { PmCliError } from "../../src/errors.js";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

function createTask(
  context: TempPmContext,
  params: {
    title: string;
    body: string;
    includeLinks?: boolean;
  },
): string {
  const linkArgs = params.includeLinks
    ? [
        "--file",
        "path=src/cli/commands/get.ts,scope=project,note=get-link",
        "--test",
        "command=node --version,scope=project,timeout_seconds=15,note=test-link",
        "--doc",
        "path=README.md,scope=project,note=doc-link",
      ]
    : ["--file", "none", "--test", "none", "--doc", "none"];

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
    "open",
    "--priority",
    "1",
    "--tags",
    "unit,get-append",
    "--body",
    params.body,
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
    "none",
    "--dep",
    "none",
    "--comment",
    "none",
    "--note",
    "none",
    "--learning",
    "none",
    ...linkArgs,
  ];

  const created = context.runCli(args, { expectJson: true });
  expect(created.code).toBe(0);
  const payload = created.json as { item?: { id?: string } };
  expect(typeof payload.item?.id).toBe("string");
  return payload.item?.id ?? "";
}

describe("runGet and runAppend", () => {
  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-get-append-not-init-"));
    try {
      await expect(runGet("pm-missing", { path: tempDir })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
      await expect(runAppend("pm-missing", { body: "append text" }, { path: tempDir })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns linked entries when present and defaults to empty arrays when absent", async () => {
    await withTempPmPath(async (context) => {
      const linkedId = createTask(context, {
        title: "get-with-links",
        body: "linked body",
        includeLinks: true,
      });
      const linkedResult = await runGet(linkedId, { path: context.pmPath });
      expect(linkedResult.item.id).toBe(linkedId);
      expect(linkedResult.body).toBe("linked body");
      expect(linkedResult.linked.files).toEqual([
        { path: "src/cli/commands/get.ts", scope: "project", note: "get-link" },
      ]);
      expect(linkedResult.linked.docs).toEqual([{ path: "README.md", scope: "project", note: "doc-link" }]);
      expect(linkedResult.linked.tests).toEqual([
        {
          command: "node --version",
          scope: "project",
          timeout_seconds: 15,
          note: "test-link",
        },
      ]);

      const plainId = createTask(context, {
        title: "get-without-links",
        body: "plain body",
      });
      const plainResult = await runGet(plainId, { path: context.pmPath });
      expect(plainResult.linked.files).toEqual([]);
      expect(plainResult.linked.tests).toEqual([]);
      expect(plainResult.linked.docs).toEqual([]);
    });
  });

  it("returns not found for unknown ids", async () => {
    await withTempPmPath(async (context) => {
      await expect(runGet("pm-does-not-exist", { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    });
  });

  it("requires body for append operations", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, {
        title: "append-missing-body",
        body: "seed body",
      });
      await expect(
        runAppend(id, {} as unknown as { body: string; author?: string; message?: string; force?: boolean }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("returns empty append output when incoming body is blank", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, {
        title: "append-blank",
        body: "seed body",
      });
      const appendResult = await runAppend(
        id,
        {
          body: "   ",
          author: "append-author",
          message: "Blank append should be ignored",
        },
        { path: context.pmPath },
      );

      expect(appendResult.appended).toBe("");
      expect(appendResult.changed_fields).toEqual([]);

      const getResult = await runGet(id, { path: context.pmPath });
      expect(getResult.body).toBe("seed body");
    });
  });

  it("appends with and without spacer and falls back to unknown author", async () => {
    await withTempPmPath(async (context) => {
      const emptyBodyId = createTask(context, {
        title: "append-empty-body",
        body: "",
      });
      const firstAppend = await runAppend(
        emptyBodyId,
        {
          body: "first entry",
          message: "append empty body",
        },
        { path: context.pmPath },
      );
      expect(firstAppend.appended).toBe("first entry");
      expect(firstAppend.changed_fields).toContain("body");
      const afterFirstAppend = await runGet(emptyBodyId, { path: context.pmPath });
      expect(afterFirstAppend.body).toBe("first entry");
      const firstHistory = context.runCli(["history", emptyBodyId, "--json"], { expectJson: true });
      expect(firstHistory.code).toBe(0);
      const firstHistoryJson = firstHistory.json as { history: Array<{ op: string; author: string }> };
      const firstAppendAuthor = [...firstHistoryJson.history]
        .reverse()
        .find((entry) => entry.op === "append")?.author;
      expect(firstAppendAuthor).toBe("test-author");

      const spacedBodyId = createTask(context, {
        title: "append-existing-body",
        body: "existing body   \n",
      });
      const settingsAuthorId = createTask(context, {
        title: "append-settings-author",
        body: "",
      });
      const previousAuthor = process.env.PM_AUTHOR;
      delete process.env.PM_AUTHOR;
      try {
        const secondAppend = await runAppend(
          spacedBodyId,
          {
            body: "second entry",
            author: "   ",
            message: "append with unknown author fallback",
          },
          { path: context.pmPath },
        );
        expect(secondAppend.appended).toBe("second entry");
        expect(secondAppend.changed_fields).toContain("body");

        const afterSecondAppend = await runGet(spacedBodyId, { path: context.pmPath });
        expect(afterSecondAppend.body).toBe("existing body\n\nsecond entry");

        const history = context.runCli(["history", spacedBodyId, "--json"], { expectJson: true });
        expect(history.code).toBe(0);
        const historyJson = history.json as { history: Array<{ op: string; author: string }> };
        const appendAuthor = [...historyJson.history]
          .reverse()
          .find((entry) => entry.op === "append")?.author;
        expect(appendAuthor).toBe("unknown");

        const settingsPath = path.join(context.pmPath, "settings.json");
        const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
          author_default?: string;
        };
        settings.author_default = "settings-author";
        await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

        const settingsAppend = await runAppend(
          settingsAuthorId,
          {
            body: "from settings fallback",
            message: "append with settings author fallback",
          },
          { path: context.pmPath },
        );
        expect(settingsAppend.changed_fields).toContain("body");
        const settingsHistory = context.runCli(["history", settingsAuthorId, "--json"], { expectJson: true });
        expect(settingsHistory.code).toBe(0);
        const settingsHistoryJson = settingsHistory.json as {
          history: Array<{ op: string; author: string }>;
        };
        const settingsAppendAuthor = [...settingsHistoryJson.history]
          .reverse()
          .find((entry) => entry.op === "append")?.author;
        expect(settingsAppendAuthor).toBe("settings-author");
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
