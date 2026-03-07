import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runDocs } from "../../src/cli/commands/docs.js";
import { runFiles } from "../../src/cli/commands/files.js";
import { EXIT_CODE } from "../../src/constants.js";
import { PmCliError } from "../../src/errors.js";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

interface LinkOptions {
  add?: string[];
  remove?: string[];
  author?: string;
  message?: string;
  force?: boolean;
}

interface LinkResult {
  id: string;
  changed: boolean;
  count: number;
}

type RunLinkCommand = (id: string, options: LinkOptions, global: { path: string }) => Promise<LinkResult>;

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
      "links,unit",
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

async function latestHistoryAuthor(pmPath: string, id: string): Promise<string> {
  const historyPath = path.join(pmPath, "history", `${id}.jsonl`);
  const raw = await readFile(historyPath, "utf8");
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const last = JSON.parse(lines.at(-1) ?? "{}") as { author?: string };
  return last.author ?? "";
}

async function setSettingsAuthorDefault(pmPath: string, authorDefault: string): Promise<void> {
  const settingsPath = path.join(pmPath, "settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8")) as { author_default?: string };
  settings.author_default = authorDefault;
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

async function assertAuthorResolution(
  context: TempPmContext,
  runLink: RunLinkCommand,
  addEntry: string,
  label: string,
): Promise<void> {
  const explicitId = createTask(context, `${label}-explicit-author`);
  await runLink(
    explicitId,
    {
      add: [addEntry],
      author: ` explicit-${label}-author `,
      message: `${label} explicit author`,
    },
    { path: context.pmPath },
  );
  expect(await latestHistoryAuthor(context.pmPath, explicitId)).toBe(`explicit-${label}-author`);

  const envId = createTask(context, `${label}-env-author`);
  await runLink(envId, { add: [addEntry], message: `${label} env author` }, { path: context.pmPath });
  expect(await latestHistoryAuthor(context.pmPath, envId)).toBe("test-author");

  const previousPmAuthor = process.env.PM_AUTHOR;
  delete process.env.PM_AUTHOR;
  try {
    await setSettingsAuthorDefault(context.pmPath, `settings-${label}-author`);
    const settingsId = createTask(context, `${label}-settings-author`);
    await runLink(settingsId, { add: [addEntry], message: `${label} settings author` }, { path: context.pmPath });
    expect(await latestHistoryAuthor(context.pmPath, settingsId)).toBe(`settings-${label}-author`);

    await setSettingsAuthorDefault(context.pmPath, "   ");
    const unknownId = createTask(context, `${label}-unknown-author`);
    await runLink(
      unknownId,
      {
        add: [addEntry],
        author: "   ",
        message: `${label} unknown author`,
      },
      { path: context.pmPath },
    );
    expect(await latestHistoryAuthor(context.pmPath, unknownId)).toBe("unknown");
  } finally {
    if (previousPmAuthor === undefined) {
      delete process.env.PM_AUTHOR;
    } else {
      process.env.PM_AUTHOR = previousPmAuthor;
    }
  }
}

