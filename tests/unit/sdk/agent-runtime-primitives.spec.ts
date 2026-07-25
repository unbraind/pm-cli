import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { coerceLooseCommandOptionsWithFlagDefinitions } from "../../../src/cli/extension-command-options.js";
import {
  activateExtensions,
  resolvePortableWorkspaceContext,
  setActiveCommandContext,
  type ExtensionLoadResult,
} from "../../../src/core/extensions/index.js";
import { createHistoryEntry } from "../../../src/core/history/history.js";
import {
  detectHarnessIdentity,
  resolveAuthor,
  resolveAuthorIdentity,
} from "../../../src/core/shared/author.js";
import { EMPTY_CANONICAL_DOCUMENT } from "../../../src/core/shared/constants.js";
import {
  _testOnlyValidateCommand,
  runValidate,
} from "../../../src/sdk/governance/validate.js";
import type { ItemDocument } from "../../../src/types.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";

const tempRoots: string[] = [];
const originalSourceWorkspaceRoot = process.env.PM_SOURCE_WORKSPACE_ROOT;
const originalPmAuthor = process.env.PM_AUTHOR;

afterEach(async () => {
  if (originalSourceWorkspaceRoot === undefined) {
    delete process.env.PM_SOURCE_WORKSPACE_ROOT;
  } else {
    process.env.PM_SOURCE_WORKSPACE_ROOT = originalSourceWorkspaceRoot;
  }
  if (originalPmAuthor === undefined) {
    delete process.env.PM_AUTHOR;
  } else {
    process.env.PM_AUTHOR = originalPmAuthor;
  }
  await Promise.all(
    tempRoots
      .splice(0)
      .map((tempRoot) => rm(tempRoot, { recursive: true, force: true })),
  );
});

