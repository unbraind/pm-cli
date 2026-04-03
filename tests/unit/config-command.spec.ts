import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runConfig } from "../../src/cli/commands/config.js";
import { EXIT_CODE, SETTINGS_DEFAULTS } from "../../src/core/shared/constants.js";
import { PmCliError } from "../../src/core/shared/errors.js";
import { canonicalDocument, serializeItemDocument } from "../../src/core/item/item-format.js";
import { getItemPath, getSettingsPath } from "../../src/core/store/paths.js";
import { writeSettings } from "../../src/core/store/settings.js";
import type { ItemDocument } from "../../src/types/index.js";
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

  it("sets and gets project item-format and migrates item files to the configured format", async () => {
    await withTempRoot(async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      const settings = structuredClone(SETTINGS_DEFAULTS);
      settings.item_format = "json_markdown";
      await writeSettings(pmRoot, settings);

      const document: ItemDocument = canonicalDocument({
        front_matter: {
          id: "pm-config-format",
          title: "Config migration",
          description: "Migrate file format",
          type: "Task",
          status: "open",
          priority: 1,
          tags: ["config"],
          created_at: "2026-03-31T00:00:00.000Z",
          updated_at: "2026-03-31T00:00:00.000Z",
        },
        body: "seed body",
      });
      const markdownPath = getItemPath(pmRoot, "Task", "pm-config-format", "json_markdown");
      await fs.mkdir(path.dirname(markdownPath), { recursive: true });
      await fs.writeFile(markdownPath, serializeItemDocument(document, { format: "json_markdown" }), "utf8");

      const result = await runConfig(
        "project",
        "set",
        "item-format",
        {
          format: "toon",
        },
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
      );

      expect(result.key).toBe("item_format");
      expect(result.format).toBe("toon");
      expect(result.changed).toBe(true);
      expect(result.has_explicit_item_format).toBe(true);
      expect(result.migration?.target_format).toBe("toon");
      expect(result.migration?.migrated).toContain("pm-config-format");

      const toonPath = getItemPath(pmRoot, "Task", "pm-config-format", "toon");
      await expect(fs.access(toonPath)).resolves.toBeUndefined();
      await expect(fs.access(markdownPath)).rejects.toBeDefined();

      const getResult = await runConfig("project", "get", "item_format", {}, { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot });
      expect(getResult.format).toBe("toon");
      expect(getResult.changed).toBe(false);
    });
  });

  it("requires --format when setting item-format and validates allowed values", async () => {
    await withTempRoot(async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

      await expect(runConfig("project", "set", "item-format", {}, { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot })).rejects.toMatchObject<
        PmCliError
      >({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(
        runConfig("project", "set", "item-format", { format: "markdown" }, { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("gets and sets history missing-stream policy", async () => {
    await withTempRoot(async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

      const getDefault = await runConfig(
        "project",
        "get",
        "history-missing-stream-policy",
        {},
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
      );
      expect(getDefault.key).toBe("history_missing_stream_policy");
      expect(getDefault.policy).toBe("auto_create");
      expect(getDefault.changed).toBe(false);

      const setStrict = await runConfig(
        "project",
        "set",
        "history_missing_stream_policy",
        { policy: "strict-error" },
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
      );
      expect(setStrict.policy).toBe("strict_error");
      expect(setStrict.changed).toBe(true);

      const setStrictAgain = await runConfig(
        "project",
        "set",
        "history-missing-stream-policy",
        { policy: "strict_error" },
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
      );
      expect(setStrictAgain.policy).toBe("strict_error");
      expect(setStrictAgain.changed).toBe(false);
    });
  });

  it("requires --policy when setting history missing-stream policy and validates values", async () => {
    await withTempRoot(async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

      await expect(
        runConfig(
          "project",
          "set",
          "history-missing-stream-policy",
          {},
          { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });

      await expect(
        runConfig(
          "project",
          "set",
          "history_missing_stream_policy",
          { policy: "warn" },
          { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("gets and sets sprint-release format policy", async () => {
    await withTempRoot(async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

      const getDefault = await runConfig(
        "project",
        "get",
        "sprint-release-format-policy",
        {},
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
      );
      expect(getDefault.key).toBe("sprint_release_format_policy");
      expect(getDefault.policy).toBe("warn");
      expect(getDefault.changed).toBe(false);

      const setStrict = await runConfig(
        "project",
        "set",
        "sprint_release_format_policy",
        { policy: "strict-error" },
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
      );
      expect(setStrict.policy).toBe("strict_error");
      expect(setStrict.changed).toBe(true);

      const setStrictAgain = await runConfig(
        "project",
        "set",
        "sprint-release-format-policy",
        { policy: "strict_error" },
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
      );
      expect(setStrictAgain.policy).toBe("strict_error");
      expect(setStrictAgain.changed).toBe(false);
    });
  });

  it("requires --policy when setting sprint-release format policy and validates values", async () => {
    await withTempRoot(async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

      await expect(
        runConfig(
          "project",
          "set",
          "sprint-release-format-policy",
          {},
          { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });

      await expect(
        runConfig(
          "project",
          "set",
          "sprint_release_format_policy",
          { policy: "auto_create" },
          { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("treats legacy settings without item_format as changed when explicitly setting default format", async () => {
    await withTempRoot(async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      const legacySettings = { ...structuredClone(SETTINGS_DEFAULTS) } as Record<string, unknown>;
      delete legacySettings.item_format;
      await fs.mkdir(pmRoot, { recursive: true });
      await fs.writeFile(path.join(pmRoot, "settings.json"), `${JSON.stringify(legacySettings, null, 2)}\n`, "utf8");

      const result = await runConfig(
        "project",
        "set",
        "item-format",
        { format: "toon" },
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
      );
      expect(result.changed).toBe(true);
      expect(result.format).toBe("toon");
      expect(result.has_explicit_item_format).toBe(true);
    });
  });
});
