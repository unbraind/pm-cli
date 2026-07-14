import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as readline from "node:readline/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runHealth } from "../../../src/cli/commands/health.js";
import {
  _testOnly as initInternals,
  runInit,
  summarizeInitResult,
} from "../../../src/cli/commands/init.js";
import { runPmCli } from "../../../src/cli/main.js";
import {
  _testOnly as initGuidanceInternals,
  runInitAgentGuidance,
} from "../../../src/cli/commands/init-agent-guidance.js";
import {
  EXIT_CODE,
  PM_REQUIRED_SUBDIRS,
} from "../../../src/core/shared/constants.js";
import {
  clearActiveExtensionHooks,
  setActiveExtensionHooks,
  type ExtensionHookRegistry,
} from "../../../src/core/extensions/index.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import { readSettings } from "../../../src/core/store/settings.js";

describe("runInit", () => {
  beforeEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: false,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });
  });

  afterEach(() => {
    clearActiveExtensionHooks();
    initInternals.setInitReadlineFactoryForTests(undefined);
    initGuidanceInternals.setAgentGuidanceReadlineFactoryForTests(undefined);
    vi.restoreAllMocks();
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: false,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });
  });

  it("covers init option normalizers and governance application", async () => {
    initInternals.setInitReadlineFactoryForTests(undefined);
    initGuidanceInternals.setAgentGuidanceReadlineFactoryForTests(undefined);

    expect(
      initInternals.normalizeInitGovernancePreset(undefined),
    ).toBeUndefined();
    expect(initInternals.normalizeInitGovernancePreset("lite")).toBe("minimal");
    expect(initInternals.normalizeInitGovernancePreset("minimum")).toBe(
      "minimal",
    );
    expect(initInternals.normalizeInitGovernancePreset("strict")).toBe(
      "strict",
    );
    expect(() => initInternals.normalizeInitGovernancePreset(" ")).toThrow(
      /--preset must not be empty/,
    );
    expect(() => initInternals.normalizeInitGovernancePreset("heavy")).toThrow(
      /Invalid --preset/,
    );

    expect(initInternals.normalizeInitTypePreset(undefined)).toBeUndefined();
    expect(initInternals.normalizeInitTypePreset("research")).toBe("research");
    expect(() => initInternals.normalizeInitTypePreset(" ")).toThrow(
      /--type-preset must not be empty/,
    );
    expect(() => initInternals.normalizeInitTypePreset("sales")).toThrow(
      /Invalid --type-preset/,
    );

    expect(
      initInternals.normalizeOptionalInitAuthor(undefined),
    ).toBeUndefined();
    expect(initInternals.normalizeOptionalInitAuthor(" agent ")).toBe("agent");
    expect(() => initInternals.normalizeOptionalInitAuthor(" ")).toThrow(
      /--author must not be empty/,
    );
    expect(initInternals.isPathLikeInitTarget(undefined)).toBe(false);
    expect(initInternals.isPathLikeInitTarget("  ")).toBe(false);
    expect(initInternals.isPathLikeInitTarget("acme")).toBe(false);
    expect(initInternals.isPathLikeInitTarget("./sandbox")).toBe(true);
    expect(initInternals.isPathLikeInitTarget("/tmp/pm-test")).toBe(true);
    expect(
      initInternals.resolveInitInvocation("/repo", {}, "./sandbox"),
    ).toEqual({
      pmRoot: path.resolve("/repo", "sandbox"),
      prefixArg: undefined,
      target: {
        mode: "tracker-path",
        tracker_root: path.resolve("/repo", "sandbox"),
      },
    });
    expect(
      initInternals.resolveInitInvocation(
        "/repo",
        { path: "/repo/.agents/pm" },
        "./sandbox",
      ),
    ).toEqual({
      // resolvePmRoot delegates to path.resolve(cwd, explicitPath), so the
      // expectation must be platform-native (POSIX `/repo/.agents/pm`,
      // win32 `<drive>\repo\.agents\pm`) rather than a hardcoded forward-slash
      // literal that only matches on POSIX nightly runners (pm-i84i).
      pmRoot: path.resolve("/repo", "/repo/.agents/pm"),
      prefixArg: "./sandbox",
      target: {
        mode: "tracker-path",
        tracker_root: path.resolve("/repo", "/repo/.agents/pm"),
      },
    });
    const discoveryInvocation = initInternals.resolveInitInvocation(
      "/repo",
      {},
      "acme",
    );
    expect(discoveryInvocation).toMatchObject({
      prefixArg: "acme",
      target: { mode: "workspace-discovery", workspace_root: "/repo" },
    });
    expect(discoveryInvocation.target.tracker_root).toBe(
      discoveryInvocation.pmRoot,
    );
    expect(
      initInternals.resolveInitPrefixInput(undefined, undefined),
    ).toBeUndefined();
    expect(initInternals.resolveInitPrefixInput("app", undefined)).toBe("app");
    expect(initInternals.resolveInitPrefixInput(undefined, "ops")).toBe("ops");
    expect(initInternals.resolveInitPrefixInput("app", "app-")).toBe("app-");
    expect(() => initInternals.resolveInitPrefixInput(undefined, " ")).toThrow(
      "--id-prefix must not be empty",
    );
    expect(() => initInternals.resolveInitPrefixInput("app", "ops")).toThrow(
      expect.objectContaining({
        context: expect.objectContaining({ code: "init_id_prefix_conflict" }),
      }),
    );
    expect(
      initInternals.resolveInitInvocation("/repo", {}, "acme", "./workspace"),
    ).toEqual({
      pmRoot: path.resolve("/repo/workspace/.agents/pm"),
      prefixArg: "acme",
      target: {
        mode: "workspace-path",
        tracker_root: path.resolve("/repo/workspace/.agents/pm"),
        workspace_root: path.resolve("/repo/workspace"),
      },
    });
    expect(() =>
      initInternals.resolveInitInvocation("/repo", {}, undefined, " "),
    ).toThrow("--workspace must not be empty");
    expect(() =>
      initInternals.resolveInitInvocation(
        "/repo",
        { path: "/tmp/pm" },
        undefined,
        "./workspace",
      ),
    ).toThrow("cannot be combined");
    expect(() =>
      initInternals.resolveInitInvocation(
        "/repo",
        {},
        "./tracker",
        "./workspace",
      ),
    ).toThrow("cannot be combined");

    const discoverySteps = initInternals.buildInitNextSteps({
      installBundledPackages: false,
      registeredTypePreset: undefined,
      agentGuidanceNextSteps: ["Run pm context before editing."],
      target: {
        mode: "workspace-discovery",
        tracker_root: path.resolve("/repo/.agents/pm"),
        workspace_root: "/repo",
      },
    });
    expect(discoverySteps).toContain("Run pm context before editing.");
    const scopedSteps = initInternals.buildInitNextSteps({
      installBundledPackages: true,
      registeredTypePreset: {
        preset: "agile",
        registered: [],
        updated: ["Story"],
      },
      agentGuidanceNextSteps: [
        "Run pm context before editing.",
        "Run pm context before editing.",
      ],
      target: {
        mode: "tracker-path",
        tracker_root: path.resolve("/tmp/tracker"),
      },
    });
    expect(scopedSteps).toContain(
      `Run pm --pm-path ${path.resolve("/tmp/tracker")} context before editing.`,
    );
    expect(
      scopedSteps.filter((step) => step.includes("context before editing")),
    ).toHaveLength(1);
    expect(scopedSteps).toContain(
      `Inspect registered preset types: pm --pm-path ${path.resolve("/tmp/tracker")} schema list, pm --pm-path ${path.resolve("/tmp/tracker")} schema show Story`,
    );
    const replacementSensitivePath = path.resolve("/tmp/tracker$&cash$$tail");
    expect(
      initInternals.buildInitNextSteps({
        installBundledPackages: true,
        registeredTypePreset: undefined,
        agentGuidanceNextSteps: ["Run pm context before editing."],
        target: {
          mode: "tracker-path",
          tracker_root: replacementSensitivePath,
        },
      }),
    ).toContain(
      `Run pm --pm-path "${replacementSensitivePath.replaceAll("$", "\\$")}" context before editing.`,
    );

    expect(initInternals.normalizeInitAgentGuidanceMode(undefined)).toBe("ask");
    expect(initInternals.normalizeInitAgentGuidanceMode("status")).toBe(
      "status",
    );
    expect(() => initInternals.normalizeInitAgentGuidanceMode(" ")).toThrow(
      /--agent-guidance must not be empty/,
    );
    expect(() => initInternals.normalizeInitAgentGuidanceMode("later")).toThrow(
      /Invalid --agent-guidance/,
    );

    expect(initInternals.parseYesNoChoice("", true)).toBe(true);
    expect(initInternals.parseYesNoChoice("Y", false)).toBe(true);
    expect(initInternals.parseYesNoChoice("no", true)).toBe(false);
    expect(initInternals.parseYesNoChoice("maybe", false)).toBe(false);

    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-init-governance-helper-"),
    );
    try {
      await runInit("pm", { path: tempRoot }, { defaults: true });
      const settings = await readSettings(tempRoot);
      initInternals.applyGovernancePreset(settings, "strict");
      expect(settings.governance.preset).toBe("strict");
      expect(settings.validation.parent_reference).toBe(
        settings.governance.parent_reference,
      );
      expect(settings.validation.metadata_profile).toBe(
        settings.governance.metadata_profile,
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("updates author on an existing tracker when init is forced", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-init-existing-author-"),
    );
    try {
      await runInit(
        "pm",
        { path: tempRoot },
        { defaults: true, author: "first-agent" },
      );

      const result = await runInit(
        "pm",
        { path: tempRoot },
        { defaults: true, force: true, author: "second-agent" },
      );
      const settings = await readSettings(tempRoot);

      expect(settings.author_default).toBe("second-agent");
      expect(result.warnings).toContain("updated:author_default:second-agent");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("summarizes package install details and guards workspace-root tracker paths", async () => {
    expect(
      initInternals.summarizeInstalledPackages({
        ok: true,
        warnings: ["warn"],
        details: {
          installed_all: true,
          installed_count: 2,
          skipped_count: 1,
          failed_count: 0,
          packages: [
            { alias: "calendar", ok: true },
            { alias: "guide", ok: false },
            { alias: 42, ok: false },
            null,
            [{ alias: "array-package", ok: true }],
          ],
        },
      }),
    ).toEqual({
      installed_all: true,
      installed_count: 2,
      packages: [
        { alias: "calendar", ok: true },
        { alias: "guide", ok: false },
        { alias: "", ok: false },
      ],
    });

    expect(
      initInternals.summarizeInstalledPackages({
        ok: true,
        warnings: [],
        details: {},
      }),
    ).toMatchObject({ installed_all: false, installed_count: 0, packages: [] });

    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-init-workspace-guard-"),
    );
    try {
      expect(await initInternals.isLikelyWorkspaceRoot(tempRoot)).toBe(false);
      await writeFile(path.join(tempRoot, "package.json"), "{}\n", "utf8");
      expect(await initInternals.isLikelyWorkspaceRoot(tempRoot)).toBe(true);
      await expect(
        initInternals.assertExplicitTrackerPathIsNotWorkspaceRoot(
          tempRoot,
          true,
          false,
        ),
      ).rejects.toHaveProperty("context.code", "workspace_root_pm_path");
      await expect(
        initInternals.assertExplicitTrackerPathIsNotWorkspaceRoot(
          tempRoot,
          true,
          true,
        ),
      ).resolves.toBeUndefined();
      await runInit("pm", { path: tempRoot }, { defaults: true, force: true });
      await expect(
        initInternals.assertExplicitTrackerPathIsNotWorkspaceRoot(
          tempRoot,
          true,
          false,
        ),
      ).resolves.toBeUndefined();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("covers agent guidance helper branches without prompting", () => {
    const projectRoot = path.join("tmp", "project");
    const agentsPath = path.join(projectRoot, "AGENTS.md");
    const claudePath = path.join(projectRoot, "CLAUDE.md");
    const block = initGuidanceInternals.buildAgentGuidanceBlock("\r\n");

    expect(
      initGuidanceInternals.toPortableRelativePath(projectRoot, projectRoot),
    ).toBe("project");
    expect(
      initGuidanceInternals.toPortableRelativePath(
        projectRoot,
        path.join(projectRoot, "nested", "AGENTS.md"),
      ),
    ).toBe("nested/AGENTS.md");
    expect(initGuidanceInternals.ensureTrailingNewline("missing")).toBe(
      "missing\n",
    );
    expect(initGuidanceInternals.ensureTrailingNewline("already\n")).toBe(
      "already\n",
    );
    expect(initGuidanceInternals.detectLineEnding(block)).toBe("\r\n");
    expect(
      initGuidanceInternals.findGuidanceBlockRange("plain text"),
    ).toBeNull();
    expect(
      initGuidanceInternals.findGuidanceBlockRange(
        "<!-- pm-cli:agent-guidance:start:v1 -->\nmissing end",
      ),
    ).toBeNull();
    expect(
      initGuidanceInternals.findGuidanceBlockRange(block)?.start_index,
    ).toBe(0);

    const inserted =
      initGuidanceInternals.upsertAgentGuidanceBlock("# Existing");
    expect(inserted.changed).toBe(true);
    expect(inserted.next_content).toContain(
      "<!-- pm-cli:agent-guidance:start:v1 -->",
    );
    const unchanged = initGuidanceInternals.upsertAgentGuidanceBlock(
      initGuidanceInternals.buildAgentGuidanceBlock("\n"),
    );
    expect(unchanged.next_content).toContain(
      "Set `PM_AUTHOR=<stable-agent-id>` before mutation commands.",
    );
    const crlfTrimmed = initGuidanceInternals.upsertAgentGuidanceBlock(
      `${initGuidanceInternals.buildAgentGuidanceBlock("\r\n")}# Tail`,
    );
    expect(crlfTrimmed.next_content).toContain("# Tail");
    const plainTail = initGuidanceInternals.upsertAgentGuidanceBlock(
      `${initGuidanceInternals.buildAgentGuidanceBlock("\n").replace(/\n$/, "")}#tail`,
    );
    expect(plainTail.next_content).toContain("#tail");

    expect(
      initGuidanceInternals.resolveProjectRoot(
        path.join(projectRoot, ".agents", "pm"),
        process.cwd(),
      ),
    ).toBe(projectRoot);
    expect(initGuidanceInternals.resolveProjectRoot("custom-pm", "/repo")).toBe(
      path.resolve("/repo", "custom-pm"),
    );
    expect(
      initGuidanceInternals.resolveTargetGuidancePath(
        [
          {
            file_path: agentsPath,
            exists: false,
            has_guidance: false,
            has_marker: false,
          },
          {
            file_path: claudePath,
            exists: true,
            has_guidance: false,
            has_marker: false,
          },
        ],
        projectRoot,
      ),
    ).toBe(claudePath);

    expect(initGuidanceInternals.parsePromptChoice("", true)).toBe(true);
    expect(initGuidanceInternals.parsePromptChoice("yes", false)).toBe(true);
    expect(initGuidanceInternals.parsePromptChoice("n", true)).toBe(false);
    expect(initGuidanceInternals.parsePromptChoice("later", false)).toBe(false);

    const settings = {
      agent_guidance: {
        prompt_completed: true,
        declined: true,
        declined_at: "2026-01-01T00:00:00.000Z",
        template_version: 0,
        last_checked_files: [" CLAUDE.md ", "", "AGENTS.md", "AGENTS.md"],
      },
    } as Parameters<
      typeof initGuidanceInternals.normalizeAgentGuidanceState
    >[0];
    expect(initGuidanceInternals.normalizeAgentGuidanceState(settings)).toEqual(
      {
        prompt_completed: true,
        declined: true,
        declined_at: "2026-01-01T00:00:00.000Z",
        template_version: 1,
        last_checked_files: ["AGENTS.md", "CLAUDE.md"],
      },
    );
    expect(
      initGuidanceInternals.normalizeAgentGuidanceState(
        {} as Parameters<
          typeof initGuidanceInternals.normalizeAgentGuidanceState
        >[0],
      ),
    ).toEqual({
      prompt_completed: false,
      declined: false,
      declined_at: "",
      template_version: 1,
      last_checked_files: [],
    });
    const stateUpdate = initGuidanceInternals.applyAgentGuidanceState(
      settings,
      {
        prompt_completed: false,
        declined: false,
        declined_at: "",
        template_version: 1,
        last_checked_files: ["AGENTS.md"],
      },
    );
    expect(stateUpdate.changed).toBe(true);
    expect(settings.agent_guidance?.last_checked_files).toEqual(["AGENTS.md"]);

    const nextSteps = [
      "Add workflow guidance later: pm init --agent-guidance add",
    ];
    initGuidanceInternals.pushUnique(
      nextSteps,
      "Add workflow guidance later: pm init --agent-guidance add",
    );
    expect(nextSteps).toEqual([
      "Add workflow guidance later: pm init --agent-guidance add",
    ]);
  });

  it("covers stale-scan no-op add and ask guidance write branches", async () => {
    const projectRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-init-guidance-stale-scan-"),
    );
    const pmRoot = path.join(projectRoot, ".agents", "pm");
    const guidancePath = path.join(projectRoot, "AGENTS.md");
    const claudePath = path.join(projectRoot, "CLAUDE.md");
    const staleScanContent = "# Guidance scan snapshot";
    const currentGuidance = initGuidanceInternals.buildAgentGuidanceBlock("\n");

    try {
      {
        vi.resetModules();
        let readCount = 0;
        const readFileMock = vi.fn(async (filePath: string) => {
          if (filePath === guidancePath) {
            readCount += 1;
            return readCount === 1 ? staleScanContent : currentGuidance;
          }
          throw new Error(`unexpected read path: ${filePath}`);
        });
        const writeFileMock = vi.fn(async () => undefined);
        const pathExistsMock = vi.fn(
          async (filePath: string) => filePath === guidancePath,
        );

        vi.doMock("node:fs/promises", () => ({
          default: { readFile: readFileMock, writeFile: writeFileMock },
          readFile: readFileMock,
          writeFile: writeFileMock,
        }));
        vi.doMock("../../../src/core/fs/fs-utils.js", () => ({
          pathExists: pathExistsMock,
        }));
        vi.doMock("../../../src/core/extensions/index.js", () => ({
          runActiveOnWriteHooks: vi.fn(async () => []),
        }));

        try {
          const mockedModule =
            await import("../../../src/cli/commands/init-agent-guidance.js");
          const addResult = await mockedModule.runInitAgentGuidance({
            pm_root: pmRoot,
            cwd: projectRoot,
            mode: "add",
            interactive: false,
            settings: {} as Parameters<
              typeof mockedModule.runInitAgentGuidance
            >[0]["settings"],
          });
          expect(addResult.summary.applied).toBe(false);
          expect(
            addResult.warnings.some((warning) =>
              warning.startsWith("agent_guidance:added:"),
            ),
          ).toBe(false);
          expect(writeFileMock).not.toHaveBeenCalled();
        } finally {
          vi.doUnmock("node:fs/promises");
          vi.doUnmock("../../../src/core/fs/fs-utils.js");
          vi.doUnmock("../../../src/core/extensions/index.js");
          vi.resetModules();
        }
      }

      {
        vi.resetModules();
        let readCount = 0;
        const readFileMock = vi.fn(async (filePath: string) => {
          if (filePath === guidancePath) {
            readCount += 1;
            return readCount === 1 ? staleScanContent : currentGuidance;
          }
          throw new Error(`unexpected read path: ${filePath}`);
        });
        const writeFileMock = vi.fn(async () => undefined);
        const pathExistsMock = vi.fn(
          async (filePath: string) => filePath === guidancePath,
        );
        const writeSpy = vi
          .spyOn(process.stdout, "write")
          .mockImplementation(() => true);

        vi.doMock("node:fs/promises", () => ({
          default: { readFile: readFileMock, writeFile: writeFileMock },
          readFile: readFileMock,
          writeFile: writeFileMock,
        }));
        vi.doMock("../../../src/core/fs/fs-utils.js", () => ({
          pathExists: pathExistsMock,
        }));
        vi.doMock("../../../src/core/extensions/index.js", () => ({
          runActiveOnWriteHooks: vi.fn(async () => []),
        }));

        try {
          const mockedModule =
            await import("../../../src/cli/commands/init-agent-guidance.js");
          mockedModule._testOnly.setAgentGuidanceReadlineFactoryForTests(
            () =>
              ({
                question: vi.fn(async () => "yes"),
                close: vi.fn(),
              }) as unknown as ReturnType<typeof readline.createInterface>,
          );
          const askResult = await mockedModule.runInitAgentGuidance({
            pm_root: pmRoot,
            cwd: projectRoot,
            mode: "ask",
            interactive: true,
            settings: {} as Parameters<
              typeof mockedModule.runInitAgentGuidance
            >[0]["settings"],
          });
          expect(askResult.summary.prompted).toBe(true);
          expect(askResult.summary.applied).toBe(false);
          expect(
            askResult.warnings.some((warning) =>
              warning.startsWith("agent_guidance:added:"),
            ),
          ).toBe(false);
          expect(writeFileMock).not.toHaveBeenCalled();
        } finally {
          writeSpy.mockRestore();
          vi.doUnmock("node:fs/promises");
          vi.doUnmock("../../../src/core/fs/fs-utils.js");
          vi.doUnmock("../../../src/core/extensions/index.js");
          vi.resetModules();
        }
      }
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("preserves prior declined_at on explicit skip and keeps present guidance in ask mode", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-init-guidance-branch-state-"),
    );
    try {
      await writeFile(
        tempRoot + "/AGENTS.md",
        initGuidanceInternals.buildAgentGuidanceBlock("\n"),
        "utf8",
      );

      const askResult = await runInitAgentGuidance({
        pm_root: tempRoot,
        cwd: path.dirname(tempRoot),
        mode: "ask",
        interactive: false,
        settings: {} as Parameters<typeof runInitAgentGuidance>[0]["settings"],
      });
      expect(askResult.summary.present).toBe(true);
      expect(askResult.summary.prompted).toBe(false);
      expect(askResult.settings_changed).toBe(false);

      const priorDeclinedAt = "2026-01-02T00:00:00.000Z";
      const skipSettings = {
        agent_guidance: {
          prompt_completed: true,
          declined: true,
          declined_at: priorDeclinedAt,
          template_version: 1,
          last_checked_files: [],
        },
      } as Parameters<typeof runInitAgentGuidance>[0]["settings"];
      const skipResult = await runInitAgentGuidance({
        pm_root: tempRoot,
        cwd: path.dirname(tempRoot),
        mode: "skip",
        interactive: false,
        settings: skipSettings,
      });
      expect(skipResult.summary.declined).toBe(true);
      expect(skipResult.summary.prompt_completed).toBe(true);
      expect(skipSettings.agent_guidance?.declined_at).toBe(priorDeclinedAt);

      const missingDeclinedAtSettings = {
        agent_guidance: {
          prompt_completed: true,
          declined: true,
          template_version: 1,
          last_checked_files: [],
        },
      } as unknown as Parameters<typeof runInitAgentGuidance>[0]["settings"];
      await expect(
        runInitAgentGuidance({
          pm_root: tempRoot,
          cwd: path.dirname(tempRoot),
          mode: "skip",
          interactive: false,
          settings: missingDeclinedAtSettings,
        }),
      ).resolves.toMatchObject({
        summary: {
          declined: true,
          prompt_completed: true,
        },
      });
      expect(missingDeclinedAtSettings.agent_guidance?.declined_at).not.toBe(
        "",
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("initializes a new tracker path with normalized prefix", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-init-create-"));
    try {
      const result = await runInit(" AcMe ", { path: tempRoot });
      expect(result.ok).toBe(true);
      expect(result.path).toBe(tempRoot);
      expect(result.settings.id_prefix).toBe("acme-");
      expect(result.created_dirs).toHaveLength(
        PM_REQUIRED_SUBDIRS.length - 1 + 4,
      );
      expect(result.warnings).toContain(`already_exists:${tempRoot}`);
      expect(result.warnings).toContain(
        "agent_guidance:missing_non_interactive",
      );
      expect(result.agent_guidance).toMatchObject({
        mode: "ask",
        present: false,
        prompted: false,
        applied: false,
      });
      expect(result.next_steps).toContain(
        `Add workflow guidance later: pm --pm-path ${tempRoot} init --agent-guidance add`,
      );

      for (const subdir of PM_REQUIRED_SUBDIRS) {
        const expectedPath = subdir ? path.join(tempRoot, subdir) : tempRoot;
        if (subdir === "") {
          expect(result.created_dirs).not.toContain(expectedPath);
        } else {
          expect(result.created_dirs).toContain(expectedPath);
        }
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("forwards the canonical id-prefix CLI flag through setup registration", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-init-id-prefix-registration-"),
    );
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      await runPmCli([
        "--pm-path",
        tempRoot,
        "init",
        "--id-prefix",
        "ops",
        "--yes",
        "--json",
      ]);
      expect((await readSettings(tempRoot)).id_prefix).toBe("ops-");
    } finally {
      writeSpy.mockRestore();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("summarizes an init result into a concise projection without the full settings tree", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-init-summary-"));
    try {
      const result = await runInit(
        "acme",
        { path: tempRoot },
        { defaults: true },
      );
      const summary = summarizeInitResult(result);

      // Drops the verbose settings tree but keeps the surfaced essentials.
      expect(summary).not.toHaveProperty("settings");
      expect(summary.ok).toBe(true);
      expect(summary.path).toBe(tempRoot);
      expect(summary.target).toEqual(result.target);
      expect(summary.id_prefix).toBe("acme-");
      expect(summary.governance_preset).toBe(result.governance_preset);
      expect(summary.telemetry).toEqual({
        enabled: result.settings.telemetry.enabled,
        capture_level: result.settings.telemetry.capture_level,
      });
      expect(summary.output_format).toBe(result.settings.output.default_format);
      expect(summary.created_dirs_count).toBe(result.created_dirs.length);
      expect(summary.created_dirs).toEqual(result.created_dirs);
      // No init-only information is lost: all warnings (including already_exists)
      // and next steps survive into the concise summary.
      expect(summary.warnings).toEqual(result.warnings);
      expect(summary.warnings).toContain(`already_exists:${tempRoot}`);
      expect(summary.next_steps).toEqual(result.next_steps);
      expect(summary.agent_guidance).toEqual(result.agent_guidance);
      expect(summary.hint).toContain("--verbose");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("carries an installed-packages summary into the concise projection when present", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-init-summary-pkgs-"),
    );
    try {
      const result = await runInit(
        "pm",
        { path: tempRoot },
        { defaults: true, withPackages: true },
      );
      const summary = summarizeInitResult(result);
      expect(summary.installed_packages).toEqual(result.installed_packages);
      expect(summary.installed_packages?.installed_all).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("registers domain type presets into runtime schema during initialization", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-init-type-preset-"),
    );
    try {
      const result = await runInit(
        "pm",
        { path: tempRoot },
        { defaults: true, typePreset: "agile" },
      );
      expect(result.registered_type_preset).toMatchObject({
        name: "agile",
        registered: ["Story", "Spike"],
        updated: [],
      });
      expect(result.warnings).toContain("registered_type_preset:agile");
      expect(result.next_steps).toContain(
        `Inspect registered preset types: pm --pm-path ${tempRoot} schema list, pm --pm-path ${tempRoot} schema show Story`,
      );
      expect((await stat(path.join(tempRoot, "stories"))).isDirectory()).toBe(
        true,
      );
      expect((await stat(path.join(tempRoot, "spikes"))).isDirectory()).toBe(
        true,
      );

      const summary = summarizeInitResult(result);
      expect(summary.registered_type_preset).toEqual(
        result.registered_type_preset,
      );

      const types = JSON.parse(
        await readFile(path.join(tempRoot, "schema", "types.json"), "utf8"),
      ) as {
        definitions: Array<{
          name: string;
          aliases?: string[];
          folder?: string;
        }>;
      };
      expect(types.definitions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "Spike",
            folder: "spikes",
            aliases: ["research-spike"],
          }),
          expect.objectContaining({
            name: "Story",
            folder: "stories",
            aliases: ["user-story"],
          }),
        ]),
      );

      const rerun = await runInit(
        "pm",
        { path: tempRoot },
        { defaults: true, typePreset: "agile" },
      );
      expect(rerun.registered_type_preset).toMatchObject({
        name: "agile",
        registered: [],
        updated: ["Story", "Spike"],
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("repairs missing folders for runtime schema item types on re-run", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-init-schema-folders-"),
    );
    try {
      await runInit(
        "pm",
        { path: tempRoot },
        { defaults: true, agentGuidance: "skip" },
      );
      await writeFile(
        path.join(tempRoot, "schema", "types.json"),
        `${JSON.stringify(
          {
            definitions: [{ name: "ShowType" }, { name: "Type" }],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const before = await runHealth({ path: tempRoot }, { checkOnly: true });
      const beforeDirectories = before.checks.find(
        (check) => check.name === "directories",
      );
      expect(beforeDirectories?.details.missing_required).toEqual([
        "showtypes",
        "types",
      ]);

      const repaired = await runInit(
        "pm",
        { path: tempRoot },
        { defaults: true, agentGuidance: "skip" },
      );
      expect(repaired.created_dirs).toEqual([
        path.join(tempRoot, "showtypes"),
        path.join(tempRoot, "types"),
      ]);

      const after = await runHealth({ path: tempRoot }, { checkOnly: true });
      const afterDirectories = after.checks.find(
        (check) => check.name === "directories",
      );
      expect(afterDirectories?.details.missing_required).toEqual([]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("emits already-exists warnings and requires force before updating init-managed existing settings", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-init-reinit-"));
    try {
      const initial = await runInit("pm", { path: tempRoot });
      expect(initial.settings.id_prefix).toBe("pm-");

      const expectedSettingsPath = path.join(tempRoot, "settings.json");
      await expect(
        runInit("next", { path: tempRoot }),
      ).rejects.toMatchObject<PmCliError>({
        context: expect.objectContaining({
          code: "init_existing_settings_requires_force",
          required: "--force for id_prefix",
        }),
      });
      expect((await readSettings(tempRoot)).id_prefix).toBe("pm-");

      const updated = await runInit(
        "next",
        { path: tempRoot },
        { force: true },
      );

      expect(updated.created_dirs).toEqual([]);
      expect(updated.settings.id_prefix).toBe("next-");
      expect(updated.warnings).toContain(
        `already_exists:${expectedSettingsPath}`,
      );
      expect(updated.warnings).toContain("updated:id_prefix:next-");
      expect(
        updated.warnings.filter((warning) =>
          warning.startsWith("already_exists:"),
        ),
      ).toHaveLength(PM_REQUIRED_SUBDIRS.length + 1);

      const unchanged = await runInit("next", { path: tempRoot });
      expect(unchanged.warnings).toContain(
        `already_exists:${expectedSettingsPath}`,
      );
      expect(unchanged.warnings).not.toContain("updated:id_prefix:next-");

      const persisted = await readSettings(tempRoot);
      expect(persisted.id_prefix).toBe("next-");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("persists explicit skip state and supports idempotent explicit guidance add", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-init-agent-guidance-"),
    );
    try {
      const skipped = await runInit(
        "pm",
        { path: tempRoot },
        { defaults: true, agentGuidance: "skip" },
      );
      expect(skipped.agent_guidance).toMatchObject({
        mode: "skip",
        present: false,
        skipped: true,
        declined: true,
        prompt_completed: true,
      });
      expect(skipped.warnings).toContain("agent_guidance:explicit_skip");

      const added = await runInit(
        "pm",
        { path: tempRoot },
        { agentGuidance: "add" },
      );
      const guidancePath = path.join(tempRoot, "AGENTS.md");
      const firstGuidance = await readFile(guidancePath, "utf8");
      expect(added.agent_guidance).toMatchObject({
        mode: "add",
        present: true,
        applied: true,
        declined: false,
        prompt_completed: true,
      });
      expect(firstGuidance).toContain(
        "<!-- pm-cli:agent-guidance:start:v1 -->",
      );
      expect(firstGuidance).toContain("pm context --limit 10");
      expect(firstGuidance).toContain("PM_AUTHOR");

      const readded = await runInit(
        "pm",
        { path: tempRoot },
        { agentGuidance: "add" },
      );
      const secondGuidance = await readFile(guidancePath, "utf8");
      expect(readded.agent_guidance.applied).toBe(false);
      expect(secondGuidance).toBe(firstGuidance);

      const status = await runInit(
        "pm",
        { path: tempRoot },
        { agentGuidance: "status" },
      );
      expect(status.agent_guidance).toMatchObject({
        mode: "status",
        present: true,
      });
      expect(status.warnings).not.toContain("agent_guidance:missing");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("reports guidance status, prior decline skip, and existing CLAUDE guidance", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-init-agent-guidance-status-"),
    );
    try {
      const statusMissing = await runInit(
        "pm",
        { path: tempRoot },
        { defaults: true, agentGuidance: "status" },
      );
      expect(statusMissing.agent_guidance).toMatchObject({
        mode: "status",
        present: false,
      });
      expect(statusMissing.warnings).toContain("agent_guidance:missing");
      expect(statusMissing.next_steps).toContain(
        `Add workflow guidance later: pm --pm-path ${tempRoot} init --agent-guidance add`,
      );

      const skipped = await runInit(
        "pm",
        { path: tempRoot },
        { defaults: true, agentGuidance: "skip" },
      );
      const declinedAt = skipped.settings.agent_guidance.declined_at;
      expect(declinedAt).not.toBe("");

      const skippedAgain = await runInit(
        "pm",
        { path: tempRoot },
        { defaults: true },
      );
      expect(skippedAgain.agent_guidance).toMatchObject({
        mode: "ask",
        skipped: true,
        declined: true,
        prompt_completed: true,
      });
      expect(skippedAgain.settings.agent_guidance.declined_at).toBe(declinedAt);
      expect(skippedAgain.warnings).toContain(
        "agent_guidance:skipped_declined",
      );

      await writeFile(
        path.join(tempRoot, "CLAUDE.md"),
        [
          "pm init",
          "pm context",
          "pm search",
          "pm create",
          "pm claim",
          "pm files",
          "pm docs",
          "pm test --run",
          "pm close",
          "pm release",
          "pm_author",
          "",
        ].join("\n"),
        "utf8",
      );
      const detected = await runInit(
        "pm",
        { path: tempRoot },
        { defaults: true },
      );
      expect(detected.agent_guidance).toMatchObject({
        present: true,
        declined: false,
        prompt_completed: true,
      });
      expect(detected.agent_guidance.files_with_guidance).toEqual([
        "CLAUDE.md",
      ]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("appends guidance to existing AGENTS files and preserves CRLF endings", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-init-agent-guidance-replace-"),
    );
    try {
      const guidancePath = path.join(tempRoot, "AGENTS.md");
      await writeFile(
        guidancePath,
        ["# Existing", "Project notes", ""].join("\r\n"),
        "utf8",
      );
      const hooks: ExtensionHookRegistry = {
        beforeCommand: [],
        afterCommand: [],
        onWrite: [
          {
            layer: "project",
            name: "guidance-write-trace",
            run: () => "guidance hook warning",
          },
        ],
        onRead: [],
        onIndex: [],
      };
      setActiveExtensionHooks(hooks);

      const result = await runInit(
        "pm",
        { path: path.join(tempRoot, ".agents", "pm") },
        { defaults: true, agentGuidance: "add" },
      );
      const guidance = await readFile(guidancePath, "utf8");
      expect(result.agent_guidance).toMatchObject({
        present: true,
        applied: true,
      });
      expect(guidance).toContain("<!-- pm-cli:agent-guidance:start:v1 -->\r\n");
      expect(guidance).toContain(
        "Set `PM_AUTHOR=<stable-agent-id>` before mutation commands.",
      );
      expect(guidance).toContain("# Existing\r\n");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("validates init option values before writing tracker settings", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-init-invalid-options-"),
    );
    try {
      await expect(
        runInit(
          "pm",
          { path: path.join(tempRoot, "preset") },
          { preset: "   " },
        ),
      ).rejects.toMatchObject<PmCliError>({
        message: expect.stringContaining("--preset must not be empty"),
      });
      await expect(
        runInit(
          "pm",
          { path: path.join(tempRoot, "preset-bad") },
          { preset: "heavy" },
        ),
      ).rejects.toMatchObject<PmCliError>({
        message: expect.stringContaining("Invalid --preset value"),
      });
      await expect(
        runInit(
          "pm",
          { path: path.join(tempRoot, "type") },
          { typePreset: "   " },
        ),
      ).rejects.toMatchObject<PmCliError>({
        message: expect.stringContaining("--type-preset must not be empty"),
      });
      await expect(
        runInit(
          "pm",
          { path: path.join(tempRoot, "type-bad") },
          { typePreset: "sales" },
        ),
      ).rejects.toMatchObject<PmCliError>({
        message: expect.stringContaining("Invalid --type-preset value"),
      });
      await expect(
        runInit(
          "pm",
          { path: path.join(tempRoot, "author") },
          { author: "   " },
        ),
      ).rejects.toMatchObject<PmCliError>({
        message: expect.stringContaining("--author must not be empty"),
      });
      await expect(
        runInit(
          "pm",
          { path: path.join(tempRoot, "guidance") },
          { agentGuidance: "   " },
        ),
      ).rejects.toMatchObject<PmCliError>({
        message: expect.stringContaining("--agent-guidance must not be empty"),
      });
      await expect(
        runInit(
          "pm",
          { path: path.join(tempRoot, "guidance-bad") },
          { agentGuidance: "maybe" },
        ),
      ).rejects.toMatchObject<PmCliError>({
        message: expect.stringContaining("Invalid --agent-guidance value"),
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("applies governance presets through init options for new and existing trackers", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-init-governance-preset-"),
    );
    try {
      const strictInit = await runInit(
        "pm",
        { path: tempRoot },
        { preset: "strict" },
      );
      expect(strictInit.governance_preset).toBe("strict");
      expect(strictInit.wizard_used).toBe(false);
      expect(strictInit.settings.governance).toMatchObject({
        preset: "strict",
        ownership_enforcement: "strict",
        create_mode_default: "strict",
        close_validation_default: "strict",
      });

      await expect(
        runInit("pm", { path: tempRoot }, { preset: "minimal" }),
      ).rejects.toMatchObject<PmCliError>({
        context: expect.objectContaining({
          code: "init_existing_settings_requires_force",
          required: "--force for governance_preset",
        }),
      });

      const minimalInit = await runInit(
        "pm",
        { path: tempRoot },
        { preset: "minimal", force: true },
      );
      expect(minimalInit.governance_preset).toBe("minimal");
      expect(minimalInit.warnings).toContain(
        "updated:governance_preset:minimal",
      );
      expect(minimalInit.settings.governance).toMatchObject({
        preset: "minimal",
        ownership_enforcement: "none",
        create_mode_default: "progressive",
        close_validation_default: "off",
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("can install bundled first-party packages during initialization", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-init-with-packages-"),
    );
    try {
      const result = await runInit(
        "pm",
        { path: tempRoot },
        { defaults: true, author: "init-agent", withPackages: true },
      );

      expect(result.ok).toBe(true);
      expect(result.installed_packages).toMatchObject({
        installed_all: true,
      });
      expect(result.installed_packages?.installed_count).toBeGreaterThanOrEqual(
        8,
      );
      expect(
        result.installed_packages?.packages.map((entry) => entry.alias),
      ).toEqual(expect.arrayContaining(["calendar", "templates"]));

      const persisted = await readSettings(tempRoot);
      expect(persisted.author_default).toBe("init-agent");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails init --with-packages when bundled installs report unsuccessful entries", async () => {
    vi.resetModules();
    const runExtensionMock = vi.fn(async () => ({
      action: "extension",
      status: "ok",
      scope: "project",
      details: {
        installed_all: false,
        installed_count: 1,
        packages: [{ alias: "calendar", ok: false }],
      },
      warnings: [],
    }));
    vi.doMock("../../../src/cli/commands/extension.js", async () => {
      const actual = await vi.importActual<
        typeof import("../../../src/cli/commands/extension.js")
      >("../../../src/cli/commands/extension.js");
      return {
        ...actual,
        runExtension: runExtensionMock,
      };
    });

    try {
      const initModule = await import("../../../src/cli/commands/init.js");
      const tempRoot = await mkdtemp(
        path.join(os.tmpdir(), "pm-init-with-packages-fail-"),
      );
      try {
        await expect(
          initModule.runInit(
            "pm",
            { path: tempRoot },
            { defaults: true, withPackages: true, agentGuidance: "skip" },
          ),
        ).rejects.toMatchObject({
          exitCode: EXIT_CODE.GENERIC_FAILURE,
          message: expect.stringContaining(
            "pm init --with-packages did not install all bundled packages successfully: calendar",
          ),
        });
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }

      runExtensionMock.mockResolvedValue({
        action: "extension",
        status: "ok",
        scope: "project",
        details: { installed_all: false, installed_count: 0, packages: [] },
        warnings: [],
      });
      const emptyFailureRoot = await mkdtemp(
        path.join(os.tmpdir(), "pm-init-with-packages-empty-fail-"),
      );
      try {
        await expect(
          initModule.runInit(
            "pm",
            { path: emptyFailureRoot },
            { defaults: true, withPackages: true, agentGuidance: "skip" },
          ),
        ).rejects.toMatchObject({
          exitCode: EXIT_CODE.GENERIC_FAILURE,
          message: expect.stringMatching(/successfully\.$/),
        });
      } finally {
        await rm(emptyFailureRoot, { recursive: true, force: true });
      }
    } finally {
      vi.doUnmock("../../../src/cli/commands/extension.js");
      vi.resetModules();
    }
  });

  it("dispatches onWrite hooks for init directory ensure operations", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-init-hooks-"));
    try {
      const trace: string[] = [];
      const hooks: ExtensionHookRegistry = {
        beforeCommand: [],
        afterCommand: [],
        onWrite: [
          {
            layer: "project",
            name: "init-write-trace",
            run: (context) => {
              trace.push(`${context.op}:${context.path}`);
            },
          },
          {
            layer: "project",
            name: "init-write-boom",
            run: () => {
              throw new Error("boom");
            },
          },
        ],
        onRead: [],
        onIndex: [],
      };
      setActiveExtensionHooks(hooks);

      const result = await runInit("pm", { path: tempRoot });
      const expectedTargets = PM_REQUIRED_SUBDIRS.map((subdir) =>
        subdir ? path.join(tempRoot, subdir) : tempRoot,
      );
      const settingsPath = path.join(tempRoot, "settings.json");
      const expectedSchemaFiles = [
        path.join(tempRoot, "schema", "types.json"),
        path.join(tempRoot, "schema", "statuses.json"),
        path.join(tempRoot, "schema", "fields.json"),
        path.join(tempRoot, "schema", "workflows.json"),
      ];

      expect(trace).toEqual([
        ...expectedTargets.map((target) => `init:ensure_dir:${target}`),
        `settings:write:${settingsPath}`,
        ...expectedSchemaFiles.map(
          (target) => `init:runtime_schema_file:${target}`,
        ),
      ]);
      expect(result.warnings).toContain(`already_exists:${tempRoot}`);
      expect(
        result.warnings.filter(
          (warning) =>
            warning === "extension_hook_failed:project:init-write-boom:onWrite",
        ),
      ).toHaveLength(PM_REQUIRED_SUBDIRS.length + 4);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("covers the init wizard choices through a mocked readline prompt", async () => {
    const writes: string[] = [];
    const close = vi.fn();
    const question = vi
      .fn()
      .mockResolvedValueOnce(" Ticket ")
      .mockResolvedValueOnce("strict")
      .mockResolvedValueOnce("n");
    initInternals.setInitReadlineFactoryForTests(
      () =>
        ({
          question,
          close,
        }) as unknown as ReturnType<typeof readline.createInterface>,
    );
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });

    try {
      const choices = await initInternals.runInitWizard("pm-", true);

      expect(choices).toEqual({
        prefix: "ticket-",
        preset: "strict",
        telemetry_enabled: false,
      });
      expect(question).toHaveBeenCalledWith("Item ID prefix [pm-]: ");
      expect(question).toHaveBeenCalledWith(
        "Governance preset [minimal/default/strict] (default: minimal): ",
      );
      expect(question).toHaveBeenCalledWith(
        "Enable telemetry for this project? [Y/n] ",
      );
      expect(writes.join("")).toContain("pm init setup wizard");
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("defaults an unrecognized governance preset answer to minimal instead of aborting the wizard", async () => {
    const writes: string[] = [];
    const close = vi.fn();
    const question = vi
      .fn()
      .mockResolvedValueOnce("pm-")
      .mockResolvedValueOnce("totally-bogus-preset")
      .mockResolvedValueOnce("y");
    initInternals.setInitReadlineFactoryForTests(
      () =>
        ({
          question,
          close,
        }) as unknown as ReturnType<typeof readline.createInterface>,
    );
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });

    try {
      const choices = await initInternals.runInitWizard("pm-", true);
      expect(choices.preset).toBe("minimal");
      expect(writes.join("")).toContain(
        'Unrecognized governance preset "totally-bogus-preset"; using minimal.',
      );
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      writeSpy.mockRestore();
      initInternals.setInitReadlineFactoryForTests(undefined);
    }
  });

  it("falls back to wizard defaults on blank answers and restores readline fallback factory", async () => {
    const close = vi.fn();
    const question = vi
      .fn()
      .mockResolvedValueOnce("   ")
      .mockResolvedValueOnce("   ")
      .mockResolvedValueOnce("   ");
    initInternals.setInitReadlineFactoryForTests(
      () =>
        ({
          question,
          close,
        }) as unknown as ReturnType<typeof readline.createInterface>,
    );
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    try {
      const choices = await initInternals.runInitWizard("pm-", false);
      expect(choices).toEqual({
        prefix: "pm-",
        preset: "minimal",
        telemetry_enabled: false,
      });
      expect(question).toHaveBeenCalledWith(
        "Enable telemetry for this project? [y/N] ",
      );
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      writeSpy.mockRestore();
      initInternals.setInitReadlineFactoryForTests(undefined);
    }
  });

  it("uses the default readline factory when no test factory is configured", async () => {
    vi.resetModules();
    const close = vi.fn();
    const question = vi
      .fn()
      .mockResolvedValueOnce("pm-")
      .mockResolvedValueOnce("minimal")
      .mockResolvedValueOnce("y")
      .mockResolvedValueOnce("pm-")
      .mockResolvedValueOnce("minimal")
      .mockResolvedValueOnce("y");
    const createInterfaceMock = vi.fn(() => ({
      question,
      close,
    }));
    vi.doMock("node:readline/promises", () => ({
      default: {
        createInterface: createInterfaceMock,
      },
    }));
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    try {
      const mockedInitModule =
        await import("../../../src/cli/commands/init.js");
      const firstChoices = await mockedInitModule._testOnly.runInitWizard(
        "pm-",
        true,
      );
      expect(firstChoices).toEqual({
        prefix: "pm-",
        preset: "minimal",
        telemetry_enabled: true,
      });
      mockedInitModule._testOnly.setInitReadlineFactoryForTests(undefined);
      const secondChoices = await mockedInitModule._testOnly.runInitWizard(
        "pm-",
        true,
      );
      expect(secondChoices).toEqual({
        prefix: "pm-",
        preset: "minimal",
        telemetry_enabled: true,
      });
      expect(createInterfaceMock).toHaveBeenCalledTimes(2);
      expect(close).toHaveBeenCalledTimes(2);
    } finally {
      writeSpy.mockRestore();
      vi.doUnmock("node:readline/promises");
      vi.resetModules();
    }
  });

  it("uses default agent-guidance readline fallback and no-op write path", async () => {
    vi.resetModules();
    const close = vi.fn();
    const question = vi
      .fn()
      .mockResolvedValueOnce("no")
      .mockResolvedValueOnce("yes");
    const createInterfaceMock = vi.fn(() => ({
      question,
      close,
    }));
    vi.doMock("node:readline/promises", () => ({
      default: {
        createInterface: createInterfaceMock,
      },
    }));
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-init-guidance-default-factory-"),
    );

    try {
      const mockedGuidanceModule =
        await import("../../../src/cli/commands/init-agent-guidance.js");
      const declinedPrompt =
        await mockedGuidanceModule._testOnly.promptForGuidanceWrite(
          "AGENTS.md",
        );
      expect(declinedPrompt).toBe(false);
      mockedGuidanceModule._testOnly.setAgentGuidanceReadlineFactoryForTests(
        undefined,
      );
      const acceptedPrompt =
        await mockedGuidanceModule._testOnly.promptForGuidanceWrite(
          "AGENTS.md",
        );
      expect(acceptedPrompt).toBe(true);
      expect(createInterfaceMock).toHaveBeenCalledTimes(2);
      expect(close).toHaveBeenCalledTimes(2);

      const guidancePath = path.join(tempRoot, "AGENTS.md");
      const normalizedGuidance =
        mockedGuidanceModule._testOnly.upsertAgentGuidanceBlock(
          "# Existing header",
        ).next_content;
      await writeFile(guidancePath, normalizedGuidance, "utf8");
      const noChangeWrite =
        await mockedGuidanceModule._testOnly.writeGuidanceFile(guidancePath);
      expect(noChangeWrite).toEqual({ changed: false, warnings: [] });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
      writeSpy.mockRestore();
      vi.doUnmock("node:readline/promises");
      vi.resetModules();
    }
  });

  it("uses the init wizard when running interactively without defaults", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-init-interactive-wizard-"),
    );
    const close = vi.fn();
    const question = vi
      .fn()
      .mockResolvedValueOnce(" Ticket ")
      .mockResolvedValueOnce("strict")
      .mockResolvedValueOnce("n");
    initInternals.setInitReadlineFactoryForTests(
      () =>
        ({
          question,
          close,
        }) as unknown as ReturnType<typeof readline.createInterface>,
    );
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      const result = await runInit(
        "pm",
        { path: tempRoot },
        { agentGuidance: "skip" },
      );

      expect(result.wizard_used).toBe(true);
      expect(result.settings.id_prefix).toBe("ticket-");
      expect(result.governance_preset).toBe("strict");
      expect(result.settings.telemetry.enabled).toBe(false);
      expect(result.settings.telemetry.first_run_prompt_completed).toBe(true);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("prompts for missing agent guidance interactively and records accept/decline state", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-init-guidance-interactive-"),
    );
    try {
      await runInit(
        "pm",
        { path: tempRoot },
        { defaults: true, agentGuidance: "status" },
      );
      const acceptedSettings = await readSettings(tempRoot);
      const acceptClose = vi.fn();
      const acceptQuestion = vi.fn().mockResolvedValue("yes");
      initGuidanceInternals.setAgentGuidanceReadlineFactoryForTests(
        () =>
          ({
            question: acceptQuestion,
            close: acceptClose,
          }) as unknown as ReturnType<typeof readline.createInterface>,
      );
      const writeSpy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);

      const accepted = await runInitAgentGuidance({
        pm_root: tempRoot,
        cwd: path.dirname(tempRoot),
        mode: "ask",
        interactive: true,
        settings: acceptedSettings,
      });

      expect(accepted.summary).toMatchObject({
        prompted: true,
        applied: true,
        present: true,
        declined: false,
        prompt_completed: true,
      });
      expect(accepted.warnings).toContain("agent_guidance:added:AGENTS.md");
      expect(acceptQuestion).toHaveBeenCalledWith(
        "Add a compact pm workflow section to AGENTS.md? [Y/n] ",
      );
      expect(acceptClose).toHaveBeenCalledTimes(1);

      const declinedRoot = await mkdtemp(
        path.join(os.tmpdir(), "pm-init-guidance-decline-"),
      );
      await runInit(
        "pm",
        { path: declinedRoot },
        { defaults: true, agentGuidance: "status" },
      );
      const declinedSettings = await readSettings(declinedRoot);
      const declineQuestion = vi.fn().mockResolvedValue("no");
      initGuidanceInternals.setAgentGuidanceReadlineFactoryForTests(
        () =>
          ({
            question: declineQuestion,
            close: vi.fn(),
          }) as unknown as ReturnType<typeof readline.createInterface>,
      );

      const declined = await runInitAgentGuidance({
        pm_root: declinedRoot,
        cwd: path.dirname(declinedRoot),
        mode: "ask",
        interactive: true,
        settings: declinedSettings,
      });

      expect(declined.summary).toMatchObject({
        prompted: true,
        applied: false,
        skipped: true,
        declined: true,
        prompt_completed: true,
      });
      expect(declined.warnings).toContain("agent_guidance:declined");
      expect(declined.next_steps).toContain(
        "Add workflow guidance later: pm init --agent-guidance add",
      );
      await rm(declinedRoot, { recursive: true, force: true });
      writeSpy.mockRestore();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("deduplicates guidance next steps that already exist in init output", async () => {
    vi.resetModules();
    const runInitAgentGuidanceMock = vi.fn(async () => ({
      summary: {
        mode: "status" as const,
        present: false,
        prompted: false,
        applied: false,
        skipped: false,
        declined: false,
        prompt_completed: false,
        template_version: 1,
        target_file: "AGENTS.md",
        checked_files: ["AGENTS.md", "CLAUDE.md"],
        files_with_guidance: [],
        missing_files: ["AGENTS.md", "CLAUDE.md"],
      },
      warnings: [],
      next_steps: [
        "Set PM_AUTHOR=<your-agent-id> so mutations attribute to the right caller.",
      ],
      settings_changed: false,
    }));

    vi.doMock("../../../src/cli/commands/init-agent-guidance.js", async () => {
      const actual = await vi.importActual<
        typeof import("../../../src/cli/commands/init-agent-guidance.js")
      >("../../../src/cli/commands/init-agent-guidance.js");
      return {
        ...actual,
        runInitAgentGuidance: runInitAgentGuidanceMock,
      };
    });

    try {
      const initModule = await import("../../../src/cli/commands/init.js");
      const tempRoot = await mkdtemp(
        path.join(os.tmpdir(), "pm-init-next-step-dedupe-"),
      );
      try {
        const result = await initModule.runInit(
          "pm",
          { path: tempRoot },
          { defaults: true, agentGuidance: "status" },
        );
        expect(
          result.next_steps.filter(
            (step) =>
              step ===
              "Set PM_AUTHOR=<your-agent-id> so mutations attribute to the right caller.",
          ),
        ).toHaveLength(1);
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    } finally {
      vi.doUnmock("../../../src/cli/commands/init-agent-guidance.js");
      vi.resetModules();
    }
  });

  it("keeps agent guidance unchanged when add mode runs on an already-upserted file", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "pm-init-guidance-noop-"),
    );
    try {
      await runInit(
        "pm",
        { path: tempRoot },
        { defaults: true, agentGuidance: "status" },
      );
      const settings = await readSettings(tempRoot);

      const firstAdd = await runInitAgentGuidance({
        pm_root: tempRoot,
        cwd: path.dirname(tempRoot),
        mode: "add",
        interactive: false,
        settings,
      });
      expect(firstAdd.summary.applied).toBe(true);

      const secondAdd = await runInitAgentGuidance({
        pm_root: tempRoot,
        cwd: path.dirname(tempRoot),
        mode: "add",
        interactive: false,
        settings,
      });
      expect(secondAdd.summary.applied).toBe(false);
      expect(secondAdd.summary.present).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
