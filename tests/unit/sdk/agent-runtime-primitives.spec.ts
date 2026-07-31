import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  detectAgentIdentity,
  detectHarnessIdentity,
  registerHarnessSignalDescriptors,
  resolveAuthor,
  resolveAuthorIdentity,
  resolveHistoryAgentIdentity,
  runWithHarnessDetectionSignals,
  runWithWorkspaceHarnessSignalDescriptors,
} from "../../../src/core/shared/author.js";
import { EMPTY_CANONICAL_DOCUMENT } from "../../../src/core/shared/constants.js";
import { runClose } from "../../../src/cli/commands/close.js";
import { runUpdate } from "../../../src/cli/commands/update.js";
import {
  _testOnlyValidateCommand,
  runValidate,
} from "../../../src/sdk/governance/validate.js";
import {
  readSettings,
  writeSettings,
} from "../../../src/sdk/runtime-primitives.js";
import type { ItemDocument } from "../../../src/types.js";
import { withTempPmPath } from "../../helpers/withTempPmPath.js";
import { withIsolatedHarnessEnvironment } from "../../helpers/withIsolatedHarnessEnvironment.js";

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
    expect(
      detectHarnessIdentity({
        env: {},
        argv: ["node", "pm", "comments", "pm-item", "claude-code-agent"],
      }),
    ).toBeUndefined();
    expect(detectHarnessIdentity({ argv: [] })).toBeUndefined();
  });

  it("resolves model-aware agent provenance from environment, argv, and client signals", () => {
    expect(
      detectAgentIdentity({
        env: {
          CODEX_HOME: "/tmp/codex",
          CODEX_MODEL: "gpt-5.6-sol",
          CODEX_THREAD_ID: "thread-123",
        },
      }),
    ).toEqual({
      harness: "codex",
      instance: "6790ed693ac61e5353a1e2e4",
      model: "gpt-5.6-sol",
      model_source: "environment",
      provenance: {
        effort: null,
        model: {
          source: "environment",
          value: "gpt-5.6-sol",
        },
        role: null,
      },
      session: "thread-123",
    });
    expect(
      detectAgentIdentity({
        env: { PM_AGENT_MODEL: "operator-model" },
        argv: ["codex", "--model", "argv-model"],
      }),
    ).toEqual({
      harness: "codex",
      model: "operator-model",
      model_source: "override",
      provenance: {
        effort: null,
        model: {
          source: "override",
          value: "operator-model",
        },
        role: null,
      },
    });
    expect(
      detectAgentIdentity({
        env: {},
        client_info: {
          name: "Claude Code",
          version: "1.2.3",
          model: "claude-opus",
          session: "mcp-session",
        },
      }),
    ).toEqual({
      harness: "claude-code",
      instance: expect.any(String),
      model: "claude-opus",
      model_source: "mcp_client",
      provenance: {
        effort: null,
        model: {
          source: "mcp_client",
          value: "claude-opus",
        },
        role: null,
      },
      session: "mcp-session",
    });
    expect(
      detectAgentIdentity({
        env: {},
        argv: ["opencode", "--model=qwen-coder"],
      }),
    ).toEqual({
      harness: "opencode",
      model: "qwen-coder",
      model_source: "argv",
      provenance: {
        effort: null,
        model: {
          source: "argv",
          value: "qwen-coder",
        },
        role: null,
      },
    });
  });

  it("uses ambient signals by default and records extensible effort and role provenance", async () => {
    await withIsolatedHarnessEnvironment(
      {
        CODEX_THREAD_ID: "ambient-thread",
        PM_AGENT_MODEL: "ambient-model",
        PM_AGENT_EFFORT: "xhigh",
        PM_AGENT_ROLE: "reviewer",
      },
      () => {
        expect(detectAgentIdentity()).toEqual({
          harness: "codex",
          instance: expect.any(String),
          model: "ambient-model",
          model_source: "override",
          provenance: {
            effort: { source: "override", value: "xhigh" },
            model: { source: "override", value: "ambient-model" },
            role: { source: "override", value: "reviewer" },
          },
          session: "ambient-thread",
        });
        expect(detectHarnessIdentity()).toBe("codex");
      },
    );
  });

  it("retains explicit default provenance overrides without requiring a harness marker", () => {
    expect(
      detectAgentIdentity({
        env: {
          PM_AGENT_EFFORT: "xhigh",
          PM_AGENT_ROLE: "implementation-lead",
        },
      }),
    ).toEqual({
      provenance: {
        effort: { source: "override", value: "xhigh" },
        role: { source: "override", value: "implementation-lead" },
      },
    });
  });

  it("appends declarative harness descriptors with collision-safe cleanup", () => {
    const descriptor = {
      harness: "synthetic-agent",
      environment_keys: ["SYNTHETIC_AGENT"],
      model_environment_keys: ["SYNTHETIC_MODEL"],
      session_environment_keys: ["SYNTHETIC_SESSION"],
      argv_markers: ["synthetic-agent"],
      client_names: ["synthetic-client"],
    };
    const disposers: Array<() => void> = [];
    try {
      disposers.push(registerHarnessSignalDescriptors([descriptor]));
      disposers.push(registerHarnessSignalDescriptors([descriptor]));
      expect(
        detectAgentIdentity({
          env: {
            SYNTHETIC_AGENT: "1",
            SYNTHETIC_MODEL: "test-model",
            SYNTHETIC_SESSION: "session-1",
          },
        }),
      ).toEqual({
        harness: "synthetic-agent",
        instance: "159ec307ab8c324e240c067e",
        model: "test-model",
        model_source: "environment",
        provenance: {
          effort: null,
          model: {
            source: "environment",
            value: "test-model",
          },
          role: null,
        },
        session: "session-1",
      });
      expect(() =>
        registerHarnessSignalDescriptors([
          { harness: "codex", environment_keys: ["OTHER_CODEX"] },
        ]),
      ).toThrowError(/Harness signal descriptor collision.*codex/u);
      expect(() =>
        registerHarnessSignalDescriptors([{ harness: "Invalid Namespace" }]),
      ).toThrowError(/Invalid harness signal descriptor namespace/u);
      expect(() =>
        registerHarnessSignalDescriptors([
          {
            harness: "synthetic-agent",
            environment_keys: ["DIFFERENT_SYNTHETIC_AGENT"],
          },
        ]),
      ).toThrowError(/Harness signal descriptor collision.*synthetic-agent/u);
      expect(() =>
        runWithWorkspaceHarnessSignalDescriptors([descriptor], () => undefined),
      ).toThrowError(/Harness signal descriptor collision.*synthetic-agent/u);
      disposers[0]!();
      expect(detectHarnessIdentity({ env: { SYNTHETIC_AGENT: "1" } })).toBe(
        "synthetic-agent",
      );
      disposers[0]!();
      disposers[1]!();
      expect(
        detectHarnessIdentity({ env: { SYNTHETIC_AGENT: "1" } }),
      ).toBeUndefined();
    } finally {
      for (const dispose of disposers.reverse()) dispose();
    }
  });

  it("supports minimal workspace descriptors and literal client and argv signals", () => {
    const descriptor = { harness: "minimal-agent" };
    expect(
      runWithWorkspaceHarnessSignalDescriptors([descriptor], () =>
        detectHarnessIdentity({
          env: {},
          argv: ["node"],
          client_info: { name: "unrelated" },
        }),
      ),
    ).toBeUndefined();
    expect(
      detectAgentIdentity({
        env: {},
        argv: ["codex", "--model"],
      }),
    ).toEqual({
      harness: "codex",
      provenance: { effort: null, model: null, role: null },
    });
    expect(
      detectAgentIdentity({ env: {}, argv: ["/home/pi/project", "status"] }),
    ).toEqual({});
    expect(
      detectAgentIdentity({
        env: Object.create({ constructor: () => "not-an-env-value" }) as Record<
          string,
          string
        >,
        descriptors: [
          { harness: "prototype-safe", environment_keys: ["constructor"] },
        ],
      }),
    ).toEqual({});
  });

  it("resolves author precedence and records provenance on new history", () => {
    expect(
      resolveAuthorIdentity(" explicit ", "configured", {
        env: {
          PM_AUTHOR: "environment",
          CODEX_HOME: "/tmp/codex",
          CODEX_MODEL: "gpt-5.6-sol",
        },
      }),
    ).toEqual({
      author: "explicit",
      source: "asserted",
      harness: "codex",
      model: "gpt-5.6-sol",
      model_source: "environment",
      provenance: {
        effort: null,
        model: {
          source: "environment",
          value: "gpt-5.6-sol",
        },
        role: null,
      },
    });
    expect(
      resolveAuthorIdentity(undefined, "configured", {
        env: { PM_AUTHOR: "environment" },
      }),
    ).toEqual({ author: "environment", source: "asserted" });
    expect(
      resolveAuthorIdentity(undefined, " configured ", {
        env: { CODEX_HOME: "/tmp/codex" },
      }),
    ).toEqual({
      author: "configured",
      source: "configured",
      harness: "codex",
      provenance: { effort: null, model: null, role: null },
    });
    expect(
      resolveAuthorIdentity(undefined, "", {
        env: { CODEX_HOME: "/tmp/codex" },
      }),
    ).toEqual({
      author: "harness:codex",
      source: "detected",
      harness: "codex",
      provenance: { effort: null, model: null, role: null },
    });
    expect(resolveAuthorIdentity(undefined, "", { env: {} })).toEqual({
      author: "unknown",
      source: "unknown",
    });
    expect(resolveHistoryAgentIdentity("harness:opencode")).toEqual({
      harness: "opencode",
    });

    delete process.env.PM_AUTHOR;
    const author = resolveAuthor(undefined, "configured-agent");
    const emptyDocument = EMPTY_CANONICAL_DOCUMENT as unknown as ItemDocument;
    expect(
      runWithHarnessDetectionSignals(
        {
          env: {
            CODEX_HOME: "/tmp/codex",
            CODEX_MODEL: "gpt-5.6-sol",
            CODEX_THREAD_ID: "thread-456",
            PM_AGENT_EFFORT: "high",
            PM_AGENT_ROLE: "implementation",
          },
        },
        () => {
          const contextualAuthor = resolveAuthor(undefined, "configured-agent");
          return createHistoryEntry({
            nowIso: "2026-07-25T00:00:00.000Z",
            author: contextualAuthor,
            op: "test",
            before: emptyDocument,
            after: emptyDocument,
          });
        },
      ),
    ).toMatchObject({
      author: "configured-agent",
      author_source: "configured",
      agent_harness: "codex",
      agent_model: "gpt-5.6-sol",
      agent_model_source: "environment",
      agent_provenance: {
        effort: { source: "override", value: "high" },
        model: { source: "environment", value: "gpt-5.6-sol" },
        role: { source: "override", value: "implementation" },
      },
    });
    expect(author).toBe("configured-agent");
  });

  it("attributes update and close mutations to the detected harness", async () => {
    await withTempPmPath(async (context) => {
      const created = context.runCli(
        [
          "create",
          "--title",
          "harness mutation parity",
          "--description",
          "Exercise update and close without explicit author configuration",
          "--type",
          "Task",
          "--status",
          "open",
          "--author",
          "fixture-author",
          "--json",
        ],
        { expectJson: true },
      );
      const id = (created.json as { item: { id: string } }).item.id;
      const settings = await readSettings(context.pmPath);
      await writeSettings(context.pmPath, { ...settings, author_default: "" });
      await withIsolatedHarnessEnvironment(
        { CODEX_THREAD_ID: "runtime-mutation-parity" },
        async () => {
          await runUpdate(
            id,
            { description: "Updated through detected harness identity" },
            { path: context.pmPath },
          );
          await runClose(
            id,
            "Closed through detected harness identity",
            {
              resolution: "Harness attribution is preserved",
              expectedResult: "Update and close use the shared resolver",
              actualResult:
                "Both history entries record detected Codex identity",
            },
            { path: context.pmPath },
          );
        },
      );

      const history = (
        await readFile(
          path.join(context.pmPath, "history", `${id}.jsonl`),
          "utf8",
        )
      )
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              op: string;
              author: string;
              author_source?: string;
            },
        )
        .filter((entry) => entry.op === "update" || entry.op === "close");
      expect(history).toEqual([
        {
          op: "update",
          author: "harness:codex",
          author_source: "detected",
          agent_harness: "codex",
          agent_instance: expect.any(String),
          agent_provenance: { effort: null, model: null, role: null },
          ts: expect.any(String),
          patch: expect.any(Array),
          before_hash: expect.any(String),
          after_hash: expect.any(String),
        },
        {
          op: "close",
          author: "harness:codex",
          author_source: "detected",
          agent_harness: "codex",
          agent_instance: expect.any(String),
          agent_provenance: { effort: null, model: null, role: null },
          ts: expect.any(String),
          patch: expect.any(Array),
          before_hash: expect.any(String),
          after_hash: expect.any(String),
        },
      ]);
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
      resolvePortableWorkspaceContext(
        path.join(nonRepositoryRoot, ".agents", "pm"),
      ),
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
