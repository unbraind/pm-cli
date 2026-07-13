import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDocs } from "../../../src/cli/commands/docs.js";
import { _testOnly as filesInternals, runFiles, runFilesDiscover } from "../../../src/cli/commands/files.js";
import { parseAddGlobEntries, validateLinkedPaths } from "../../../src/cli/commands/linked-artifacts.js";
import * as linkedArtifactsModule from "../../../src/cli/commands/linked-artifacts.js";
import { setActiveExtensionServices } from "../../../src/core/extensions/index.js";
import * as itemStoreModule from "../../../src/core/store/item-store.js";
import { EXIT_CODE } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import { withTempPmPath, type TempPmContext } from "../../helpers/withTempPmPath.js";
import { buildLinkedArtifactAudit } from "../../../packages/pm-governance-audit/extensions/governance-audit/runtime-utils.ts";

beforeEach(() => {
  setActiveExtensionServices({
    overrides: [{
      layer: "project",
      name: "governance-audit",
      service: "linked_artifact_audit",
      run: (context) => buildLinkedArtifactAudit(context.payload),
    }],
  });
});

afterEach(() => {
  setActiveExtensionServices(null);
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

function createTask(context: TempPmContext, title: string, cwd?: string): string {
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
    { expectJson: true, cwd },
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

function normalizeAnyPath(value: string): string {
  return value.replace(/\\/g, "/");
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
  it("covers file discovery pure helper edges", async () => {
    expect(filesInternals.cleanupPathToken("`./src/file.ts:12`;")).toBe("./src/file.ts");
    expect(filesInternals.normalizeCandidatePathForOutput(path.join("src", "nested", "..", "file.ts"))).toBe("src/file.ts");
    expect(filesInternals.linkedFileResolvedKey({ path: "README.md", scope: "project" }, "/repo")).toBe(
      `${path.resolve("/repo", "README.md").replaceAll("\\", "/")}::project`,
    );
    await expect(filesInternals.realpathForContainment("/definitely/missing/path.ts")).resolves.toBe(
      path.resolve("/definitely/missing/path.ts"),
    );

    const references: Array<{ field: string; value: string }> = [];
    filesInternals.collectTextReferences(
      {
        one: " see ./README.md ",
        nested: ["", "docs/guide.md", { deeper: "`src/index.ts:7`" }],
      },
      "metadata",
      references,
    );
    expect(references.map((entry) => entry.field)).toEqual(["metadata.one", "metadata.nested[1]", "metadata.nested[2].deeper"]);
    const rootReferences: Array<{ field: string; value: string }> = [];
    filesInternals.collectTextReferences({ rootOnly: "README.md" }, "", rootReferences);
    expect(rootReferences).toEqual([{ field: "rootOnly", value: "README.md" }]);
    expect(filesInternals.extractRawPathReferences(references).map((entry) => entry.value)).toEqual(
      expect.arrayContaining(["./README.md", "docs/guide.md", "src/index.ts"]),
    );
    const duplicatedTokens = filesInternals.extractRawPathReferences([{ field: "metadata.note", value: "./README.md ./README.md" }]);
    expect(duplicatedTokens.filter((entry) => entry.value === "./README.md")).toHaveLength(1);

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-files-helper-"));
    try {
      await mkdir(path.join(tempDir, "src"), { recursive: true });
      await writeFile(path.join(tempDir, "src", "found.ts"), "export {};\n", "utf8");
      await mkdir(path.join(tempDir, "dir-only"), { recursive: true });
      await expect(filesInternals.resolveDiscoveredFile("missing.ts", tempDir)).resolves.toBeUndefined();
      await expect(filesInternals.resolveDiscoveredFile("dir-only", tempDir)).resolves.toBeUndefined();
      await expect(filesInternals.resolveDiscoveredFile("src/found.ts", tempDir)).resolves.toEqual({
        path: "src/found.ts",
        scope: "project",
      });
      const rootFile = path.join(tempDir, "root-file.txt");
      await writeFile(rootFile, "root\n", "utf8");
      await expect(filesInternals.resolveDiscoveredFile(rootFile, rootFile)).resolves.toBeUndefined();
      const document = {
        metadata: { files: [{ path: "src/found.ts", scope: "project" }], note: "Use src/found.ts and ./other.md." },
        body: `Also see ${path.join(tempDir, "src", "found.ts")}`,
      } as never;
      const discovered = await filesInternals.discoverReferencedFiles(document, tempDir);
      expect(discovered.find((entry) => entry.path === "src/found.ts")?.status).toBe("already_linked");

      // Force a path-tie between project/global candidates so discoverReferencedFiles
      // exercises the final scope comparator branch.
      const originalRelative = path.relative;
      const originalIsAbsolute = path.isAbsolute;
      const absoluteFoundPath = path.join(tempDir, "src", "found.ts");
      const externalFoundPath = path.join(
        os.tmpdir(),
        `pm-files-external-${Date.now()}-${Math.random().toString(16).slice(2)}.ts`,
      );
      await writeFile(externalFoundPath, "export const external = true;\n", "utf8");
      const relativeSpy = vi.spyOn(path, "relative").mockImplementation((from, to) => {
        if (to === absoluteFoundPath) {
          return externalFoundPath;
        }
        return originalRelative(from, to);
      });
      const isAbsoluteSpy = vi.spyOn(path, "isAbsolute").mockImplementation((value) => {
        if (value === externalFoundPath) {
          return false;
        }
        return originalIsAbsolute(value);
      });
      try {
        const tiedPathDocument = {
          metadata: { note: `Use src/found.ts and ${externalFoundPath}` },
          body: "",
        } as never;
        const tied = await filesInternals.discoverReferencedFiles(tiedPathDocument, tempDir);
        const tiedEntries = tied.filter((entry) => entry.path === normalizeAnyPath(externalFoundPath));
        const tiedScopes = tiedEntries.map((entry) => entry.scope);
        expect(tiedScopes).toContain("global");
        expect(tiedScopes.every((scope) => scope === "global" || scope === "project")).toBe(true);

        const weirdMatchReferences = filesInternals.extractRawPathReferences([
          {
            field: "metadata.synthetic",
            value: {
              matchAll: () => [[undefined]],
            } as unknown as string,
          },
        ]);
        expect(weirdMatchReferences).toEqual([]);

        const localeCompare = String.prototype.localeCompare;
        const localeSpy = vi.spyOn(String.prototype, "localeCompare").mockImplementation(function (
          this: string,
          other: string,
          locales?: string | string[],
          options?: Intl.CollatorOptions,
        ) {
          const current = String(this);
          if (
            (current === "src/a.ts" && other === "src/b.ts") ||
            (current === "src/b.ts" && other === "src/a.ts")
          ) {
            return 0;
          }
          return localeCompare.call(current, other, locales as never, options);
        });
        try {
          await writeFile(path.join(tempDir, "src", "a.ts"), "export const a = true;\n", "utf8");
          await writeFile(path.join(tempDir, "src", "b.ts"), "export const b = true;\n", "utf8");
          const forcedTieDocument = {
            metadata: { note: "src/a.ts and src/b.ts" },
            body: "",
          } as never;
          const forcedTie = await filesInternals.discoverReferencedFiles(forcedTieDocument, tempDir);
          expect(forcedTie).toHaveLength(2);
        } finally {
          localeSpy.mockRestore();
        }
      } finally {
        isAbsoluteSpy.mockRestore();
        relativeSpy.mockRestore();
        await rm(externalFoundPath, { force: true });
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails when tracker is not initialized", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pm-files-not-init-"));
    try {
      await expect(runFiles("pm-missing", {}, { path: tempDir })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
      await expect(runFilesDiscover("pm-missing", {}, { path: tempDir })).rejects.toMatchObject<PmCliError>({
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
        message: expect.stringContaining("Valid scopes: project, global (default: project)"),
      });
      await expect(runFiles(id, { remove: ["   "] }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      // `path=` passes the unknown-key check but has an empty value, hitting the
      // "requires path=<value>" branch (an unknown key like scope= is now rejected earlier).
      await expect(runFiles(id, { remove: ["path="] }, { path: context.pmPath })).rejects.toMatchObject<
        PmCliError
      >({
        exitCode: EXIT_CODE.USAGE,
        message: "--remove key/value form requires path=<value>",
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

  it("rejects unknown keys in add/add-glob/remove/migrate matching test --add (GH-258)", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "files-unknown-keys");
      await expect(
        runFiles(id, { add: ["path=README.md,label=main,boguskey=v"] }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: '--add does not recognize keys "label", "boguskey". Allowed keys: path, scope, note.',
      });
      await expect(
        runFiles(id, { addGlob: ["pattern=src/*.ts,boguskey=v"] }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: '--add-glob does not recognize key "boguskey". Allowed keys: pattern, glob, path, scope, note.',
      });
      await expect(
        runFiles(id, { remove: ["path=README.md,boguskey=v"] }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: '--remove does not recognize key "boguskey". Allowed keys: path.',
      });
      await expect(
        runFiles(id, { migrate: ["from=a/,to=b/,boguskey=v"] }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: '--migrate does not recognize key "boguskey". Allowed keys: from, to.',
      });
      // docs --add shares the same parser core.
      await expect(
        runDocs(id, { add: ["path=README.md,boguskey=v"] }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: '--add does not recognize key "boguskey". Allowed keys: path, scope, note.',
      });
      // A FIRST-key typo must not bypass validation by being read as a bare path (GH-258).
      await expect(
        runFiles(id, { add: ["boguskey=v,path=README.md"] }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: '--add does not recognize key "boguskey". Allowed keys: path, scope, note.',
      });
      // A Windows absolute path is still stored as a bare path, not misread as a `C=…` entry.
      const windows = await runFiles(id, { add: ["C:\\Users\\me\\readme.md"] }, { path: context.pmPath });
      expect(windows.files.some((file) => file.path === "C:/Users/me/readme.md")).toBe(true);
      // A mixed-case recognized key is normalized so the value is read (not a confusing "requires path").
      const mixedCase = await runFiles(id, { add: ["Path=docs/MixedCase.md,Scope=project"] }, { path: context.pmPath });
      expect(mixedCase.files.some((file) => file.path === "docs/MixedCase.md")).toBe(true);
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

  it("accepts bare file paths for agent-friendly add entries", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "files-bare-add");
      const result = await runFiles(id, { add: ["README.md"], message: "add bare file path" }, { path: context.pmPath });

      expect(result.changed).toBe(true);
      expect(result.count).toBe(1);
      expect(result.files).toEqual([
        expect.objectContaining({
          path: "README.md",
          scope: "project",
        }),
      ]);
    });
  });

  it("splits bare comma-separated file paths without splitting structured entries (GH-296)", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "files-comma-add");
      const result = await runFiles(
        id,
        {
          add: ["README.md,docs/COMMANDS.md", "path=docs/AGENT_GUIDE.md,scope=project,note=structured"],
          message: "add comma-separated file paths",
        },
        { path: context.pmPath },
      );

      expect(result.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "README.md", scope: "project" }),
          expect.objectContaining({ path: "docs/COMMANDS.md", scope: "project" }),
          expect.objectContaining({ path: "docs/AGENT_GUIDE.md", scope: "project", note: "structured" }),
        ]),
      );
      expect(result.count).toBe(3);
    });
  });

  it("applies a standalone --note to every added link, letting embedded notes win (GH-170)", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "files-standalone-note");

      // --note without --add/--add-glob is a usage error: nothing to annotate.
      await expect(runFiles(id, { note: "orphan note" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("--note requires --add or --add-glob"),
      });
      await expect(
        runFiles(id, { note: "orphan note", remove: ["README.md"] }, { path: context.pmPath }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });

      const added = await runFiles(
        id,
        {
          add: ["README.md", "docs/COMMANDS.md", "path=docs/AGENT_GUIDE.md,note=embedded wins"],
          note: "shared, batch note",
          message: "add linked files with standalone note",
        },
        { path: context.pmPath },
      );
      expect(added.changed).toBe(true);
      expect(added.count).toBe(3);
      expect(added.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "README.md", note: "shared, batch note" }),
          expect.objectContaining({ path: "docs/AGENT_GUIDE.md", note: "embedded wins" }),
          expect.objectContaining({ path: "docs/COMMANDS.md", note: "shared, batch note" }),
        ]),
      );

      // A blank --note value is tolerated and leaves the added entries unannotated.
      const blankNote = await runFiles(
        id,
        { add: ["docs/SDK.md"], note: "   ", message: "blank note" },
        { path: context.pmPath },
      );
      expect(blankNote.files).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: "docs/SDK.md" })]),
      );
      const sdkEntry = blankNote.files.find((entry) => entry.path === "docs/SDK.md");
      expect(sdkEntry?.note).toBeUndefined();
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

      const migratedAdd = await runFiles(
        sourceId,
        {
          add: ["path=docs/old/added-later.md,scope=project"],
          migrate: ["from=docs/old/,to=docs/new/"],
          message: "migrate newly added linked file",
        },
        { path: context.pmPath },
      );
      expect(migratedAdd.files.some((entry) => entry.path === "docs/new/added-later.md")).toBe(true);
      expect(migratedAdd.migrations_applied ?? 0).toBe(1);
    });
  });

  it("classifies existing files, directories, missing paths, and stat failures during validation", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-linked-path-validation-"));
    try {
      const filePath = path.join(tempRoot, "linked.md");
      const dirPath = path.join(tempRoot, "linked-dir");
      await writeFile(filePath, "linked", "utf8");
      await mkdir(dirPath);

      const validation = await validateLinkedPaths([
        filePath,
        dirPath,
        path.join(tempRoot, "missing.md"),
        "bad\0path",
        "  https://github.com/unbraind/pm-cli/pull/362  ",
      ]);

      expect(validation.existing_files).toContain(filePath);
      expect(validation.missing_paths).toContain(path.join(tempRoot, "missing.md"));
      expect(validation.non_file_paths).toEqual(expect.arrayContaining([dirPath, "bad\0path"]));
      // Remote references bypass the existence probe and are reported separately,
      // trimmed to match buildFilesCheck's output shape.
      expect(validation.remote_references).toEqual(["https://github.com/unbraind/pm-cli/pull/362"]);
      expect(validation.missing_paths).not.toContain("  https://github.com/unbraind/pm-cli/pull/362  ");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("covers linked-artifact parser and audit empty branches", () => {
    expect(parseAddGlobEntries(["pattern=src/**/*.ts,scope=project,note=   "])).toEqual([
      { pattern: "src/**/*.ts", scope: "project", note: undefined },
    ]);

    const audit = buildLinkedArtifactAudit({
      paths: ["linked.md", "unlinked.md"],
      items: [{ id: "pm-empty" }, { id: "pm-linked", artifacts: [{ path: "linked.md", scope: "project" }] }],
    });

    expect(audit).toEqual([
      { path: "linked.md", linked_by_count: 1, linked_item_ids: ["pm-linked"] },
      { path: "unlinked.md", linked_by_count: 0, linked_item_ids: [] },
    ]);
  });

  it("fails clearly when an audit flag is registered without its package service", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "missing-linked-audit-service");
      setActiveExtensionServices(null);
      await expect(
        runFiles(id, { audit: true }, { path: context.pmPath }),
      ).rejects.toThrow("without a linked-artifact audit service");
    });
  });

  it("supports append-stable mode to preserve order and append new entries", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "files-append-stable");
      const seeded = await runFiles(
        id,
        {
          add: ["path=docs/c.md,scope=project", "path=docs/a.md,scope=project"],
          appendStable: true,
          message: "seed append-stable ordering",
        },
        { path: context.pmPath },
      );
      expect(seeded.files.map((entry) => entry.path)).toEqual(["docs/c.md", "docs/a.md"]);

      const appended = await runFiles(
        id,
        {
          add: ["path=docs/b.md,scope=project"],
          appendStable: true,
          message: "append with stable ordering",
        },
        { path: context.pmPath },
      );
      expect(appended.files.map((entry) => entry.path)).toEqual(["docs/c.md", "docs/a.md", "docs/b.md"]);

      const defaultSorted = await runFiles(
        id,
        {
          add: ["path=docs/d.md,scope=project"],
          message: "default ordering remains sorted",
        },
        { path: context.pmPath },
      );
      expect(defaultSorted.files.map((entry) => entry.path)).toEqual(["docs/a.md", "docs/b.md", "docs/c.md", "docs/d.md"]);
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

  it("discovers referenced project and global files from item text and applies only missing links", async () => {
    await withTempPmPath(async (context) => {
      const projectRoot = path.join(context.tempRoot, "workspace");
      const globalRoot = path.join(context.tempRoot, "shared");
      await mkdir(path.join(projectRoot, "src"), { recursive: true });
      await mkdir(globalRoot, { recursive: true });
      await writeFile(path.join(projectRoot, "README.md"), "# discovery fixture\n", "utf8");
      await writeFile(path.join(projectRoot, "src", "discovered.ts"), "export const discovered = true;\n", "utf8");
      const globalFile = path.join(globalRoot, "global-notes.md");
      await writeFile(globalFile, "# global reference\n", "utf8");

      const id = createTask(context, "files-discover-direct", projectRoot);
      const seedExisting = context.runCli(
        ["files", id, "--json", "--add", "path=README.md,scope=project,note=manual link", "--message", "seed existing linked file"],
        { expectJson: true, cwd: projectRoot },
      );
      expect(seedExisting.code).toBe(0);

      const update = context.runCli(
        [
          "update",
          id,
          "--json",
          "--body",
          [
            "Implementation references src/discovered.ts and the absolute duplicate",
            `${path.join(projectRoot, "src", "discovered.ts")}:12.`,
            "Ignore missing src/missing.ts.",
          ].join(" "),
          "--author",
          "test-author",
          "--message",
          "Seed discovery body",
        ],
        { expectJson: true, cwd: projectRoot },
      );
      expect(update.code).toBe(0);

      const comment = context.runCli(["comments", id, "Review ./README.md before linking docs/missing.md", "--json"], {
        expectJson: true,
        cwd: projectRoot,
      });
      expect(comment.code).toBe(0);
      const learning = context.runCli(["learnings", id, `Global reference lives at ${globalFile}.`, "--json"], {
        expectJson: true,
        cwd: projectRoot,
      });
      expect(learning.code).toBe(0);

      const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(projectRoot);
      try {
        const dryRun = await runFilesDiscover(id, {}, { path: context.pmPath });
        const addablePaths = dryRun.candidates
          .filter((entry) => entry.status === "addable")
          .map((entry) => entry.path)
          .sort((left, right) => left.localeCompare(right));
        expect(dryRun.changed).toBe(false);
        expect(addablePaths).toEqual(["src/discovered.ts", normalizeLinkedPath(globalFile)].sort());
        expect(dryRun.skipped_existing.map((entry) => entry.path)).toContain("README.md");
        const discoveredCandidate = dryRun.candidates.find((entry) => entry.path === "src/discovered.ts");
        expect(discoveredCandidate?.source_fields).toContain("body");
        expect(discoveredCandidate?.source_count).toBeGreaterThanOrEqual(2);
        const discoveredOriginalPaths = (discoveredCandidate?.original_paths ?? []).map(normalizeAnyPath);
        expect(discoveredOriginalPaths).toContain("src/discovered.ts");
        expect(discoveredOriginalPaths.some((entry) => entry.endsWith("/src/discovered.ts"))).toBe(true);
        expect(dryRun.candidates.find((entry) => entry.path === normalizeLinkedPath(globalFile))?.scope).toBe("global");

        const applied = await runFilesDiscover(
          id,
          {
            apply: true,
            note: "auto-discovered",
            message: "Apply discovered linked files",
          },
          { path: context.pmPath },
        );
        expect(applied.changed).toBe(true);
        expect(applied.added_count).toBe(2);
        expect(applied.files.filter((entry) => entry.path === "src/discovered.ts" && entry.scope === "project")).toHaveLength(1);
        expect(applied.files.filter((entry) => entry.path === normalizeLinkedPath(globalFile) && entry.scope === "global")).toHaveLength(1);
        expect(applied.files.find((entry) => entry.path === "src/discovered.ts")?.note).toBe("auto-discovered");

        const rerun = await runFilesDiscover(id, { apply: true }, { path: context.pmPath });
        expect(rerun.changed).toBe(false);
        expect(rerun.addable_count).toBe(0);
        expect(rerun.skipped_existing_count).toBe(3);
      } finally {
        cwdSpy.mockRestore();
      }
    });
  });

  it("keeps metadata.files absent when apply mode has no candidates to add", async () => {
    await withTempPmPath(async (context) => {
      const projectRoot = path.join(context.tempRoot, "workspace-empty");
      await mkdir(projectRoot, { recursive: true });
      const id = createTask(context, "files-discover-empty-apply", projectRoot);

      const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(projectRoot);
      try {
        const applied = await runFilesDiscover(id, { apply: true }, { path: context.pmPath });
        expect(applied.apply).toBe(true);
        expect(applied.candidate_count).toBe(0);
        expect(applied.added_count).toBe(0);
        expect(applied.files).toEqual([]);
      } finally {
        cwdSpy.mockRestore();
      }

      const fetched = context.runCli(["get", id, "--json", "--full"], { expectJson: true, cwd: projectRoot });
      expect(fetched.code).toBe(0);
      expect((fetched.json as { item: { files?: unknown } }).item.files).toBeUndefined();
    });
  });

  it("surfaces not-found and skipped-existing race branches in files discover apply mode", async () => {
    await withTempPmPath(async (context) => {
      const projectRoot = path.join(context.tempRoot, "workspace-race");
      await mkdir(path.join(projectRoot, "src"), { recursive: true });
      await writeFile(path.join(projectRoot, "src", "discover-me.ts"), "export const discover = true;\n", "utf8");

      const id = createTask(context, "files-discover-race", projectRoot);
      context.runCli(
        [
          "update",
          id,
          "--json",
          "--body",
          "Please reference src/discover-me.ts",
          "--author",
          "test-author",
          "--message",
          "seed discover candidate",
        ],
        { expectJson: true, cwd: projectRoot },
      );

      await expect(runFilesDiscover("pm-missing-id", {}, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });

      const originalMutateItem = itemStoreModule.mutateItem;
      let seededBeforeMutate = false;
      const mutateSpy = vi.spyOn(itemStoreModule, "mutateItem").mockImplementation(async (input) => {
        if (!seededBeforeMutate && input.op === "files_discover") {
          seededBeforeMutate = true;
          await originalMutateItem({
            pmRoot: input.pmRoot,
            settings: input.settings,
            id: input.id,
            op: "files_discover_seed",
            author: "test-author",
            message: "seed discover race",
            force: input.force,
            mutate(document) {
              document.metadata.files = [{ path: "src/discover-me.ts", scope: "project" }];
              return { changedFields: ["files"] };
            },
          });
        }
        return originalMutateItem(input);
      });

      const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(projectRoot);
      try {
        const applied = await runFilesDiscover(id, { apply: true }, { path: context.pmPath });
        expect(applied.apply).toBe(true);
        expect(applied.addable_count).toBeGreaterThanOrEqual(1);
        expect(applied.added_count).toBeLessThanOrEqual(1);
      } finally {
        cwdSpy.mockRestore();
        mutateSpy.mockRestore();
      }
    });
  });

  it("deletes metadata.files when discover dedupe yields empty output", async () => {
    await withTempPmPath(async (context) => {
      const projectRoot = path.join(context.tempRoot, "workspace-dedupe-empty");
      await mkdir(path.join(projectRoot, "src"), { recursive: true });
      await writeFile(path.join(projectRoot, "src", "discover-me.ts"), "export const discover = true;\n", "utf8");
      const id = createTask(context, "files-discover-dedupe-empty", projectRoot);
      context.runCli(
        [
          "update",
          id,
          "--json",
          "--body",
          "References src/discover-me.ts",
          "--author",
          "test-author",
          "--message",
          "seed discover candidate",
        ],
        { expectJson: true, cwd: projectRoot },
      );

      const dedupeSpy = vi.spyOn(linkedArtifactsModule, "dedupeLinkedArtifacts").mockReturnValue([]);
      const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(projectRoot);
      try {
        const applied = await runFilesDiscover(id, { apply: true }, { path: context.pmPath });
        expect(applied.apply).toBe(true);
        expect(applied.files).toEqual([]);
        expect(applied.changed).toBe(false);
      } finally {
        cwdSpy.mockRestore();
        dedupeSpy.mockRestore();
      }

      const fetched = context.runCli(["get", id, "--json"], { expectJson: true, cwd: projectRoot });
      expect(fetched.code).toBe(0);
      expect((fetched.json as { item: { files?: unknown } }).item.files).toBeUndefined();
    });
  });

  it("keeps append-stable discovery ordering when --append-stable is set", async () => {
    await withTempPmPath(async (context) => {
      const projectRoot = path.join(context.tempRoot, "workspace-append-stable");
      await mkdir(path.join(projectRoot, "src"), { recursive: true });
      await writeFile(path.join(projectRoot, "src", "a.ts"), "export const a = true;\n", "utf8");
      await writeFile(path.join(projectRoot, "src", "b.ts"), "export const b = true;\n", "utf8");
      const id = createTask(context, "files-discover-append-stable", projectRoot);

      context.runCli(
        [
          "update",
          id,
          "--json",
          "--body",
          "References src/b.ts then src/a.ts",
          "--author",
          "test-author",
          "--message",
          "seed append-stable discover candidates",
        ],
        { expectJson: true, cwd: projectRoot },
      );

      const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(projectRoot);
      try {
        const applied = await runFilesDiscover(
          id,
          {
            apply: true,
            appendStable: true,
            message: "append-stable discover apply",
          },
          { path: context.pmPath },
        );
        expect(applied.apply).toBe(true);
        expect(applied.changed).toBe(true);
        const addableCandidateOrder = applied.candidates
          .filter((entry) => entry.status === "addable")
          .map((entry) => entry.path);
        expect(applied.files.map((entry) => entry.path)).toEqual(addableCandidateOrder);
      } finally {
        cwdSpy.mockRestore();
      }
    });
  });
});

