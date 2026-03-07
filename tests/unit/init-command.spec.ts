import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInit } from "../../src/cli/commands/init.js";
import { PM_REQUIRED_SUBDIRS } from "../../src/constants.js";
import { clearActiveExtensionHooks, setActiveExtensionHooks, type ExtensionHookRegistry } from "../../src/core/extensions/index.js";
import { readSettings } from "../../src/settings.js";

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
      expect(result.created_dirs).toHaveLength(PM_REQUIRED_SUBDIRS.length - 1);
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

      expect(trace).toEqual([
        ...expectedTargets.map((target) => `init:ensure_dir:${target}`),
        `settings:write:${settingsPath}`,
      ]);
      expect(result.warnings).toContain(`already_exists:${tempRoot}`);
      expect(
        result.warnings.filter((warning) => warning === "extension_hook_failed:project:init-write-boom:onWrite"),
      ).toHaveLength(PM_REQUIRED_SUBDIRS.length);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
