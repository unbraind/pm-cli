import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInit } from "../../src/cli/commands/init.js";
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
      expect(result.warnings).toEqual([`already_exists:${tempRoot}`]);

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