describe("runDocs", () => {
  it("accepts --list as a no-mutation alias for listing linked docs", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "docs-list-flag");
      context.runCli(
        ["docs", id, "--add", "path=README.md,scope=project,note=seed", "--json", "--author", "owner-a"],
        { expectJson: true },
      );
      const listed = context.runCli(["docs", id, "--list", "--json"], { expectJson: true });
      expect(listed.code).toBe(0);
      const payload = listed.json as { docs?: Array<{ path?: string }>; count?: number };
      expect(payload.count).toBe(1);
      expect(payload.docs?.[0]?.path).toBe("README.md");

      const listedAgain = context.runCli(["docs", id, "--list", "--json"], { expectJson: true });
      expect(listedAgain.code).toBe(0);
      expect((listedAgain.json as { count?: number }).count).toBe(payload.count);
    });
  });

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
        message: expect.stringContaining("Valid scopes: project, global (default: project)"),
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

  it("accepts bare doc paths for agent-friendly add entries", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "docs-bare-add");
      const result = await runDocs(id, { add: ["README.md"], message: "add bare doc path" }, { path: context.pmPath });

      expect(result.changed).toBe(true);
      expect(result.count).toBe(1);
      expect(result.docs).toEqual([
        expect.objectContaining({
          path: "README.md",
          scope: "project",
        }),
      ]);
    });
  });

  it("splits bare comma-separated doc paths without splitting structured entries (GH-296)", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "docs-comma-add");
      const result = await runDocs(
        id,
        {
          add: ["README.md,docs/COMMANDS.md", "path=docs/AGENT_GUIDE.md,scope=project,note=structured"],
          message: "add comma-separated doc paths",
        },
        { path: context.pmPath },
      );

      expect(result.docs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "README.md", scope: "project" }),
          expect.objectContaining({ path: "docs/COMMANDS.md", scope: "project" }),
          expect.objectContaining({ path: "docs/AGENT_GUIDE.md", scope: "project", note: "structured" }),
        ]),
      );
      expect(result.count).toBe(3);
    });
  });

  it("applies a standalone --note to added doc links and rejects --note without an add (GH-170)", async () => {
    await withTempPmPath(async (context) => {
      const id = createTask(context, "docs-standalone-note");

      await expect(runDocs(id, { note: "orphan note" }, { path: context.pmPath })).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
        message: expect.stringContaining("--note requires --add or --add-glob"),
      });

      const added = await runDocs(
        id,
        { add: ["README.md", "docs/COMMANDS.md"], note: "public docs", message: "add docs with note" },
        { path: context.pmPath },
      );
      expect(added.changed).toBe(true);
      expect(added.count).toBe(2);
      expect(added.docs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "README.md", note: "public docs" }),
          expect.objectContaining({ path: "docs/COMMANDS.md", note: "public docs" }),
        ]),
      );
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