describe("runFiles", () => {
  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-files-not-init-"));
    try {
      await expect(runFiles("pm-missing", {}, { path: tempDir })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
      await expect(
        runFiles("pm-missing", { add: ["path=README.md,scope=project"] }, { path: tempDir }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("validates add/remove input and scope values", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "files-validate");
      await expect(runFiles(id, { add: ["scope=project"] }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runFiles(id, { add: ["path=README.md,scope=workspace"] }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runFiles(id, { remove: ["   "] }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runFiles(id, { remove: ["scope=project"] }, { path: context.pmPath })).rejects.toMatchObject<
        PmCliError
      >({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("lists linked files and supports deduplicated add/remove", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "files-list-mutate");

      await expect(runFiles("pm-does-not-exist", {}, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });

      const initial = await runFiles(id, {}, { path: context.pmPath });
      expect(initial.changed).toBe(false);
      expect(initial.count).toBe(0);

      const added = await runFiles(
        id,
        {
          add: [
            "path=README.md,scope=project,note=readme reference",
            "path=README.md,scope=project,note=duplicate should be ignored",
            "path=docs/reference/architecture.md,scope=global,note=global file",
            "path=docs/reference/implicit-scope-file.md,note=implicit project scope",
          ],
          message: "add linked files",
        },
        { path: context.pmPath },
      );
      expect(added.changed).toBe(true);
      expect(added.count).toBe(3);

      const listed = await runFiles(id, {}, { path: context.pmPath });
      expect(listed.count).toBe(3);
      expect(listed.changed).toBe(false);

      const partiallyRemoved = await runFiles(
        id,
        {
          remove: ["path=README.md", "docs/reference/not-present.md"],
          message: "remove one file and keep non-matching entries",
        },
        { path: context.pmPath },
      );
      expect(partiallyRemoved.count).toBe(2);
      expect(partiallyRemoved.changed).toBe(true);

      const removed = await runFiles(
        id,
        {
          remove: ["path=docs/reference/architecture.md", "docs/reference/implicit-scope-file.md"],
          message: "remove remaining linked files",
        },
        { path: context.pmPath },
      );
      expect(removed.count).toBe(0);
      expect(removed.changed).toBe(true);
    });
  });

  it("resolves mutation author from explicit/env/settings/unknown fallbacks", async () => {
    await withTempPmPath(async (context) => {
      await assertAuthorResolution(context, runFiles, "path=README.md,scope=project", "files");
    });
  });
});

describe("runDocs", () => {
  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-docs-not-init-"));
    try {
      await expect(runDocs("pm-missing", {}, { path: tempDir })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
      await expect(
        runDocs("pm-missing", { add: ["path=README.md,scope=project"] }, { path: tempDir }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("validates add/remove input and scope values", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "docs-validate");
      await expect(runDocs(id, { add: ["scope=project"] }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runDocs(id, { add: ["path=README.md,scope=workspace"] }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runDocs(id, { remove: ["   "] }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runDocs(id, { remove: ["scope=project"] }, { path: context.pmPath })).rejects.toMatchObject<
        PmCliError
      >({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("lists linked docs and supports deduplicated add/remove", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "docs-list-mutate");

      await expect(runDocs("pm-does-not-exist", {}, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });

      const initial = await runDocs(id, {}, { path: context.pmPath });
      expect(initial.changed).toBe(false);
      expect(initial.count).toBe(0);

      const added = await runDocs(
        id,
        {
          add: [
            "path=README.md,scope=project,note=readme doc",
            "path=README.md,scope=project,note=duplicate should be ignored",
            "path=docs/reference/architecture.md,scope=global,note=global doc",
            "path=docs/reference/implicit-scope-doc.md,note=implicit project scope",
          ],
          message: "add linked docs",
        },
        { path: context.pmPath },
      );
      expect(added.changed).toBe(true);
      expect(added.count).toBe(3);

      const listed = await runDocs(id, {}, { path: context.pmPath });
      expect(listed.count).toBe(3);
      expect(listed.changed).toBe(false);

      const partiallyRemoved = await runDocs(
        id,
        {
          remove: ["path=README.md", "docs/reference/not-present.md"],
          message: "remove one doc and keep non-matching entries",
        },
        { path: context.pmPath },
      );
      expect(partiallyRemoved.count).toBe(2);
      expect(partiallyRemoved.changed).toBe(true);

      const removed = await runDocs(
        id,
        {
          remove: ["path=docs/reference/architecture.md", "docs/reference/implicit-scope-doc.md"],
          message: "remove remaining linked docs",
        },
        { path: context.pmPath },
      );
      expect(removed.count).toBe(0);
      expect(removed.changed).toBe(true);
    });
  });

  it("resolves mutation author from explicit/env/settings/unknown fallbacks", async () => {
    await withTempPmPath(async (context) => {
      await assertAuthorResolution(context, runDocs, "path=README.md,scope=project", "docs");
    });
  });
});
