import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runConfig } from "../../src/cli/commands/config.js";
import { EXIT_CODE, SETTINGS_DEFAULTS } from "../../src/core/shared/constants.js";
import { PmCliError } from "../../src/core/shared/errors.js";
import { getSettingsPath } from "../../src/core/store/paths.js";
import { writeSettings } from "../../src/core/store/settings.js";
import type { GlobalOptions } from "../../src/core/shared/command-types.js";

const DEFAULT_GLOBAL_OPTIONS: GlobalOptions = {
  json: false,
  quiet: false,
  profile: false,
};

async function withTempRoot(run: (tempRoot: string) => Promise<void>): Promise<void> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pm-cli-config-command-test-"));
  try {
    await run(tempRoot);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

describe("runConfig", () => {
  const originalGlobalPath = process.env.PM_GLOBAL_PATH;

  afterEach(() => {
    if (originalGlobalPath === undefined) {
      delete process.env.PM_GLOBAL_PATH;
    } else {
      process.env.PM_GLOBAL_PATH = originalGlobalPath;
    }
  });

  it("returns project definition-of-done criteria from initialized settings", async () => {
    await withTempRoot(async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      const settings = structuredClone(SETTINGS_DEFAULTS);
      settings.workflow.definition_of_done = ["tests pass"];
      await writeSettings(pmRoot, settings);

      const result = await runConfig("project", "get", "definition-of-done", {}, { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot });

      expect(result).toEqual({
        scope: "project",
        key: "definition_of_done",
        criteria: ["tests pass"],
        settings_path: getSettingsPath(pmRoot),
        changed: false,
      });
    });
  });

  it("persists sorted deduplicated project definition-of-done criteria", async () => {
    await withTempRoot(async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

      const result = await runConfig(
        "project",
        "set",
        "definition_of_done",
        {
          criterion: ["tests pass", "linked files/tests/docs present", "tests pass"],
        },
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
      );

      expect(result.criteria).toEqual(["linked files/tests/docs present", "tests pass"]);
      expect(result.changed).toBe(true);

      const reread = await runConfig("project", "get", "definition-of-done", {}, { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot });
      expect(reread.criteria).toEqual(["linked files/tests/docs present", "tests pass"]);
    });
  });

  it("reports unchanged false when set criteria already match stored order", async () => {
    await withTempRoot(async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      const settings = structuredClone(SETTINGS_DEFAULTS);
      settings.workflow.definition_of_done = ["linked files/tests/docs present", "tests pass"];
      await writeSettings(pmRoot, settings);

      const result = await runConfig(
        "project",
        "set",
        "definition-of-done",
        {
          criterion: ["tests pass", "linked files/tests/docs present"],
        },
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
      );

      expect(result.changed).toBe(false);
      expect(result.criteria).toEqual(["linked files/tests/docs present", "tests pass"]);
    });
  });

  it("writes global definition-of-done criteria using PM_GLOBAL_PATH", async () => {
    await withTempRoot(async (tempRoot) => {
      process.env.PM_GLOBAL_PATH = path.join(tempRoot, ".pm-cli-global");

      const result = await runConfig(
        "global",
        "set",
        "definition-of-done",
        {
          criterion: ["review completed"],
        },
        DEFAULT_GLOBAL_OPTIONS,
      );

      expect(result.scope).toBe("global");
      expect(result.criteria).toEqual(["review completed"]);
      const stored = JSON.parse(await fs.readFile(result.settings_path, "utf8")) as {
        workflow: { definition_of_done: string[] };
      };
      expect(stored.workflow.definition_of_done).toEqual(["review completed"]);
    });
  });

  it("rejects empty set criteria", async () => {
    await withTempRoot(async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

      await expect(
        runConfig("project", "set", "definition-of-done", { criterion: ["", "   "] }, { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runConfig("project", "set", "definition-of-done", {}, { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("requires initialized project settings", async () => {
    await withTempRoot(async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");

      await expect(
        runConfig("project", "get", "definition-of-done", {}, { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    });
  });

  it("validates scope action and key values", async () => {
    await withTempRoot(async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

      await expect(
        runConfig("workspace", "get", "definition-of-done", {}, { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot }),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runConfig("project", "list", "definition-of-done", {}, { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot }),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runConfig("project", "get", "other-key", {}, { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot }),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });
});
