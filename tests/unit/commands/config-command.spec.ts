import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { _testOnlyConfigCommand, runConfig } from "../../../src/cli/commands/config.js";
import { DEFAULT_STATUS_DEFINITIONS, EXIT_CODE, SETTINGS_DEFAULTS } from "../../../src/core/shared/constants.js";
import { PmCliError } from "../../../src/core/shared/errors.js";
import { canonicalDocument, serializeItemDocument } from "../../../src/core/item/item-format.js";
import { getItemPath, getSettingsPath } from "../../../src/core/store/paths.js";
import { readSettings, writeSettings } from "../../../src/core/store/settings.js";
import type { ItemDocument } from "../../../src/types/index.js";
import type { GlobalOptions } from "../../../src/core/shared/command-types.js";
import { withTempRoot } from "../../helpers/temp.js";

const DEFAULT_GLOBAL_OPTIONS: GlobalOptions = {
  json: false,
  quiet: false,
  profile: false,
};

describe("config command helper coverage", () => {
  it("normalizes policy values and rejects unsupported variants", () => {
    expect(_testOnlyConfigCommand.normalizeAction("get")).toBe("get");
    expect(() => _testOnlyConfigCommand.normalizeAction("delete")).toThrow(
      expect.objectContaining({ exitCode: EXIT_CODE.USAGE }),
    );
    expect(_testOnlyConfigCommand.normalizeScope("global")).toBe("global");
    expect(_testOnlyConfigCommand.normalizeScope("project")).toBe("project");
    expect(() => _testOnlyConfigCommand.normalizeScope("workspace")).toThrow(
      expect.objectContaining({ exitCode: EXIT_CODE.USAGE }),
    );

    expect(_testOnlyConfigCommand.normalizeKey("governance-close-validation-default")).toBe(
      "governance_close_validation_default",
    );
    expect(_testOnlyConfigCommand.normalizeItemFormat("TOON")).toBe("toon");
    expect(() => _testOnlyConfigCommand.normalizeItemFormat("json_markdown")).toThrow(
      expect.objectContaining({ exitCode: EXIT_CODE.USAGE }),
    );
    expect(() => _testOnlyConfigCommand.normalizeItemFormat(undefined)).toThrow(
      expect.objectContaining({ exitCode: EXIT_CODE.USAGE }),
    );

    expect(_testOnlyConfigCommand.normalizeHistoryMissingStreamPolicy("strict-error")).toBe("strict_error");
    expect(_testOnlyConfigCommand.normalizeTestResultTrackingPolicy("ENABLED")).toBe("enabled");
    expect(_testOnlyConfigCommand.normalizeTelemetryTrackingPolicy("disabled")).toBe("disabled");
    expect(_testOnlyConfigCommand.normalizeValidateMetadataProfile("custom")).toBe("custom");
    expect(_testOnlyConfigCommand.normalizeGovernancePreset("minimal")).toBe("minimal");
    expect(_testOnlyConfigCommand.normalizeGovernanceOwnershipEnforcement("WARN")).toBe("warn");
    expect(_testOnlyConfigCommand.normalizeGovernanceCreateModeDefault("progressive")).toBe("progressive");
    expect(_testOnlyConfigCommand.normalizeGovernanceCloseValidationDefault("strict")).toBe("strict");
    expect(_testOnlyConfigCommand.normalizeGovernanceWorkflowEnforcement("disabled")).toBe("off");
    expect(_testOnlyConfigCommand.normalizeGovernanceForceRequiredForStaleLockPolicy("enabled")).toBe("enabled");
    expect(_testOnlyConfigCommand.normalizeGovernanceRequireCloseReasonPolicy("disabled")).toBe("disabled");

    expect(_testOnlyConfigCommand.normalizeKey("lifecycle-closure-like-resolution-patterns")).toBe(
      "lifecycle_closure_like_resolution_patterns",
    );
    expect(_testOnlyConfigCommand.normalizeKey("governance-create-default-type")).toBe("governance_create_default_type");
    expect(_testOnlyConfigCommand.normalizeGovernanceCloseValidationDefault("none")).toBe("off");
    expect(_testOnlyConfigCommand.normalizeGovernanceWorkflowEnforcement("none")).toBe("off");
    expect(() => _testOnlyConfigCommand.normalizeHistoryMissingStreamPolicy("repair")).toThrow(
      expect.objectContaining({ exitCode: EXIT_CODE.USAGE }),
    );
    expect(() => _testOnlyConfigCommand.normalizeGovernancePreset("full")).toThrow(
      expect.objectContaining({ exitCode: EXIT_CODE.USAGE }),
    );
    expect(() => _testOnlyConfigCommand.normalizeGovernanceRequireCloseReasonPolicy("maybe")).toThrow(
      expect.objectContaining({ exitCode: EXIT_CODE.USAGE }),
    );
    expect(_testOnlyConfigCommand.normalizePolicyForConflict("history_missing_stream_policy", "strict-error")).toBe("strict_error");
    expect(_testOnlyConfigCommand.normalizePolicyForConflict("parent_reference_policy", "strict-error")).toBe("strict_error");
    expect(_testOnlyConfigCommand.normalizePolicyForConflict("governance_preset", "default")).toBe("default");
    expect(_testOnlyConfigCommand.normalizePolicyForConflict("governance_workflow_enforcement", "warn")).toBe("warn");
    expect(_testOnlyConfigCommand.normalizePolicyForConflict("governance_ownership_enforcement", "strict")).toBe("strict");
    expect(_testOnlyConfigCommand.normalizePolicyForConflict("governance_create_mode_default", "strict")).toBe("strict");
    expect(_testOnlyConfigCommand.normalizePolicyForConflict("governance_close_validation_default", "disabled")).toBe("off");
    expect(_testOnlyConfigCommand.normalizePolicyForConflict("governance_require_close_reason", "enabled")).toBe("enabled");
    expect(_testOnlyConfigCommand.normalizePolicyForConflict("governance_force_required_for_stale_lock", "disabled")).toBe("disabled");
    expect(_testOnlyConfigCommand.normalizePolicyForConflict("test_result_tracking", "enabled")).toBe("enabled");
    expect(_testOnlyConfigCommand.normalizePolicyForConflict("telemetry_tracking", "DISABLED")).toBe("disabled");
    expect(_testOnlyConfigCommand.normalizePolicyForConflict(undefined, "Mixed-Value")).toBe("mixed_value");
  });

  it("rejects unsupported enum policy values across every governance normalizer", () => {
    const invalid = expect.objectContaining({ exitCode: EXIT_CODE.USAGE });
    expect(() => _testOnlyConfigCommand.normalizeTestResultTrackingPolicy("maybe")).toThrow(invalid);
    expect(() => _testOnlyConfigCommand.normalizeTelemetryTrackingPolicy("maybe")).toThrow(invalid);
    expect(() => _testOnlyConfigCommand.normalizeGovernanceOwnershipEnforcement("loose")).toThrow(invalid);
    expect(() => _testOnlyConfigCommand.normalizeGovernanceCreateModeDefault("relaxed")).toThrow(invalid);
    expect(() => _testOnlyConfigCommand.normalizeGovernanceCloseValidationDefault("loud")).toThrow(invalid);
    expect(() => _testOnlyConfigCommand.normalizeGovernanceForceRequiredForStaleLockPolicy("maybe")).toThrow(invalid);
    expect(() => _testOnlyConfigCommand.normalizeValidateMetadataProfile("loose")).toThrow(invalid);
    expect(() => _testOnlyConfigCommand.normalizeGovernanceWorkflowEnforcement("loud")).toThrow(invalid);
    // Non-string input to the workflow-enforcement normalizer takes the typeof guard's
    // undefined branch before failing validation.
    expect(() => _testOnlyConfigCommand.normalizeGovernanceWorkflowEnforcement(42)).toThrow(invalid);
  });

  it("routes sprint-release and metadata-profile keys through normalizePolicyForConflict", () => {
    expect(
      _testOnlyConfigCommand.normalizePolicyForConflict("sprint_release_format_policy", "strict"),
    ).toBe("strict_error");
    expect(
      _testOnlyConfigCommand.normalizePolicyForConflict("metadata_validation_profile", "custom"),
    ).toBe("custom");
    expect(
      _testOnlyConfigCommand.normalizePolicyForConflict("governance_metadata_validation_profile", "strict"),
    ).toBe("strict");
  });

  it("normalizes criteria and metadata field lists", () => {
    expect(_testOnlyConfigCommand.normalizeCriteria([" b ", "a", "a", ""], false)).toEqual(["a", "b"]);
    expect(_testOnlyConfigCommand.normalizeCriteria(undefined, true)).toEqual([]);
    expect(() => _testOnlyConfigCommand.normalizeCriteria(["a"], true)).toThrow(
      expect.objectContaining({ exitCode: EXIT_CODE.USAGE }),
    );
    expect(() => _testOnlyConfigCommand.normalizeCriteria([""], false)).toThrow(
      expect.objectContaining({ exitCode: EXIT_CODE.USAGE }),
    );

    expect(_testOnlyConfigCommand.normalizeWarnings([" b ", "a", "a", ""])).toEqual(["", " b ", "a"]);
    expect(_testOnlyConfigCommand.normalizeMetadataRequiredFields(["acceptance-criteria", "close_reason", "acceptance_criteria"], false)).toEqual([
      "acceptance_criteria",
      "close_reason",
    ]);
    expect(_testOnlyConfigCommand.normalizeMetadataRequiredFields(undefined, true)).toEqual([]);
    expect(() => _testOnlyConfigCommand.normalizeMetadataRequiredFields(["unknown"], false)).toThrow(
      expect.objectContaining({ exitCode: EXIT_CODE.USAGE }),
    );
    expect(() => _testOnlyConfigCommand.normalizeMetadataRequiredFields(["close_reason"], true)).toThrow(
      expect.objectContaining({ exitCode: EXIT_CODE.USAGE }),
    );
  });

  it("covers positional routing defensive guards and conflict errors", () => {
    const usageError = expect.objectContaining({ exitCode: EXIT_CODE.USAGE });

    expect(() =>
      _testOnlyConfigCommand.applyPositionalValue("set", undefined, undefined, undefined, "off", {}),
    ).toThrow(usageError);

    expect(() =>
      _testOnlyConfigCommand.applyPositionalValue("set", "item-format", undefined, undefined, "toon", {}),
    ).toThrow(usageError);

    expect(() =>
      _testOnlyConfigCommand.applyPositionalValue(
        "set",
        "item-format",
        "item_format",
        undefined,
        "toon",
        { format: "json_markdown" },
      ),
    ).toThrow(usageError);
  });

  it("preserves a pre-existing --value for nested settings when no positional value is given", () => {
    // nestedSetting=true with only --value (no positional): the --value must be kept,
    // not overwritten with undefined (regression guard for config.ts value coalescing).
    expect(
      _testOnlyConfigCommand.applyPositionalValue("set", "search.provider", undefined, true, undefined, {
        value: "qdrant",
      }),
    ).toEqual({ value: "qdrant" });

    // A positional value still wins when provided alongside no --value.
    expect(
      _testOnlyConfigCommand.applyPositionalValue("set", "search.provider", undefined, true, "ollama", {}),
    ).toEqual({ value: "ollama" });
  });
});

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
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
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
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      const settings = structuredClone(SETTINGS_DEFAULTS);
      settings.workflow.definition_of_done = ["tests pass"];
      settings.testing.record_results_to_items = true;
      await writeSettings(pmRoot, settings);

      const result = await runConfig("project", "list", undefined, {}, { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot });
      expect(result.changed).toBe(false);
      expect(result.count).toBe(24);
      expect(result.keys?.map((entry) => entry.key)).toEqual([
        "definition_of_done",
        "item_format",
        "history_missing_stream_policy",
        "sprint_release_format_policy",
        "parent_reference_policy",
        "metadata_validation_profile",
        "metadata_required_fields",
        "lifecycle_stale_blocker_reason_patterns",
        "lifecycle_closure_like_blocked_reason_patterns",
        "lifecycle_closure_like_resolution_patterns",
        "lifecycle_closure_like_actual_result_patterns",
        "governance_preset",
        "governance_ownership_enforcement",
        "governance_create_mode_default",
        "governance_close_validation_default",
        "governance_require_close_reason",
        "governance_create_default_type",
        "governance_workflow_enforcement",
        "governance_parent_reference_policy",
        "governance_metadata_validation_profile",
        "governance_force_required_for_stale_lock",
        "test_result_tracking",
        "telemetry_tracking",
        "context",
      ]);
      expect(result.keys?.find((entry) => entry.key === "definition_of_done")?.value).toEqual(["tests pass"]);
      expect(result.keys?.find((entry) => entry.key === "definition_of_done")?.set_flags).toEqual([
        "--criterion",
        "--clear-criteria",
      ]);
      expect(result.keys?.find((entry) => entry.key === "lifecycle_stale_blocker_reason_patterns")?.set_flags).toEqual([
        "--criterion",
        "--clear-criteria",
      ]);
      expect(result.keys?.find((entry) => entry.key === "test_result_tracking")?.value).toBe("enabled");
      expect(result.keys?.find((entry) => entry.key === "telemetry_tracking")?.value).toBe("enabled");
    });
  });

  it("exports resolved config snapshot values", async () => {
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
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
        lifecycle_stale_blocker_reason_patterns: [
          "no active blocker",
          "ready for planned execution sequencing",
          "work completed",
          "work is closed",
        ],
        lifecycle_closure_like_blocked_reason_patterns: ["no active blocker because work is closed", "work is closed"],
        lifecycle_closure_like_resolution_patterns: [
          "closed with implementation evidence",
          "closed with verification evidence",
          "work completed and recorded",
          "work is closed",
        ],
        lifecycle_closure_like_actual_result_patterns: ["closed and recorded", "work completed", "work completed and recorded"],
        governance_preset: "custom",
        governance_ownership_enforcement: "strict",
        governance_create_mode_default: "strict",
        governance_close_validation_default: "strict",
        governance_create_default_type: "",
        governance_require_close_reason: "enabled",
        governance_workflow_enforcement: "off",
        governance_parent_reference_policy: "strict_error",
        governance_metadata_validation_profile: "strict",
        governance_force_required_for_stale_lock: "enabled",
        test_result_tracking: "disabled",
        telemetry_tracking: "enabled",
        context: {
          default_depth: "brief",
          activity_limit: 10,
          stale_threshold_days: 7,
          sections: {
            hierarchy: true,
            activity: true,
            progress: true,
            blockers: true,
            files: true,
            workload: true,
            staleness: true,
            tests: true,
            recently_created: true,
            unparented: true,
          },
        },
      });
    });
  });

  it("gets and sets governance preset and knob policies", async () => {
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
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

  it("gets and sets remaining policy config keys through command paths", async () => {
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));
      const globalOptions = { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot };

      const cases: Array<{ key: string; policy: string; expected?: string }> = [
        { key: "history-missing-stream-policy", policy: "strict-error", expected: "strict_error" },
        { key: "sprint-release-format-policy", policy: "strict-error", expected: "strict_error" },
        { key: "metadata-validation-profile", policy: "strict" },
        { key: "governance-create-mode-default", policy: "strict" },
        { key: "governance-close-validation-default", policy: "warn" },
        { key: "governance-require-close-reason", policy: "disabled" },
        { key: "governance-parent-reference-policy", policy: "strict" , expected: "strict_error" },
        { key: "governance-metadata-validation-profile", policy: "custom" },
        { key: "governance-force-required-for-stale-lock", policy: "enabled" },
        { key: "test-result-tracking", policy: "enabled" },
        { key: "telemetry-tracking", policy: "disabled" },
      ];

      for (const entry of cases) {
        const setResult = await runConfig("project", "set", entry.key, { policy: entry.policy }, globalOptions);
        expect(typeof setResult.changed).toBe("boolean");
        expect(setResult.policy).toBe(entry.expected ?? entry.policy);
        const getResult = await runConfig("project", "get", entry.key, {}, globalOptions);
        expect(getResult.policy).toBe(entry.expected ?? entry.policy);
      }
    });
  });

  it("round-trips governance-create-default-type and survives a non-custom preset write (pm-jpwo)", async () => {
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));
      const globalOptions = { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot };

      // Put the project on a non-custom preset first to exercise the persist trap.
      await runConfig("project", "set", "governance_preset", { policy: "default" }, globalOptions);

      const setResult = await runConfig("project", "set", "governance-create-default-type", { policy: "Issue" }, globalOptions);
      expect(setResult.key).toBe("governance_create_default_type");
      expect(setResult.policy).toBe("Issue");
      expect(setResult.changed).toBe(true);

      // The field must survive the write even though the preset is "default".
      const reloaded = await readSettings(pmRoot);
      expect(reloaded.governance.preset).toBe("default");
      expect(reloaded.governance.create_default_type).toBe("Issue");

      const getResult = await runConfig("project", "get", "governance_create_default_type", {}, globalOptions);
      expect(getResult.policy).toBe("Issue");

      // An explicit empty value clears the setting back to unset (exposed as "").
      const clearResult = await runConfig(
        "project",
        "set",
        "governance-create-default-type",
        { policy: "" },
        globalOptions,
      );
      expect(clearResult.policy).toBe("");
      expect(clearResult.changed).toBe(true);
      const afterClear = await readSettings(pmRoot);
      expect(afterClear.governance.create_default_type).toBeUndefined();
      const getAfterClear = await runConfig("project", "get", "governance_create_default_type", {}, globalOptions);
      expect(getAfterClear.policy).toBe("");

      // Clearing an already-unset value is an idempotent no-op (changed: false).
      const clearAgain = await runConfig(
        "project",
        "set",
        "governance-create-default-type",
        { policy: "" },
        globalOptions,
      );
      expect(clearAgain.changed).toBe(false);
    });
  });

  it("exposes lifecycle resolution patterns and rejects clear criteria for enum keys", async () => {
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));
      const globalOptions = { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot };

      const getDefault = await runConfig(
        "project",
        "get",
        "lifecycle-closure-like-resolution-patterns",
        {},
        globalOptions,
      );
      expect(getDefault.key).toBe("lifecycle_closure_like_resolution_patterns");
      expect(getDefault.criteria).toContain("work is closed");

      const setResult = await runConfig(
        "project",
        "set",
        "lifecycle_closure_like_resolution_patterns",
        { criterion: ["done", "verified", "done"] },
        globalOptions,
      );
      expect(setResult.criteria).toEqual(["done", "verified"]);
      expect(setResult.changed).toBe(true);

      const clearResult = await runConfig(
        "project",
        "set",
        "lifecycle-closure-like-resolution-patterns",
        { clearCriteria: true },
        globalOptions,
      );
      expect(clearResult.criteria).toEqual([]);
      expect(clearResult.changed).toBe(true);

      await expect(
        runConfig("project", "set", "telemetry-tracking", { clearCriteria: true }, globalOptions),
      ).rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE });
    });
  });

  it("rejects an unknown governance-create-default-type with a hint (pm-jpwo)", async () => {
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));
      const globalOptions = { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot };

      await expect(
        runConfig("project", "set", "governance-create-default-type", { policy: "Nonsense" }, globalOptions),
      ).rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE });
      await expect(
        runConfig("project", "set", "governance-create-default-type", {}, globalOptions),
      ).rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE });
    });
  });

  it("round-trips governance-workflow-enforcement and rejects invalid modes (pm-f4r1)", async () => {
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));
      const globalOptions = { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot };

      const getDefault = await runConfig("project", "get", "governance-workflow-enforcement", {}, globalOptions);
      expect(getDefault.policy).toBe("off");

      const setStrict = await runConfig("project", "set", "governance-workflow-enforcement", { policy: "strict" }, globalOptions);
      expect(setStrict.key).toBe("governance_workflow_enforcement");
      expect(setStrict.policy).toBe("strict");
      expect(setStrict.changed).toBe(true);

      const reloaded = await readSettings(pmRoot);
      expect(reloaded.governance.workflow_enforcement).toBe("strict");

      const getResult = await runConfig("project", "get", "governance_workflow_enforcement", {}, globalOptions);
      expect(getResult.policy).toBe("strict");

      await expect(
        runConfig("project", "set", "governance-workflow-enforcement", { policy: "bogus" }, globalOptions),
      ).rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE });
    });
  });

  it("persists sorted deduplicated project definition-of-done criteria", async () => {
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
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
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
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
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
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
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
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
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
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
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");

      await expect(
        runConfig("project", "get", "definition-of-done", {}, { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.NOT_FOUND,
      });
    });
  });

  it("validates scope action and key values", async () => {
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
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
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));
      const legacySettingsPath = path.join(pmRoot, "settings.json");
      const legacySettings = JSON.parse(await fs.readFile(legacySettingsPath, "utf8")) as Record<string, unknown>;
      delete legacySettings.item_format;
      await fs.writeFile(legacySettingsPath, `${JSON.stringify(legacySettings, null, 2)}\n`, "utf8");

      const document: ItemDocument = canonicalDocument({
        metadata: {
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
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
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
      await expect(
        runConfig("project", "set", "item-format", { format: "json_markdown" }, { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot }),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("gets and sets history missing-stream policy", async () => {
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
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
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
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
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
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
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
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
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
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
      expect(getDefault.policy).toBe("strict_error");
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
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
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
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
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
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
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
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
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
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
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

  it("gets and sets lifecycle pattern criteria lists", async () => {
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

      const getDefault = await runConfig(
        "project",
        "get",
        "lifecycle-stale-blocker-reason-patterns",
        {},
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
      );
      expect(getDefault.key).toBe("lifecycle_stale_blocker_reason_patterns");
      expect(getDefault.criteria).toEqual([
        "no active blocker",
        "ready for planned execution sequencing",
        "work completed",
        "work is closed",
      ]);
      expect(getDefault.changed).toBe(false);

      const setStalePatterns = await runConfig(
        "project",
        "set",
        "lifecycle_stale_blocker_reason_patterns",
        { criterion: ["Need Review", " need review ", "awaiting qa"] },
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
      );
      expect(setStalePatterns.criteria).toEqual(["awaiting qa", "need review"]);
      expect(setStalePatterns.changed).toBe(true);

      const setResolutionPatterns = await runConfig(
        "project",
        "set",
        "lifecycle-closure-like-resolution-patterns",
        { criterion: ["handoff complete", "handoff complete", "close candidate"] },
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
      );
      expect(setResolutionPatterns.criteria).toEqual(["close candidate", "handoff complete"]);
      expect(setResolutionPatterns.changed).toBe(true);

      const clearResolutionPatterns = await runConfig(
        "project",
        "set",
        "lifecycle-closure-like-resolution-patterns",
        { clearCriteria: true },
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
      );
      expect(clearResolutionPatterns.criteria).toEqual([]);
      expect(clearResolutionPatterns.changed).toBe(true);
    });
  });

  it("validates lifecycle pattern criteria operations", async () => {
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

      await expect(
        runConfig(
          "project",
          "set",
          "lifecycle-stale-blocker-reason-patterns",
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
          "lifecycle_closure_like_actual_result_patterns",
          { clearCriteria: true, criterion: ["done"] },
          { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
        ),
      ).rejects.toMatchObject<PmCliError>({
        exitCode: EXIT_CODE.USAGE,
      });
    });
  });

  it("gets and sets telemetry tracking policy", async () => {
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
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
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
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

  it("does not persist merged file-backed schema sections during unrelated config writes", async () => {
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      const settingsPath = path.join(pmRoot, "settings.json");
      const legacySettings = { ...structuredClone(SETTINGS_DEFAULTS) } as Record<string, unknown>;
      delete legacySettings.schema;
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, `${JSON.stringify(legacySettings, null, 2)}\n`, "utf8");

      const schemaDir = path.join(pmRoot, "schema");
      await fs.mkdir(schemaDir, { recursive: true });
      await fs.writeFile(
        path.join(schemaDir, "statuses.json"),
        `${JSON.stringify(
          {
            statuses: [...structuredClone(DEFAULT_STATUS_DEFINITIONS), { id: "qa_ready", roles: ["active"] }],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const setResult = await runConfig(
        "project",
        "set",
        "telemetry-tracking",
        { policy: "disabled" },
        { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
      );
      expect(setResult.changed).toBe(true);

      const persisted = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>;
      const persistedSchema = (persisted.schema ?? {}) as Record<string, unknown>;
      expect(persistedSchema.statuses ?? []).toEqual([]);
      expect(persistedSchema.fields ?? []).toEqual([]);
      expect(Array.isArray(persistedSchema.type_workflows) ? persistedSchema.type_workflows : []).toEqual([]);

      await fs.writeFile(
        path.join(schemaDir, "statuses.json"),
        `${JSON.stringify({ statuses: structuredClone(DEFAULT_STATUS_DEFINITIONS) }, null, 2)}\n`,
        "utf8",
      );
      const afterRemoval = await readSettings(pmRoot);
      expect(afterRemoval.schema.statuses.map((definition) => definition.id)).not.toContain("qa_ready");
    });
  });

  it("gets and sets context settings and section toggles", async () => {
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));
      const globalOptions = { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot };

      const getDefault = await runConfig("project", "get", "context", {}, globalOptions);
      expect(getDefault.key).toBe("context");
      expect(getDefault.context_settings).toMatchObject({
        default_depth: "brief",
        activity_limit: 10,
        stale_threshold_days: 7,
      });

      const setDeep = await runConfig(
        "project",
        "set",
        "context",
        {
          defaultDepth: "deep",
          activityLimit: "25",
          staleThresholdDays: "14",
          sectionHierarchy: "off",
          sectionActivity: "0",
          sectionProgress: "disabled",
          sectionBlockers: "false",
          sectionFiles: "on",
          sectionWorkload: "1",
          sectionStaleness: "enabled",
          sectionTests: "true",
        },
        globalOptions,
      );
      expect(setDeep.changed).toBe(true);
      expect(setDeep.context_settings).toMatchObject({
        default_depth: "deep",
        activity_limit: 25,
        stale_threshold_days: 14,
        sections: {
          hierarchy: false,
          activity: false,
          progress: false,
          blockers: false,
          files: true,
          workload: true,
          staleness: true,
          tests: true,
        },
      });

      const setSame = await runConfig(
        "project",
        "set",
        "context",
        {
          defaultDepth: "deep",
          activityLimit: "25",
          staleThresholdDays: "14",
          sectionHierarchy: "false",
        },
        globalOptions,
      );
      expect(setSame.changed).toBe(false);

      await expect(
        runConfig("project", "set", "context", { defaultDepth: "verbose" }, globalOptions),
      ).rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE });
      await expect(
        runConfig("project", "set", "context", { activityLimit: "0" }, globalOptions),
      ).rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE });
      await expect(
        runConfig("project", "set", "context", { staleThresholdDays: "NaN" }, globalOptions),
      ).rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE });
      await expect(
        runConfig("project", "set", "context", { sectionTests: "maybe" }, globalOptions),
      ).rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE });
    });
  });

  it("gets and sets nested config leaves including positional and validation paths", async () => {
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));
      const globalOptions = { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot };

      const getDefault = await runConfig("project", "get", "search-provider", {}, globalOptions);
      expect(getDefault.nested_setting).toMatchObject({
        key: "search_provider",
        path: "search.provider",
        kind: "string",
      });

      const setProvider = await runConfig("project", "set", "search-provider", {}, globalOptions, "local-provider");
      expect(setProvider.changed).toBe(true);
      expect(setProvider.nested_setting?.value).toBe("local-provider");

      const setProviderAgain = await runConfig(
        "project",
        "set",
        "search_provider",
        { value: "local-provider" },
        globalOptions,
      );
      expect(setProviderAgain.changed).toBe(false);

      const setTopK = await runConfig(
        "project",
        "set",
        "search-rerank-top-k",
        { value: "8" },
        globalOptions,
      );
      expect(setTopK.nested_setting).toMatchObject({
        key: "search_rerank_top_k",
        value: 8,
      });

      await expect(
        runConfig("project", "set", "search-provider", {}, globalOptions),
      ).rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE });
      await expect(
        runConfig("project", "set", "search-provider", { value: "explicit" }, globalOptions, "positional"),
      ).rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE });
      await expect(
        runConfig("project", "set", "search-rerank-top-k", { value: "0" }, globalOptions),
      ).rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE });
    });
  });

  it("gets governance ownership, require-close-reason, force-lock and test-tracking when enabled", async () => {
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      const settings = structuredClone(SETTINGS_DEFAULTS);
      settings.governance.preset = "custom";
      settings.governance.ownership_enforcement = "warn";
      settings.governance.require_close_reason = true;
      settings.governance.force_required_for_stale_lock = true;
      settings.testing.record_results_to_items = true;
      settings.telemetry.enabled = true;
      await writeSettings(pmRoot, settings);
      const globalOptions = { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot };

      const ownership = await runConfig("project", "get", "governance-ownership-enforcement", {}, globalOptions);
      expect(ownership.key).toBe("governance_ownership_enforcement");
      expect(ownership.policy).toBe("warn");

      const requireReason = await runConfig("project", "get", "governance-require-close-reason", {}, globalOptions);
      expect(requireReason.policy).toBe("enabled");

      const forceLock = await runConfig("project", "get", "governance-force-required-for-stale-lock", {}, globalOptions);
      expect(forceLock.policy).toBe("enabled");

      const testTracking = await runConfig("project", "get", "test-result-tracking", {}, globalOptions);
      expect(testTracking.policy).toBe("enabled");
    });
  });

  it("gets boolean-style governance knobs in their disabled state", async () => {
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));
      const globalOptions = { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot };

      // Defaults leave force-lock and test-tracking disabled — exercises the
      // false side of each get ternary.
      const forceLock = await runConfig("project", "get", "governance-force-required-for-stale-lock", {}, globalOptions);
      expect(forceLock.policy).toBe("disabled");
      const testTracking = await runConfig("project", "get", "test-result-tracking", {}, globalOptions);
      expect(testTracking.policy).toBe("disabled");
    });
  });

  it("sets boolean-style governance knobs to both enabled and disabled states", async () => {
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));
      const globalOptions = { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot };

      // require-close-reason enabled exercises the set-return true ternary branch.
      const requireOn = await runConfig("project", "set", "governance-require-close-reason", { policy: "enabled" }, globalOptions);
      expect(requireOn.policy).toBe("enabled");

      // force-lock disabled exercises the set-return false ternary branch (preset already custom now).
      const forceOff = await runConfig("project", "set", "governance-force-required-for-stale-lock", { policy: "disabled" }, globalOptions);
      expect(forceOff.policy).toBe("disabled");

      // test-result-tracking disabled exercises its set-return false ternary branch.
      const testOff = await runConfig("project", "set", "test-result-tracking", { policy: "disabled" }, globalOptions);
      expect(testOff.policy).toBe("disabled");
    });
  });

  it("exports boolean-style governance/telemetry knobs in their disabled state", async () => {
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      const settings = structuredClone(SETTINGS_DEFAULTS);
      settings.governance.require_close_reason = false;
      settings.telemetry.enabled = false;
      await writeSettings(pmRoot, settings);
      const globalOptions = { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot };

      const result = await runConfig("project", "export", undefined, {}, globalOptions);
      expect(result.values?.governance_require_close_reason).toBe("disabled");
      expect(result.values?.telemetry_tracking).toBe("disabled");
    });
  });

  it("sets governance ownership to a new value while already on a custom preset", async () => {
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      const settings = structuredClone(SETTINGS_DEFAULTS);
      settings.governance.preset = "custom";
      settings.governance.ownership_enforcement = "none";
      await writeSettings(pmRoot, settings);
      const globalOptions = { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot };

      // preset is already custom, so only the ownership_enforcement differ drives changed:true.
      const result = await runConfig("project", "set", "governance-ownership-enforcement", { policy: "warn" }, globalOptions);
      expect(result.policy).toBe("warn");
      expect(result.changed).toBe(true);
    });
  });

  it("reports unchanged for repeated governance updates after alignment", async () => {
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));
      const globalOptions = { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot };

      const presetCurrent = await runConfig("project", "get", "governance-preset", {}, globalOptions);
      const presetRepeat = await runConfig(
        "project",
        "set",
        "governance-preset",
        { policy: String(presetCurrent.policy) },
        globalOptions,
      );
      expect(presetRepeat.changed).toBe(false);

      const ownershipSeed = await runConfig(
        "project",
        "set",
        "governance-ownership-enforcement",
        { policy: "warn" },
        globalOptions,
      );
      const ownershipRepeat = await runConfig(
        "project",
        "set",
        "governance-ownership-enforcement",
        { policy: String(ownershipSeed.policy) },
        globalOptions,
      );
      expect(ownershipRepeat.changed).toBe(false);

      const createModeSeed = await runConfig(
        "project",
        "set",
        "governance-create-mode-default",
        { policy: "strict" },
        globalOptions,
      );
      const createModeRepeat = await runConfig(
        "project",
        "set",
        "governance-create-mode-default",
        { policy: String(createModeSeed.policy) },
        globalOptions,
      );
      expect(createModeRepeat.changed).toBe(false);

      const createTypeSeed = await runConfig(
        "project",
        "set",
        "governance-create-default-type",
        { policy: "Task" },
        globalOptions,
      );
      const createTypeRepeat = await runConfig(
        "project",
        "set",
        "governance-create-default-type",
        { policy: String(createTypeSeed.policy) },
        globalOptions,
      );
      expect(createTypeRepeat.changed).toBe(false);

      const metadataSeed = await runConfig(
        "project",
        "set",
        "governance-metadata-validation-profile",
        { policy: "custom" },
        globalOptions,
      );
      const metadataRepeat = await runConfig(
        "project",
        "set",
        "governance-metadata-validation-profile",
        { policy: String(metadataSeed.policy) },
        globalOptions,
      );
      expect(metadataRepeat.changed).toBe(false);

      const forceSeed = await runConfig(
        "project",
        "set",
        "governance-force-required-for-stale-lock",
        { policy: "enabled" },
        globalOptions,
      );
      const forceRepeat = await runConfig(
        "project",
        "set",
        "governance-force-required-for-stale-lock",
        { policy: String(forceSeed.policy) },
        globalOptions,
      );
      expect(forceRepeat.changed).toBe(false);
    });
  });

  it("reports changed when metadata-required-fields differ in value at the same length", async () => {
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      const settings = structuredClone(SETTINGS_DEFAULTS);
      settings.validation.metadata_required_fields = ["author"];
      await writeSettings(pmRoot, settings);
      const globalOptions = { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot };

      // Same length (1) but a different field value exercises the per-index some() callback.
      const result = await runConfig(
        "project",
        "set",
        "metadata-required-fields",
        { criterion: ["reviewer"] },
        globalOptions,
      );
      expect(result.criteria).toEqual(["reviewer"]);
      expect(result.changed).toBe(true);
    });
  });

  it("accepts a nested-leaf positional value that matches an explicit --value", async () => {
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));
      const globalOptions = { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot };

      const result = await runConfig("project", "set", "search-provider", { value: "dup" }, globalOptions, "dup");
      expect(result.nested_setting?.value).toBe("dup");
      expect(result.changed).toBe(true);

      await expect(
        runConfig("project", "set", "search-provider", { value: "a" }, globalOptions, "b"),
      ).rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE });
    });
  });

  it("gets and sets remaining policy and lifecycle list branches", async () => {
    await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
      const pmRoot = path.join(tempRoot, ".agents", "pm");
      await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));
      const globalOptions = { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot };

      const getBlocked = await runConfig(
        "project",
        "get",
        "lifecycle-closure-like-blocked-reason-patterns",
        {},
        globalOptions,
      );
      expect(getBlocked.criteria).toEqual(["no active blocker because work is closed", "work is closed"]);

      const setBlocked = await runConfig(
        "project",
        "set",
        "lifecycle-closure-like-blocked-reason-patterns",
        { criterion: [" Closed ", "blocked"] },
        globalOptions,
      );
      expect(setBlocked.criteria).toEqual(["blocked", "closed"]);

      const getResolution = await runConfig(
        "project",
        "get",
        "lifecycle-closure-like-resolution-patterns",
        {},
        globalOptions,
      );
      expect(getResolution.criteria).toEqual([
        "closed with implementation evidence",
        "closed with verification evidence",
        "work completed and recorded",
        "work is closed",
      ]);

      const setResolution = await runConfig(
        "project",
        "set",
        "lifecycle-closure-like-resolution-patterns",
        { criterion: [" Done ", "resolved"] },
        globalOptions,
      );
      expect(setResolution.criteria).toEqual(["done", "resolved"]);

      const getActual = await runConfig(
        "project",
        "get",
        "lifecycle-closure-like-actual-result-patterns",
        {},
        globalOptions,
      );
      expect(getActual.criteria).toEqual(["closed and recorded", "work completed", "work completed and recorded"]);

      const setActual = await runConfig(
        "project",
        "set",
        "lifecycle-closure-like-actual-result-patterns",
        { criterion: ["shipped"] },
        globalOptions,
      );
      expect(setActual.criteria).toEqual(["shipped"]);

      const setCreateMode = await runConfig(
        "project",
        "set",
        "governance-create-mode-default",
        { policy: "strict" },
        globalOptions,
      );
      expect(setCreateMode.policy).toBe("strict");

      const setCloseValidation = await runConfig(
        "project",
        "set",
        "governance-close-validation-default",
        { policy: "disabled" },
        globalOptions,
      );
      expect(setCloseValidation.policy).toBe("off");

      const setRequireReason = await runConfig(
        "project",
        "set",
        "governance-require-close-reason",
        { policy: "disabled" },
        globalOptions,
      );
      expect(setRequireReason.policy).toBe("disabled");

      const setParentPolicy = await runConfig(
        "project",
        "set",
        "governance-parent-reference-policy",
        { policy: "warn" },
        globalOptions,
      );
      expect(setParentPolicy.policy).toBe("warn");

      const setMetadataPolicy = await runConfig(
        "project",
        "set",
        "governance-metadata-validation-profile",
        { policy: "custom" },
        globalOptions,
      );
      expect(setMetadataPolicy.policy).toBe("custom");

      const setForceLock = await runConfig(
        "project",
        "set",
        "governance-force-required-for-stale-lock",
        { policy: "enabled" },
        globalOptions,
      );
      expect(setForceLock.policy).toBe("enabled");

      const setTestTracking = await runConfig(
        "project",
        "set",
        "test-result-tracking",
        { policy: "enabled" },
        globalOptions,
      );
      expect(setTestTracking.policy).toBe("enabled");
    });
  });

  describe("positional value routing for config set", () => {
    it("routes a positional value to --policy with enabled/disabled synonyms", async () => {
      await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
        const pmRoot = path.join(tempRoot, ".agents", "pm");
        await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

        const off = await runConfig(
          "project",
          "set",
          "telemetry-tracking",
          {},
          { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
          "off",
        );
        expect(off.policy).toBe("disabled");
        expect((await readSettings(pmRoot)).telemetry.enabled).toBe(false);

        const on = await runConfig(
          "project",
          "set",
          "telemetry-tracking",
          {},
          { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
          "enabled",
        );
        expect(on.policy).toBe("enabled");
        expect((await readSettings(pmRoot)).telemetry.enabled).toBe(true);
      });
    });

    it("routes a positional value to --format for item-format", async () => {
      await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
        const pmRoot = path.join(tempRoot, ".agents", "pm");
        await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

        const result = await runConfig(
          "project",
          "set",
          "item-format",
          {},
          { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
          "toon",
        );
        expect(result.format).toBe("toon");
      });
    });

    it("routes a positional value to --criterion for criteria-list keys", async () => {
      await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
        const pmRoot = path.join(tempRoot, ".agents", "pm");
        await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

        const result = await runConfig(
          "project",
          "set",
          "definition-of-done",
          {},
          { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
          "Tests pass",
        );
        expect(result.criteria).toEqual(["Tests pass"]);
      });
    });

    it("does not override an explicit typed flag when it matches", async () => {
      await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
        const pmRoot = path.join(tempRoot, ".agents", "pm");
        await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

        const result = await runConfig(
          "project",
          "set",
          "telemetry-tracking",
          { policy: "disabled" },
          { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
          "off",
        );
        expect(result.policy).toBe("disabled");
      });
    });

    it("accepts equivalent explicit typed flags after normalization", async () => {
      await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
        const pmRoot = path.join(tempRoot, ".agents", "pm");
        await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

        const format = await runConfig(
          "project",
          "set",
          "item-format",
          { format: "TOON" },
          { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
          "toon",
        );
        expect(format.format).toBe("toon");

        const telemetry = await runConfig(
          "project",
          "set",
          "telemetry-tracking",
          { policy: "DISABLED" },
          { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
          "off",
        );
        expect(telemetry.policy).toBe("disabled");

        const closeValidation = await runConfig(
          "project",
          "set",
          "governance-close-validation-default",
          { policy: "DISABLED" },
          { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
          "off",
        );
        expect(closeValidation.policy).toBe("off");
      });
    });

    it("errors when a positional value conflicts with an explicit typed flag", async () => {
      await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
        const pmRoot = path.join(tempRoot, ".agents", "pm");
        await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

        await expect(
          runConfig(
            "project",
            "set",
            "telemetry-tracking",
            { policy: "enabled" },
            { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
            "off",
          ),
        ).rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE });

        await expect(
          runConfig(
            "project",
            "set",
            "item-format",
            { format: "json_markdown" },
            { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
            "toon",
          ),
        ).rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE });

        await expect(
          runConfig(
            "project",
            "set",
            "definition-of-done",
            { criterion: ["A"] },
            { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
            "B",
          ),
        ).rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE });
      });
    });

    it("rejects a positional value for context with a flag hint", async () => {
      await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
        const pmRoot = path.join(tempRoot, ".agents", "pm");
        await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

        await expect(
          runConfig("project", "set", "context", {}, { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot }, "deep"),
        ).rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE });
      });
    });

    it("reports unchanged lifecycle pattern criteria for all lifecycle keys", async () => {
      await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
        const pmRoot = path.join(tempRoot, ".agents", "pm");
        await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

        for (const [key, criteria] of [
          ["lifecycle-stale-blocker-reason-patterns", SETTINGS_DEFAULTS.validation.lifecycle_stale_blocker_reason_patterns],
          [
            "lifecycle-closure-like-blocked-reason-patterns",
            SETTINGS_DEFAULTS.validation.lifecycle_closure_like_blocked_reason_patterns,
          ],
          ["lifecycle-closure-like-resolution-patterns", SETTINGS_DEFAULTS.validation.lifecycle_closure_like_resolution_patterns],
          ["lifecycle-closure-like-actual-result-patterns", SETTINGS_DEFAULTS.validation.lifecycle_closure_like_actual_result_patterns],
        ] as const) {
          const result = await runConfig(
            "project",
            "set",
            key,
            { criterion: [...criteria] },
            { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot },
          );
          expect(result).toMatchObject({ key: key.replaceAll("-", "_"), changed: false });
        }
      });
    });

    it("rejects a positional value for non-set actions", async () => {
      await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
        const pmRoot = path.join(tempRoot, ".agents", "pm");
        await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

        await expect(
          runConfig("project", "get", "telemetry-tracking", {}, { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot }, "off"),
        ).rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE });
      });
    });

    it("rejects a positional value when no key is provided", async () => {
      await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
        const pmRoot = path.join(tempRoot, ".agents", "pm");
        await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

        await expect(
          runConfig("project", "set", undefined, {}, { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot }, "off"),
        ).rejects.toMatchObject({ exitCode: EXIT_CODE.USAGE });
      });
    });

    it("shows a shortened invalid-key error listing canonical kebab forms", async () => {
      await withTempRoot("pm-cli-config-command-test-", async (tempRoot) => {
        const pmRoot = path.join(tempRoot, ".agents", "pm");
        await writeSettings(pmRoot, structuredClone(SETTINGS_DEFAULTS));

        let caught: unknown;
        try {
          await runConfig("project", "get", "bogus-key", {}, { ...DEFAULT_GLOBAL_OPTIONS, path: pmRoot });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(PmCliError);
        const message = (caught as PmCliError).message;
        expect(message).toContain("underscore variants also accepted");
        expect(message).toContain("telemetry-tracking");
        // The shortened list must NOT include the snake_case duplicates.
        expect(message).not.toContain("telemetry_tracking");
      });
    });
  });
});
