import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDocs } from "../../src/cli/commands/docs.js";
import { runFiles } from "../../src/cli/commands/files.js";
import { EXIT_CODE } from "../../src/constants.js";
import { PmCliError } from "../../src/errors.js";
import { withTempPmPath, type TempPmContext } from "../helpers/withTempPmPath.js";

afterEach(() => {
  vi.restoreAllMocks();
});

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

function normalizeLinkedPath(value: string): string {
  return value.split(path.sep).join("/");
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
      await expect(runFiles(id, { addGlob: ["   "] }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runFiles(id, { addGlob: ["scope=project"] }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runFiles(id, { migrate: ["from=docs/old/"] }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
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

  it("accepts markdown entries and stdin token for add/remove", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "files-markdown-stdin");
      const stdinSpy = vi.spyOn(process, "stdin", "get");
      const addStdin = new PassThrough();
      addStdin.end(["path: docs/pipe-file.md", "scope: project", "note: from stdin"].join("\n"));
      Object.defineProperty(addStdin, "isTTY", { value: false, configurable: true });
      stdinSpy.mockReturnValue(addStdin as unknown as NodeJS.ReadStream);

      const addedFromStdin = await runFiles(id, { add: ["-"] }, { path: context.pmPath });
      expect(addedFromStdin.count).toBe(1);

      const addedMarkdown = await runFiles(id, { add: ["path:docs/inline-file.md,scope:project"] }, { path: context.pmPath });
      expect(addedMarkdown.count).toBe(2);

      const removedMarkdown = await runFiles(id, { remove: ["path: docs/pipe-file.md"] }, { path: context.pmPath });
      expect(removedMarkdown.count).toBe(1);

      const removeStdin = new PassThrough();
      removeStdin.end("path: docs/inline-file.md\n");
      Object.defineProperty(removeStdin, "isTTY", { value: false, configurable: true });
      stdinSpy.mockReturnValue(removeStdin as unknown as NodeJS.ReadStream);
      const removedFromStdin = await runFiles(id, { remove: ["-"] }, { path: context.pmPath });
      expect(removedFromStdin.count).toBe(0);
    });
  });

  it("supports linked-file path migration, validation, audit, and idempotent re-run", async () => {
    await withTempPmPath(async (context) => {
      const sourceId = createTask(context, "files-hygiene-source");
      const peerId = createTask(context, "files-hygiene-peer");

      await runFiles(
        sourceId,
        {
          add: ["path=docs/old/file-one.md,scope=project", "path=README.md,scope=project"],
          message: "seed source linked files",
        },
        { path: context.pmPath },
      );
      await runFiles(
        peerId,
        {
          add: ["path=docs/new/file-one.md,scope=project"],
          message: "seed peer linked file for audit",
        },
        { path: context.pmPath },
      );

      const migrated = await runFiles(
        sourceId,
        {
          migrate: ["from=docs/old/,to=docs/new/"],
          validatePaths: true,
          audit: true,
          message: "migrate and audit linked files",
        },
        { path: context.pmPath },
      );

      expect(migrated.files.some((entry) => entry.path === "docs/new/file-one.md")).toBe(true);
      expect(migrated.migrations_applied).toBeGreaterThan(0);
      expect(migrated.validation?.checked).toBeGreaterThan(0);
      expect(migrated.audit?.find((entry) => entry.path === "docs/new/file-one.md")).toEqual(
        expect.objectContaining({
          linked_by_count: 2,
          linked_item_ids: expect.arrayContaining([sourceId, peerId]),
        }),
      );

      const readOnlyInspection = await runFiles(
        sourceId,
        {
          list: true,
          validatePaths: true,
          audit: true,
        },
        { path: context.pmPath },
      );
      expect(readOnlyInspection.changed).toBe(false);
      expect(readOnlyInspection.validation?.checked).toBeGreaterThan(0);
      expect(readOnlyInspection.audit?.find((entry) => entry.path === "docs/new/file-one.md")).toEqual(
        expect.objectContaining({
          linked_by_count: 2,
          linked_item_ids: expect.arrayContaining([sourceId, peerId]),
        }),
      );

      const rerun = await runFiles(
        sourceId,
        {
          migrate: ["from=docs/old/,to=docs/new/"],
          message: "repeat migration to prove idempotence",
        },
        { path: context.pmPath },
      );
      expect(rerun.files.some((entry) => entry.path === "docs/new/file-one.md")).toBe(true);
      expect(rerun.migrations_applied ?? 0).toBe(0);
    });
  });

  it("expands add-glob file entries with deterministic dedup behavior", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "files-add-glob");
      const fixtureRoot = path.join(context.tempRoot, "files-glob-fixtures");
      await mkdir(path.join(fixtureRoot, "src", "routes"), { recursive: true });
      await mkdir(path.join(fixtureRoot, "src", "lib"), { recursive: true });

      const routeAlpha = path.join(fixtureRoot, "src", "routes", "alpha.ts");
      const routeBeta = path.join(fixtureRoot, "src", "routes", "beta.ts");
      const libGamma = path.join(fixtureRoot, "src", "lib", "gamma.ts");
      await writeFile(routeAlpha, "export const alpha = 1;\n", "utf8");
      await writeFile(routeBeta, "export const beta = 2;\n", "utf8");
      await writeFile(libGamma, "export const gamma = 3;\n", "utf8");
      await writeFile(path.join(fixtureRoot, "src", "routes", "ignore.md"), "# ignore\n", "utf8");

      const tsGlob = normalizeLinkedPath(path.join(fixtureRoot, "src", "**", "*.ts"));
      const fromGlob = await runFiles(
        id,
        {
          addGlob: [tsGlob, tsGlob],
          message: "add linked files from repeated glob",
        },
        { path: context.pmPath },
      );

      const expectedProjectPaths = [routeAlpha, routeBeta, libGamma]
        .map((entry) => normalizeLinkedPath(entry))
        .sort((left, right) => left.localeCompare(right));
      expect(fromGlob.files.map((entry) => entry.path)).toEqual(expectedProjectPaths);
      expect(fromGlob.files.every((entry) => entry.scope === "project")).toBe(true);
      expect(fromGlob.count).toBe(3);

      const asGlobal = await runFiles(
        id,
        {
          addGlob: [`pattern=${tsGlob},scope=global,note=from glob`],
          message: "add same linked files with global scope",
        },
        { path: context.pmPath },
      );
      expect(asGlobal.count).toBe(6);
      expect(asGlobal.files.filter((entry) => entry.scope === "global")).toHaveLength(3);
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
      await expect(runDocs(id, { addGlob: ["   "] }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runDocs(id, { addGlob: ["scope=project"] }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runDocs(id, { migrate: ["from=docs/old/"] }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
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

  it("accepts markdown entries and stdin token for add/remove", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "docs-markdown-stdin");
      const stdinSpy = vi.spyOn(process, "stdin", "get");
      const addStdin = new PassThrough();
      addStdin.end(["path: docs/pipe-doc.md", "scope: project", "note: from stdin"].join("\n"));
      Object.defineProperty(addStdin, "isTTY", { value: false, configurable: true });
      stdinSpy.mockReturnValue(addStdin as unknown as NodeJS.ReadStream);

      const addedFromStdin = await runDocs(id, { add: ["-"] }, { path: context.pmPath });
      expect(addedFromStdin.count).toBe(1);

      const addedMarkdown = await runDocs(id, { add: ["path:docs/inline-doc.md,scope:project"] }, { path: context.pmPath });
      expect(addedMarkdown.count).toBe(2);

      const removedMarkdown = await runDocs(id, { remove: ["path: docs/pipe-doc.md"] }, { path: context.pmPath });
      expect(removedMarkdown.count).toBe(1);

      const removeStdin = new PassThrough();
      removeStdin.end("path: docs/inline-doc.md\n");
      Object.defineProperty(removeStdin, "isTTY", { value: false, configurable: true });
      stdinSpy.mockReturnValue(removeStdin as unknown as NodeJS.ReadStream);
      const removedFromStdin = await runDocs(id, { remove: ["-"] }, { path: context.pmPath });
      expect(removedFromStdin.count).toBe(0);
    });
  });

  it("supports linked-doc path migration, validation, audit, and idempotent re-run", async () => {
    await withTempPmPath(async (context) => {
      const sourceId = createTask(context, "docs-hygiene-source");
      const peerId = createTask(context, "docs-hygiene-peer");

      await runDocs(
        sourceId,
        {
          add: ["path=docs/old/doc-one.md,scope=project", "path=README.md,scope=project"],
          message: "seed source linked docs",
        },
        { path: context.pmPath },
      );
      await runDocs(
        peerId,
        {
          add: ["path=docs/new/doc-one.md,scope=project"],
          message: "seed peer linked doc for audit",
        },
        { path: context.pmPath },
      );

      const migrated = await runDocs(
        sourceId,
        {
          migrate: ["from=docs/old/,to=docs/new/"],
          validatePaths: true,
          audit: true,
          message: "migrate and audit linked docs",
        },
        { path: context.pmPath },
      );

      expect(migrated.docs.some((entry) => entry.path === "docs/new/doc-one.md")).toBe(true);
      expect(migrated.migrations_applied).toBeGreaterThan(0);
      expect(migrated.validation?.checked).toBeGreaterThan(0);
      expect(migrated.audit?.find((entry) => entry.path === "docs/new/doc-one.md")).toEqual(
        expect.objectContaining({
          linked_by_count: 2,
          linked_item_ids: expect.arrayContaining([sourceId, peerId]),
        }),
      );

      const readOnlyInspection = await runDocs(
        sourceId,
        {
          validatePaths: true,
          audit: true,
        },
        { path: context.pmPath },
      );
      expect(readOnlyInspection.changed).toBe(false);
      expect(readOnlyInspection.validation?.checked).toBeGreaterThan(0);
      expect(readOnlyInspection.audit?.find((entry) => entry.path === "docs/new/doc-one.md")).toEqual(
        expect.objectContaining({
          linked_by_count: 2,
          linked_item_ids: expect.arrayContaining([sourceId, peerId]),
        }),
      );

      const rerun = await runDocs(
        sourceId,
        {
          migrate: ["from=docs/old/,to=docs/new/"],
          message: "repeat migration to prove idempotence",
        },
        { path: context.pmPath },
      );
      expect(rerun.docs.some((entry) => entry.path === "docs/new/doc-one.md")).toBe(true);
      expect(rerun.migrations_applied ?? 0).toBe(0);
    });
  });

  it("expands add-glob doc entries with deterministic dedup behavior", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "docs-add-glob");
      const fixtureRoot = path.join(context.tempRoot, "docs-glob-fixtures");
      await mkdir(path.join(fixtureRoot, "docs", "guides"), { recursive: true });
      await mkdir(path.join(fixtureRoot, "docs", "reference"), { recursive: true });

      const guideAlpha = path.join(fixtureRoot, "docs", "guides", "alpha.md");
      const guideBeta = path.join(fixtureRoot, "docs", "guides", "beta.md");
      const refGamma = path.join(fixtureRoot, "docs", "reference", "gamma.md");
      await writeFile(guideAlpha, "# alpha\n", "utf8");
      await writeFile(guideBeta, "# beta\n", "utf8");
      await writeFile(refGamma, "# gamma\n", "utf8");
      await writeFile(path.join(fixtureRoot, "docs", "guides", "ignore.txt"), "ignore\n", "utf8");

      const mdGlob = normalizeLinkedPath(path.join(fixtureRoot, "docs", "**", "*.md"));
      const fromGlob = await runDocs(
        id,
        {
          addGlob: [mdGlob, mdGlob],
          message: "add linked docs from repeated glob",
        },
        { path: context.pmPath },
      );

      const expectedProjectPaths = [guideAlpha, guideBeta, refGamma]
        .map((entry) => normalizeLinkedPath(entry))
        .sort((left, right) => left.localeCompare(right));
      expect(fromGlob.docs.map((entry) => entry.path)).toEqual(expectedProjectPaths);
      expect(fromGlob.docs.every((entry) => entry.scope === "project")).toBe(true);
      expect(fromGlob.count).toBe(3);

      const asGlobal = await runDocs(
        id,
        {
          addGlob: [`pattern=${mdGlob},scope=global,note=from glob`],
          message: "add same linked docs with global scope",
        },
        { path: context.pmPath },
      );
      expect(asGlobal.count).toBe(6);
      expect(asGlobal.docs.filter((entry) => entry.scope === "global")).toHaveLength(3);
    });
  });
});
