import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInit, summarizeInitResult } from "../../src/cli/commands/init.js";
import { PM_REQUIRED_SUBDIRS } from "../../src/core/shared/constants.js";
import { clearActiveExtensionHooks, setActiveExtensionHooks, type ExtensionHookRegistry } from "../../src/core/extensions/index.js";
import { readSettings } from "../../src/core/store/settings.js";

describe("runInit", () => {
  afterEach(() => {
    clearActiveExtensionHooks();
  });

  it("initializes a new tracker path with normalized prefix", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-init-create-"));
    try {
      const result = await runInit(" AcMe ", { path: tempRoot });
      expect(result.ok).toBe(true);
      expect(result.path).toBe(tempRoot);
      expect(result.settings.id_prefix).toBe("acme-");
      expect(result.created_dirs).toHaveLength(PM_REQUIRED_SUBDIRS.length - 1 + 4);
      expect(result.warnings).toContain(`already_exists:${tempRoot}`);
      expect(result.warnings).toContain("agent_guidance:missing_non_interactive");
      expect(result.agent_guidance).toMatchObject({
        mode: "ask",
        present: false,
        prompted: false,
        applied: false,
      });
      expect(result.next_steps).toContain("Add workflow guidance later: pm init --agent-guidance add");

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

  it("summarizes an init result into a concise projection without the full settings tree", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-init-summary-"));
    try {
      const result = await runInit("acme", { path: tempRoot }, { defaults: true });
      const summary = summarizeInitResult(result);

      // Drops the verbose settings tree but keeps the surfaced essentials.
      expect(summary).not.toHaveProperty("settings");
      expect(summary.ok).toBe(true);
      expect(summary.path).toBe(tempRoot);
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
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-init-summary-pkgs-"));
    try {
      const result = await runInit("pm", { path: tempRoot }, { defaults: true, withPackages: true });
      const summary = summarizeInitResult(result);
      expect(summary.installed_packages).toEqual(result.installed_packages);
      expect(summary.installed_packages?.installed_all).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("registers domain type presets into runtime schema during initialization", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-init-type-preset-"));
    try {
      const result = await runInit("pm", { path: tempRoot }, { defaults: true, typePreset: "agile" });
      expect(result.registered_type_preset).toMatchObject({
        name: "agile",
        registered: ["Story", "Spike"],
        updated: [],
      });
      expect(result.warnings).toContain("registered_type_preset:agile");
      expect(result.next_steps).toContain("Inspect registered preset types: pm schema list, pm schema show Story");
      expect((await stat(path.join(tempRoot, "stories"))).isDirectory()).toBe(true);
      expect((await stat(path.join(tempRoot, "spikes"))).isDirectory()).toBe(true);

      const summary = summarizeInitResult(result);
      expect(summary.registered_type_preset).toEqual(result.registered_type_preset);

      const types = JSON.parse(await readFile(path.join(tempRoot, "schema", "types.json"), "utf8")) as {
        definitions: Array<{ name: string; aliases?: string[]; folder?: string }>;
      };
      expect(types.definitions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "Spike", folder: "spikes", aliases: ["research-spike"] }),
          expect.objectContaining({ name: "Story", folder: "stories", aliases: ["user-story"] }),
        ]),
      );

      const rerun = await runInit("pm", { path: tempRoot }, { defaults: true, typePreset: "agile" });
      expect(rerun.registered_type_preset).toMatchObject({
        name: "agile",
        registered: [],
        updated: ["Story", "Spike"],
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("emits already-exists warnings and updates id prefix only when changed", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-init-reinit-"));
    try {
      const initial = await runInit("pm", { path: tempRoot });
      expect(initial.settings.id_prefix).toBe("pm-");

      const updated = await runInit("next", { path: tempRoot });
      const expectedSettingsPath = path.join(tempRoot, "settings.json");

      expect(updated.created_dirs).toEqual([]);
      expect(updated.settings.id_prefix).toBe("next-");
      expect(updated.warnings).toContain(`already_exists:${expectedSettingsPath}`);
      expect(updated.warnings).toContain("updated:id_prefix:next-");
      expect(updated.warnings.filter((warning) => warning.startsWith("already_exists:"))).toHaveLength(
        PM_REQUIRED_SUBDIRS.length + 1,
      );

      const unchanged = await runInit("next", { path: tempRoot });
      expect(unchanged.warnings).toContain(`already_exists:${expectedSettingsPath}`);
      expect(unchanged.warnings).not.toContain("updated:id_prefix:next-");

      const persisted = await readSettings(tempRoot);
      expect(persisted.id_prefix).toBe("next-");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("persists explicit skip state and supports idempotent explicit guidance add", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-init-agent-guidance-"));
    try {
      const skipped = await runInit("pm", { path: tempRoot }, { defaults: true, agentGuidance: "skip" });
      expect(skipped.agent_guidance).toMatchObject({
        mode: "skip",
        present: false,
        skipped: true,
        declined: true,
        prompt_completed: true,
      });
      expect(skipped.warnings).toContain("agent_guidance:explicit_skip");

      const added = await runInit("pm", { path: tempRoot }, { agentGuidance: "add" });
      const guidancePath = path.join(tempRoot, "AGENTS.md");
      const firstGuidance = await readFile(guidancePath, "utf8");
      expect(added.agent_guidance).toMatchObject({
        mode: "add",
        present: true,
        applied: true,
        declined: false,
        prompt_completed: true,
      });
      expect(firstGuidance).toContain("<!-- pm-cli:agent-guidance:start:v1 -->");
      expect(firstGuidance).toContain("pm context --limit 10");
      expect(firstGuidance).toContain("PM_AUTHOR");

      const readded = await runInit("pm", { path: tempRoot }, { agentGuidance: "add" });
      const secondGuidance = await readFile(guidancePath, "utf8");
      expect(readded.agent_guidance.applied).toBe(false);
      expect(secondGuidance).toBe(firstGuidance);

      const status = await runInit("pm", { path: tempRoot }, { agentGuidance: "status" });
      expect(status.agent_guidance).toMatchObject({
        mode: "status",
        present: true,
      });
      expect(status.warnings).not.toContain("agent_guidance:missing");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("applies governance presets through init options for new and existing trackers", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-init-governance-preset-"));
    try {
      const strictInit = await runInit("pm", { path: tempRoot }, { preset: "strict" });
      expect(strictInit.governance_preset).toBe("strict");
      expect(strictInit.wizard_used).toBe(false);
      expect(strictInit.settings.governance).toMatchObject({
        preset: "strict",
        ownership_enforcement: "strict",
        create_mode_default: "strict",
        close_validation_default: "strict",
      });

      const minimalInit = await runInit("pm", { path: tempRoot }, { preset: "minimal" });
      expect(minimalInit.governance_preset).toBe("minimal");
      expect(minimalInit.warnings).toContain("updated:governance_preset:minimal");
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
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pm-init-with-packages-"));
    try {
      const result = await runInit("pm", { path: tempRoot }, { defaults: true, author: "init-agent", withPackages: true });

      expect(result.ok).toBe(true);
      expect(result.installed_packages).toMatchObject({
        installed_all: true,
      });
      expect(result.installed_packages?.installed_count).toBeGreaterThanOrEqual(8);
      expect(result.installed_packages?.packages.map((entry) => entry.alias)).toEqual(
        expect.arrayContaining(["calendar", "templates"]),
      );

      const persisted = await readSettings(tempRoot);
      expect(persisted.author_default).toBe("init-agent");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
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
      const expectedTargets = PM_REQUIRED_SUBDIRS.map((subdir) => (subdir ? path.join(tempRoot, subdir) : tempRoot));
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
        ...expectedSchemaFiles.map((target) => `init:runtime_schema_file:${target}`),
      ]);
      expect(result.warnings).toContain(`already_exists:${tempRoot}`);
      expect(
        result.warnings.filter((warning) => warning === "extension_hook_failed:project:init-write-boom:onWrite"),
      ).toHaveLength(PM_REQUIRED_SUBDIRS.length + 4);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