describe("agent runtime SDK primitives", () => {
  it("detects supported harness namespaces from pure bounded signals", () => {
    const environmentCases = [
      ["CLAUDE_CODE", "claude-code"],
      ["CODEX_HOME", "codex"],
      ["PI_AGENT", "pi"],
      ["OPENCODE", "opencode"],
      ["CURSOR_AGENT", "cursor"],
      ["AIDER", "aider"],
      ["GEMINI_CLI", "gemini-cli"],
      ["GITHUB_ACTIONS", "ci"],
    ] as const;
    for (const [key, expected] of environmentCases) {
      expect(detectHarnessIdentity({ env: { [key]: "1" } })).toBe(expected);
    }
    expect(
      detectHarnessIdentity({
        env: {},
        argv: ["/usr/local/bin/node", "/opt/opencode/bin/opencode"],
      }),
    ).toBe("opencode");
    expect(
      detectHarnessIdentity({ env: {}, argv: ["node", "script.js"] }),
    ).toBeUndefined();
    expect(detectHarnessIdentity({ argv: [] })).toBeUndefined();
  });

  it("resolves author precedence and records provenance on new history", () => {
    expect(
      resolveAuthorIdentity(" explicit ", "configured", {
        env: { PM_AUTHOR: "environment", CODEX_HOME: "/tmp/codex" },
      }),
    ).toEqual({ author: "explicit", source: "asserted" });
    expect(
      resolveAuthorIdentity(undefined, "configured", {
        env: { PM_AUTHOR: "environment" },
      }),
    ).toEqual({ author: "environment", source: "asserted" });
    expect(
      resolveAuthorIdentity(undefined, " configured ", {
        env: { CODEX_HOME: "/tmp/codex" },
      }),
    ).toEqual({ author: "configured", source: "configured" });
    expect(
      resolveAuthorIdentity(undefined, "", {
        env: { CODEX_HOME: "/tmp/codex" },
      }),
    ).toEqual({
      author: "harness:codex",
      source: "detected",
      harness: "codex",
    });
    expect(resolveAuthorIdentity(undefined, "", { env: {} })).toEqual({
      author: "unknown",
      source: "unknown",
    });

    delete process.env.PM_AUTHOR;
    const author = resolveAuthor(undefined, "configured-agent");
    const emptyDocument = EMPTY_CANONICAL_DOCUMENT as unknown as ItemDocument;
    expect(
      createHistoryEntry({
        nowIso: "2026-07-25T00:00:00.000Z",
        author,
        op: "test",
        before: emptyDocument,
        after: emptyDocument,
      }),
    ).toMatchObject({
      author: "configured-agent",
      author_source: "configured",
    });
  });

  it("preserves source workspace coordinates across sandbox tracker roots", async () => {
    const sourceRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-source-workspace-"),
    );
    tempRoots.push(sourceRoot);
    await mkdir(path.join(sourceRoot, ".git"));
    const sandboxPmRoot = path.join(os.tmpdir(), "pm-sandbox", ".agents", "pm");
    process.env.PM_SOURCE_WORKSPACE_ROOT = path.join(
      sourceRoot,
      "packages",
      "child",
    );

    expect(resolvePortableWorkspaceContext(sandboxPmRoot)).toEqual({
      source_workspace_root: sourceRoot,
      repo_root: sourceRoot,
    });
    expect(
      resolvePortableWorkspaceContext(path.join(sourceRoot, ".agents", "pm")),
    ).toEqual({
      source_workspace_root: sourceRoot,
      repo_root: sourceRoot,
      pm_root_rel: ".agents/pm",
    });

    process.env.PM_SOURCE_WORKSPACE_ROOT = sourceRoot;
    expect(resolvePortableWorkspaceContext(undefined)).toEqual({
      source_workspace_root: sourceRoot,
      repo_root: sourceRoot,
    });
    expect(_testOnlyValidateCommand.resolveWorkspaceRoot(sandboxPmRoot)).toBe(
      sourceRoot,
    );

    const nonRepositoryRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-source-without-git-"),
    );
    tempRoots.push(nonRepositoryRoot);
    process.env.PM_SOURCE_WORKSPACE_ROOT = nonRepositoryRoot;
    expect(resolvePortableWorkspaceContext(undefined)).toEqual({
      source_workspace_root: nonRepositoryRoot,
    });
    expect(
      resolvePortableWorkspaceContext(path.join(nonRepositoryRoot, ".agents", "pm")),
    ).toEqual({
      source_workspace_root: nonRepositoryRoot,
      pm_root_rel: ".agents/pm",
    });
    setActiveCommandContext(null);
  });

  it("validates linked files against the source workspace while tracker storage stays sandboxed", async () => {
    const sourceRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-source-files-"),
    );
    tempRoots.push(sourceRoot);
    await mkdir(path.join(sourceRoot, "src"));
    await writeFile(
      path.join(sourceRoot, "src", "existing.ts"),
      "export const exists = true;\n",
      "utf8",
    );

    await withTempPmPath(async (context) => {
      const created = context.runCli(
        [
          "create",
          "--title",
          "source workspace validation",
          "--description",
          "Keep tracker storage isolated from linked file resolution",
          "--type",
          "Task",
          "--status",
          "open",
          "--author",
          "test-agent",
          "--file",
          "path=src/existing.ts,scope=project",
          "--json",
        ],
        { expectJson: true },
      );
      expect(created.code).toBe(0);

      process.env.PM_SOURCE_WORKSPACE_ROOT = sourceRoot;
      const result = await runValidate(
        { checkFiles: true },
        { path: context.pmPath },
      );
      const fileCheck = result.checks.find((check) => check.name === "files");
      expect(fileCheck?.details).toMatchObject({
        workspace_root: sourceRoot,
        missing_linked_paths_count: 0,
      });
      expect(context.pmPath.startsWith(sourceRoot)).toBe(false);
    });
  });

  it("normalizes repeatable flags and rejects misspelled descriptor fields", async () => {
    const loadResult = (
      activate: (api: {
        registerFlags(
          targetCommand: string,
          flags: Array<Record<string, unknown>>,
        ): void;
      }) => void,
    ): ExtensionLoadResult => ({
      disabled_by_flag: false,
      roots: { global: "/tmp/global", project: "/tmp/project" },
      configured_enabled: [],
      configured_disabled: [],
      discovered: [],
      effective: [],
      warnings: [],
      failed: [],
      loaded: [
        {
          layer: "project",
          directory: "agent-runtime",
          manifest_path: "/tmp/project/agent-runtime/manifest.json",
          name: "agent-runtime",
          version: "1.0.0",
          entry: "./index.mjs",
          priority: 10,
          entry_path: "/tmp/project/agent-runtime/index.mjs",
          module: { activate },
        },
      ],
    });

    const accepted = await activateExtensions(
      loadResult((api) => {
        api.registerFlags("list-open", [
          { long: "--label <value>", repeatable: true, default: ["one"] },
        ]);
      }),
    );
    expect(accepted.failed).toEqual([]);
    expect(accepted.registrations.flags[0]?.flags[0]).toMatchObject({
      repeatable: true,
      list: true,
    });

    const rejected = await activateExtensions(
      loadResult((api) => {
        api.registerFlags("list-open", [
          { long: "--label <value>", repeateble: true, typo: true },
        ]);
      }),
    );
    expect(rejected.failed[0]?.error).toContain(
      "contains unknown field(s): repeateble, typo",
    );

    const mismatchedAliases = await activateExtensions(
      loadResult((api) => {
        api.registerFlags("list-open", [
          { long: "--label <value>", list: true, repeatable: false },
        ]);
      }),
    );
    expect(mismatchedAliases.failed[0]?.error).toContain(
      "list and repeatable must match",
    );

    expect(
      coerceLooseCommandOptionsWithFlagDefinitions(
        { edge: ["", null, undefined, "id=pm-a,kind=related"] },
        [
          {
            long: "--edge",
            repeatable: true,
            list: true,
            value_type: "string",
          },
        ],
      ),
    ).toEqual({ edge: ["id=pm-a,kind=related"] });
    expect(
      coerceLooseCommandOptionsWithFlagDefinitions(
        { edge: "id=pm-b,kind=related" },
        [{ long: "--edge", repeatable: true, list: true }],
      ),
    ).toEqual({ edge: ["id=pm-b,kind=related"] });
  });
});
