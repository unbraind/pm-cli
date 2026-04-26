import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runConfig } from "../../src/cli/commands/config.js";
import { EXIT_CODE, SETTINGS_DEFAULTS } from "../../src/core/shared/constants.js";
import { PmCliError } from "../../src/core/shared/errors.js";
import { canonicalDocument, serializeItemDocument } from "../../src/core/item/item-format.js";
import { getItemPath, getSettingsPath } from "../../src/core/store/paths.js";
import { readSettings, writeSettings } from "../../src/core/store/settings.js";
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

      expect(result).toMatchObject({
        scope: "project",
        key: "definition_of_done",
        criteria: ["tests pass"],
        settings_path: getSettingsPath(pmRoot),
        changed: false,
      });
      expect(result.warnings).toBeDefined();
      expect(result.warnings).toHaveLength(4);
      expect((result.warnings ?? []).every((warning) => warning.startsWith("runtime_schema_bootstrap_created:"))).toBe(true);
    });
  });

  it("lists config keys with metadata and current values", async () => {
    await withTempRoot(async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      const settings = structuredClone(SETTINGS_DEFAULTS);
      settings.workflow.definition_of_done = ["tests pass"];
      settings.testing.record_results_to_items = true;
      await writeSettings(pmRoot, settings);

      const result = await runConfig("project", "list", undefined, {}, { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot });
      expect(result.changed).toBe(false);
      expect(result.count).toBe(16);
      expect(result.keys?.map((entry) => entry.key)).toEqual([
        "definition_of_done",
        "item_format",
        "history_missing_stream_policy",
        "sprint_release_format_policy",
        "parent_reference_policy",
        "metadata_validation_profile",
        "metadata_required_fields",
        "governance_preset",
        "governance_ownership_enforcement",
        "governance_create_mode_default",
        "governance_close_validation_default",
        "governance_parent_reference_policy",
        "governance_metadata_validation_profile",
        "governance_force_required_for_stale_lock",
        "test_result_tracking",
        "telemetry_tracking",
      ]);
      expect(result.keys?.find((entry) => entry.key === "definition_of_done")?.value).toEqual(["tests pass"]);
      expect(result.keys?.find((entry) => entry.key === "definition_of_done")?.set_flags).toEqual([
        "--criterion",
        "--clear-criteria",
      ]);
      expect(result.keys?.find((entry) => entry.key === "test_result_tracking")?.value).toBe("enabled");
      expect(result.keys?.find((entry) => entry.key === "telemetry_tracking")?.value).toBe("enabled");
    });
  });

  it("exports resolved config snapshot values", async () => {
    await withTempRoot(async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      const settings = structuredClone(SETTINGS_DEFAULTS);
      settings.workflow.definition_of_done = ["tests pass"];
      settings.governance = {
        preset: "custom",
        ownership_enforcement: "strict",
        create_mode_default: "strict",
        close_validation_default: "strict",
        parent_reference: "strict_error",
        metadata_profile: "strict",
        force_required_for_stale_lock: true,
      };
      await writeSettings(pmRoot, settings);

      const result = await runConfig("project", "export", undefined, {}, { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot });
      expect(result.changed).toBe(false);
      expect(result.values).toEqual({
        definition_of_done: ["tests pass"],
        item_format: "toon",
        history_missing_stream_policy: "auto_create",
        sprint_release_format_policy: "warn",
        parent_reference_policy: "strict_error",
        metadata_validation_profile: "strict",
        metadata_required_fields: [],
        governance_preset: "custom",
        governance_ownership_enforcement: "strict",
        governance_create_mode_default: "strict",
        governance_close_validation_default: "strict",
        governance_parent_reference_policy: "strict_error",
        governance_metadata_validation_profile: "strict",
        governance_force_required_for_stale_lock: "enabled",
        test_result_tracking: "disabled",
        telemetry_tracking: "enabled",
      });
    });
  });

  it("gets and sets governance preset and knob policies", async () => {
    await withTempRoot(async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

      const getDefaultPreset = await runConfig(
        "project",
        "get",
        "governance-preset",
        {},
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
      );
      expect(getDefaultPreset.key).toBe("governance_preset");
      expect(getDefaultPreset.policy).toBe("minimal");
      expect(getDefaultPreset.changed).toBe(false);

      const setStrictPreset = await runConfig(
        "project",
        "set",
        "governance_preset",
        { policy: "strict" },
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
      );
      expect(setStrictPreset.key).toBe("governance_preset");
      expect(setStrictPreset.policy).toBe("strict");
      expect(setStrictPreset.changed).toBe(true);

      const getStrictParent = await runConfig(
        "project",
        "get",
        "parent-reference-policy",
        {},
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
      );
      expect(getStrictParent.key).toBe("parent_reference_policy");
      expect(getStrictParent.policy).toBe("strict_error");

      const setOwnershipNone = await runConfig(
        "project",
        "set",
        "governance-ownership-enforcement",
        { policy: "none" },
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
      );
      expect(setOwnershipNone.key).toBe("governance_ownership_enforcement");
      expect(setOwnershipNone.policy).toBe("none");
      expect(setOwnershipNone.changed).toBe(true);

      const getCustomPreset = await runConfig(
        "project",
        "get",
        "governance_preset",
        {},
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
      );
      expect(getCustomPreset.policy).toBe("custom");
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

  it("supports clearing definition-of-done criteria with --clear-criteria", async () => {
    await withTempRoot(async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      const settings = structuredClone(SETTINGS_DEFAULTS);
      settings.workflow.definition_of_done = ["linked files/tests/docs present", "tests pass"];
      await writeSettings(pmRoot, settings);

      const cleared = await runConfig(
        "project",
        "set",
        "definition-of-done",
        { clearCriteria: true },
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
      );
      expect(cleared.criteria).toEqual([]);
      expect(cleared.changed).toBe(true);

      const reread = await runConfig("project", "get", "definition_of_done", {}, { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot });
      expect(reread.criteria).toEqual([]);

      await expect(
        runConfig(
          "project",
          "set",
          "definition-of-done",
          { clearCriteria: true, criterion: ["tests pass"] },
          { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
        ),
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
      await expect(runConfig("project", "get", undefined, {}, { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot })).rejects.toMatchObject({
        exitCode: EXIT_CODE.USAGE,
      });
      await expect(runConfig("project", "set", undefined, {}, { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot })).rejects.toMatchObject({
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

      const setStrictAlias = await runConfig(
        "project",
        "set",
        "sprint_release_format_policy",
        { policy: "strict" },
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
      );
      expect(setStrictAlias.policy).toBe("strict_error");
      expect(setStrictAlias.changed).toBe(true);

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

  it("gets and sets parent-reference policy", async () => {
    await withTempRoot(async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

      const getDefault = await runConfig(
        "project",
        "get",
        "parent-reference-policy",
        {},
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
      );
      expect(getDefault.key).toBe("parent_reference_policy");
      expect(getDefault.policy).toBe("warn");
      expect(getDefault.changed).toBe(false);

      const setStrictAlias = await runConfig(
        "project",
        "set",
        "parent_reference_policy",
        { policy: "strict" },
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
      );
      expect(setStrictAlias.policy).toBe("strict_error");
      expect(setStrictAlias.changed).toBe(true);

      const setStrictAgain = await runConfig(
        "project",
        "set",
        "parent-reference-policy",
        { policy: "strict_error" },
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
      );
      expect(setStrictAgain.policy).toBe("strict_error");
      expect(setStrictAgain.changed).toBe(false);
    });
  });

  it("requires --policy when setting parent-reference policy and validates values", async () => {
    await withTempRoot(async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

      await expect(
        runConfig(
          "project",
          "set",
          "parent-reference-policy",
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
          "parent_reference_policy",
          { policy: "auto_create" },
          { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("gets and sets metadata-validation profile policy", async () => {
    await withTempRoot(async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

      const getDefault = await runConfig(
        "project",
        "get",
        "metadata-validation-profile",
        {},
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
      );
      expect(getDefault.key).toBe("metadata_validation_profile");
      expect(getDefault.policy).toBe("core");
      expect(getDefault.changed).toBe(false);

      const setStrict = await runConfig(
        "project",
        "set",
        "metadata_validation_profile",
        { policy: "strict" },
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
      );
      expect(setStrict.policy).toBe("strict");
      expect(setStrict.changed).toBe(true);

      const setStrictAgain = await runConfig(
        "project",
        "set",
        "metadata-validation-profile",
        { policy: "strict" },
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
      );
      expect(setStrictAgain.policy).toBe("strict");
      expect(setStrictAgain.changed).toBe(false);
    });
  });

  it("requires supported --policy values when setting metadata-validation profile", async () => {
    await withTempRoot(async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

      await expect(
        runConfig(
          "project",
          "set",
          "metadata-validation-profile",
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
          "metadata_validation_profile",
          { policy: "warn" },
          { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("gets and sets metadata-required fields list", async () => {
    await withTempRoot(async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

      const getDefault = await runConfig(
        "project",
        "get",
        "metadata-required-fields",
        {},
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
      );
      expect(getDefault.key).toBe("metadata_required_fields");
      expect(getDefault.criteria).toEqual([]);
      expect(getDefault.changed).toBe(false);

      const setFields = await runConfig(
        "project",
        "set",
        "metadata_required_fields",
        { criterion: ["release", "sprint", "release"] },
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
      );
      expect(setFields.criteria).toEqual(["release", "sprint"]);
      expect(setFields.changed).toBe(true);

      const clearFields = await runConfig(
        "project",
        "set",
        "metadata-required-fields",
        { clearCriteria: true },
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
      );
      expect(clearFields.criteria).toEqual([]);
      expect(clearFields.changed).toBe(true);
    });
  });

  it("validates metadata-required fields criteria values", async () => {
    await withTempRoot(async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

      await expect(
        runConfig(
          "project",
          "set",
          "metadata-required-fields",
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
          "metadata_required_fields",
          { clearCriteria: true, criterion: ["sprint"] },
          { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });

      await expect(
        runConfig(
          "project",
          "set",
          "metadata_required_fields",
          { criterion: ["none"] },
          { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });

      await expect(
        runConfig(
          "project",
          "set",
          "metadata-required-fields",
          { criterion: ["unknown_field"] },
          { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("gets and sets telemetry tracking policy", async () => {
    await withTempRoot(async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

      const getDefault = await runConfig(
        "project",
        "get",
        "telemetry-tracking",
        {},
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
      );
      expect(getDefault.key).toBe("telemetry_tracking");
      expect(getDefault.policy).toBe("enabled");
      expect(getDefault.changed).toBe(false);

      const setDisabled = await runConfig(
        "project",
        "set",
        "telemetry_tracking",
        { policy: "disabled" },
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
      );
      expect(setDisabled.key).toBe("telemetry_tracking");
      expect(setDisabled.policy).toBe("disabled");
      expect(setDisabled.changed).toBe(true);
      const persistedAfterSet = await readSettings(pmRoot);
      expect(persistedAfterSet.telemetry.first_run_prompt_completed).toBe(true);

      const setDisabledAgain = await runConfig(
        "project",
        "set",
        "telemetry-tracking",
        { policy: "disabled" },
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
      );
      expect(setDisabledAgain.policy).toBe("disabled");
      expect(setDisabledAgain.changed).toBe(false);

      await expect(
        runConfig(
          "project",
          "set",
          "telemetry-tracking",
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
