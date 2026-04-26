import { pathExists } from "../../core/fs/fs-utils.js";
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { normalizeParentReferencePolicy } from "../../core/item/parent-reference-policy.js";
import { normalizeSprintReleaseFormatPolicy } from "../../core/item/sprint-release-format.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { migrateItemFilesToFormat } from "../../core/store/item-format-migration.js";
import {
  getSettingsPath,
  resolveGlobalPmRoot,
  resolvePmRoot,
} from "../../core/store/paths.js";
import { readSettingsWithMetadata, writeSettings } from "../../core/store/settings.js";
import type {
  GovernanceCloseValidationDefault,
  GovernanceCreateModeDefault,
  GovernanceOwnershipEnforcement,
  GovernancePreset,
  ItemFormat,
  ParentReferencePolicy,
  SprintReleaseFormatPolicy,
  ValidateMetadataProfile,
  ValidateMetadataRequiredField,
} from "../../types/index.js";

const CONFIG_SCOPE_VALUES = ["project", "global"] as const;
type ConfigScope = (typeof CONFIG_SCOPE_VALUES)[number];

const CONFIG_KEY_VALUES = [
  "definition-of-done",
  "definition_of_done",
  "item-format",
  "item_format",
  "history-missing-stream-policy",
  "history_missing_stream_policy",
  "sprint-release-format-policy",
  "sprint_release_format_policy",
  "parent-reference-policy",
  "parent_reference_policy",
  "metadata-validation-profile",
  "metadata_validation_profile",
  "metadata-required-fields",
  "metadata_required_fields",
  "governance-preset",
  "governance_preset",
  "governance-ownership-enforcement",
  "governance_ownership_enforcement",
  "governance-create-mode-default",
  "governance_create_mode_default",
  "governance-close-validation-default",
  "governance_close_validation_default",
  "governance-parent-reference-policy",
  "governance_parent_reference_policy",
  "governance-metadata-validation-profile",
  "governance_metadata_validation_profile",
  "governance-force-required-for-stale-lock",
  "governance_force_required_for_stale_lock",
  "test-result-tracking",
  "test_result_tracking",
  "telemetry-tracking",
  "telemetry_tracking",
] as const;
type ConfigAction = "get" | "set" | "list" | "export";
type ConfigKey =
  | "definition_of_done"
  | "item_format"
  | "history_missing_stream_policy"
  | "sprint_release_format_policy"
  | "parent_reference_policy"
  | "metadata_validation_profile"
  | "metadata_required_fields"
  | "governance_preset"
  | "governance_ownership_enforcement"
  | "governance_create_mode_default"
  | "governance_close_validation_default"
  | "governance_parent_reference_policy"
  | "governance_metadata_validation_profile"
  | "governance_force_required_for_stale_lock"
  | "test_result_tracking"
  | "telemetry_tracking";
type HistoryMissingStreamPolicy = "auto_create" | "strict_error";
type TestResultTrackingPolicy = "enabled" | "disabled";
type TelemetryTrackingPolicy = "enabled" | "disabled";
type GovernanceForceRequiredForStaleLockPolicy = "enabled" | "disabled";
type ConfigValue =
  | string[]
  | ItemFormat
  | HistoryMissingStreamPolicy
  | SprintReleaseFormatPolicy
  | ParentReferencePolicy
  | ValidateMetadataProfile
  | GovernancePreset
  | GovernanceOwnershipEnforcement
  | GovernanceCreateModeDefault
  | GovernanceCloseValidationDefault
  | GovernanceForceRequiredForStaleLockPolicy
  | TestResultTrackingPolicy
  | TelemetryTrackingPolicy;

interface ConfigKeyDescriptor {
  key: ConfigKey;
  aliases: string[];
  value_kind: "string_array" | "enum";
  set_flags: string[];
  summary: string;
  value: ConfigValue;
}

export interface ConfigCommandOptions {
  criterion?: string[];
  format?: string;
  policy?: string;
  clearCriteria?: boolean;
}

export interface ConfigResult {
  scope: ConfigScope;
  key?: ConfigKey;
  criteria?: string[];
  format?: ItemFormat;
  policy?:
    | HistoryMissingStreamPolicy
    | SprintReleaseFormatPolicy
    | ParentReferencePolicy
    | ValidateMetadataProfile
    | GovernancePreset
    | GovernanceOwnershipEnforcement
    | GovernanceCreateModeDefault
    | GovernanceCloseValidationDefault
    | GovernanceForceRequiredForStaleLockPolicy
    | TestResultTrackingPolicy
    | TelemetryTrackingPolicy;
  keys?: ConfigKeyDescriptor[];
  values?: Record<ConfigKey, ConfigValue>;
  count?: number;
  has_explicit_item_format?: boolean;
  migration?: {
    target_format: ItemFormat;
    scanned: number;
    migrated: string[];
    removed: string[];
    warnings: string[];
  };
  settings_path: string;
  changed: boolean;
  warnings?: string[];
}

const CONFIG_KEY_ALIASES: Record<ConfigKey, string[]> = {
  definition_of_done: ["definition-of-done", "definition_of_done"],
  item_format: ["item-format", "item_format"],
  history_missing_stream_policy: ["history-missing-stream-policy", "history_missing_stream_policy"],
  sprint_release_format_policy: ["sprint-release-format-policy", "sprint_release_format_policy"],
  parent_reference_policy: ["parent-reference-policy", "parent_reference_policy"],
  metadata_validation_profile: ["metadata-validation-profile", "metadata_validation_profile"],
  metadata_required_fields: ["metadata-required-fields", "metadata_required_fields"],
  governance_preset: ["governance-preset", "governance_preset"],
  governance_ownership_enforcement: ["governance-ownership-enforcement", "governance_ownership_enforcement"],
  governance_create_mode_default: ["governance-create-mode-default", "governance_create_mode_default"],
  governance_close_validation_default: [
    "governance-close-validation-default",
    "governance_close_validation_default",
  ],
  governance_parent_reference_policy: ["governance-parent-reference-policy", "governance_parent_reference_policy"],
  governance_metadata_validation_profile: [
    "governance-metadata-validation-profile",
    "governance_metadata_validation_profile",
  ],
  governance_force_required_for_stale_lock: [
    "governance-force-required-for-stale-lock",
    "governance_force_required_for_stale_lock",
  ],
  test_result_tracking: ["test-result-tracking", "test_result_tracking"],
  telemetry_tracking: ["telemetry-tracking", "telemetry_tracking"],
};

const CONFIG_KEY_SUMMARIES: Record<ConfigKey, string> = {
  definition_of_done: "Definition of Done criteria list.",
  item_format: "Default item file format.",
  history_missing_stream_policy: "Missing history stream handling policy.",
  sprint_release_format_policy: "Sprint/release format validation policy.",
  parent_reference_policy: "Parent reference validation policy.",
  metadata_validation_profile: "Validate metadata profile policy (core|strict|custom).",
  metadata_required_fields: "Validate custom metadata required-fields list.",
  governance_preset: "Governance preset policy (minimal|default|strict|custom).",
  governance_ownership_enforcement: "Governance ownership enforcement policy (none|warn|strict).",
  governance_create_mode_default: "Governance default create mode (progressive|strict).",
  governance_close_validation_default: "Governance default close validation mode (off|warn|strict).",
  governance_parent_reference_policy: "Governance parent reference policy (warn|strict_error).",
  governance_metadata_validation_profile: "Governance metadata validation profile (core|strict|custom).",
  governance_force_required_for_stale_lock: "Governance stale-lock force policy (enabled|disabled).",
  test_result_tracking: "Item-level linked test result persistence policy.",
  telemetry_tracking: "Telemetry usage reporting policy.",
};

function normalizeScope(value: string): ConfigScope {
  if ((CONFIG_SCOPE_VALUES as readonly string[]).includes(value)) {
    return value as ConfigScope;
  }
  throw new PmCliError(
    `Invalid config scope "${value}". Allowed: ${CONFIG_SCOPE_VALUES.join(", ")}`,
    EXIT_CODE.USAGE,
  );
}

function normalizeAction(value: string): ConfigAction {
  if (value === "get" || value === "set" || value === "list" || value === "export") {
    return value;
  }
  throw new PmCliError(`Invalid config action "${value}". Allowed: get, set, list, export`, EXIT_CODE.USAGE);
}

function normalizeKey(value: string): ConfigKey {
  if ((CONFIG_KEY_VALUES as readonly string[]).includes(value)) {
    if (value === "item-format" || value === "item_format") {
      return "item_format";
    }
    if (value === "history-missing-stream-policy" || value === "history_missing_stream_policy") {
      return "history_missing_stream_policy";
    }
    if (value === "sprint-release-format-policy" || value === "sprint_release_format_policy") {
      return "sprint_release_format_policy";
    }
    if (value === "parent-reference-policy" || value === "parent_reference_policy") {
      return "parent_reference_policy";
    }
    if (value === "metadata-validation-profile" || value === "metadata_validation_profile") {
      return "metadata_validation_profile";
    }
    if (value === "metadata-required-fields" || value === "metadata_required_fields") {
      return "metadata_required_fields";
    }
    if (value === "governance-preset" || value === "governance_preset") {
      return "governance_preset";
    }
    if (value === "governance-ownership-enforcement" || value === "governance_ownership_enforcement") {
      return "governance_ownership_enforcement";
    }
    if (value === "governance-create-mode-default" || value === "governance_create_mode_default") {
      return "governance_create_mode_default";
    }
    if (value === "governance-close-validation-default" || value === "governance_close_validation_default") {
      return "governance_close_validation_default";
    }
    if (value === "governance-parent-reference-policy" || value === "governance_parent_reference_policy") {
      return "governance_parent_reference_policy";
    }
    if (
      value === "governance-metadata-validation-profile" ||
      value === "governance_metadata_validation_profile"
    ) {
      return "governance_metadata_validation_profile";
    }
    if (
      value === "governance-force-required-for-stale-lock" ||
      value === "governance_force_required_for_stale_lock"
    ) {
      return "governance_force_required_for_stale_lock";
    }
    if (value === "test-result-tracking" || value === "test_result_tracking") {
      return "test_result_tracking";
    }
    if (value === "telemetry-tracking" || value === "telemetry_tracking") {
      return "telemetry_tracking";
    }
    return "definition_of_done";
  }
  throw new PmCliError(
    `Invalid config key "${value}". Supported: ${CONFIG_KEY_VALUES.join(", ")}`,
    EXIT_CODE.USAGE,
  );
}

function normalizeCriteria(values: string[] | undefined, clearCriteria: boolean | undefined): string[] {
  const normalized = [...new Set((values ?? []).map((value) => value.trim()).filter((value) => value.length > 0))].sort(
    (left, right) => left.localeCompare(right),
  );
  if (clearCriteria) {
    if (normalized.length > 0) {
      throw new PmCliError(
        "Config set definition-of-done cannot combine --clear-criteria with --criterion values",
        EXIT_CODE.USAGE,
      );
    }
    return [];
  }
  if (normalized.length === 0) {
    throw new PmCliError(
      "Config set definition-of-done requires at least one non-empty --criterion value (or --clear-criteria to clear)",
      EXIT_CODE.USAGE,
    );
  }
  return normalized;
}

function normalizeItemFormat(value: string | undefined): ItemFormat {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "toon" || normalized === "json_markdown") {
    return normalized;
  }
  throw new PmCliError('Config set item-format requires --format with one of: toon, json_markdown', EXIT_CODE.USAGE);
}

function normalizeHistoryMissingStreamPolicy(value: string | undefined): HistoryMissingStreamPolicy {
  const normalized = value?.trim().toLowerCase().replaceAll("-", "_");
  if (normalized === "auto_create" || normalized === "strict_error") {
    return normalized;
  }
  throw new PmCliError(
    "Config set history-missing-stream-policy requires --policy with one of: auto_create, strict_error",
    EXIT_CODE.USAGE,
  );
}

function normalizeTestResultTrackingPolicy(value: string | undefined): TestResultTrackingPolicy {
  const normalized = value?.trim().toLowerCase().replaceAll("-", "_");
  if (normalized === "enabled" || normalized === "disabled") {
    return normalized;
  }
  throw new PmCliError(
    "Config set test-result-tracking requires --policy with one of: enabled, disabled",
    EXIT_CODE.USAGE,
  );
}

function normalizeTelemetryTrackingPolicy(value: string | undefined): TelemetryTrackingPolicy {
  const normalized = value?.trim().toLowerCase().replaceAll("-", "_");
  if (normalized === "enabled" || normalized === "disabled") {
    return normalized;
  }
  throw new PmCliError(
    "Config set telemetry-tracking requires --policy with one of: enabled, disabled",
    EXIT_CODE.USAGE,
  );
}

function normalizeValidateMetadataProfile(value: string | undefined): ValidateMetadataProfile {
  const normalized = value?.trim().toLowerCase().replaceAll("-", "_");
  if (normalized === "core" || normalized === "strict" || normalized === "custom") {
    return normalized;
  }
  throw new PmCliError(
    "Config set metadata-validation-profile requires --policy with one of: core, strict, custom",
    EXIT_CODE.USAGE,
  );
}

function normalizeGovernancePreset(value: string | undefined): GovernancePreset {
  const normalized = value?.trim().toLowerCase().replaceAll("-", "_");
  if (normalized === "minimal" || normalized === "default" || normalized === "strict" || normalized === "custom") {
    return normalized;
  }
  throw new PmCliError(
    "Config set governance-preset requires --policy with one of: minimal, default, strict, custom",
    EXIT_CODE.USAGE,
  );
}

function normalizeGovernanceOwnershipEnforcement(value: string | undefined): GovernanceOwnershipEnforcement {
  const normalized = value?.trim().toLowerCase().replaceAll("-", "_");
  if (normalized === "none" || normalized === "warn" || normalized === "strict") {
    return normalized;
  }
  throw new PmCliError(
    "Config set governance-ownership-enforcement requires --policy with one of: none, warn, strict",
    EXIT_CODE.USAGE,
  );
}

function normalizeGovernanceCreateModeDefault(value: string | undefined): GovernanceCreateModeDefault {
  const normalized = value?.trim().toLowerCase().replaceAll("-", "_");
  if (normalized === "progressive" || normalized === "strict") {
    return normalized;
  }
  throw new PmCliError(
    "Config set governance-create-mode-default requires --policy with one of: progressive, strict",
    EXIT_CODE.USAGE,
  );
}

function normalizeGovernanceCloseValidationDefault(value: string | undefined): GovernanceCloseValidationDefault {
  const normalized = value?.trim().toLowerCase().replaceAll("-", "_");
  if (normalized === "off" || normalized === "warn" || normalized === "strict") {
    return normalized;
  }
  if (normalized === "none" || normalized === "disabled") {
    return "off";
  }
  throw new PmCliError(
    "Config set governance-close-validation-default requires --policy with one of: off, warn, strict",
    EXIT_CODE.USAGE,
  );
}

function normalizeGovernanceForceRequiredForStaleLockPolicy(
  value: string | undefined,
): GovernanceForceRequiredForStaleLockPolicy {
  const normalized = value?.trim().toLowerCase().replaceAll("-", "_");
  if (normalized === "enabled" || normalized === "disabled") {
    return normalized;
  }
  throw new PmCliError(
    "Config set governance-force-required-for-stale-lock requires --policy with one of: enabled, disabled",
    EXIT_CODE.USAGE,
  );
}

const METADATA_REQUIRED_FIELD_ALIAS_MAP: Record<string, ValidateMetadataRequiredField> = {
  author: "author",
  acceptance_criteria: "acceptance_criteria",
  "acceptance-criteria": "acceptance_criteria",
  estimated_minutes: "estimated_minutes",
  "estimated-minutes": "estimated_minutes",
  estimate: "estimated_minutes",
  close_reason: "close_reason",
  "close-reason": "close_reason",
  reviewer: "reviewer",
  risk: "risk",
  confidence: "confidence",
  sprint: "sprint",
  release: "release",
};
const METADATA_REQUIRED_FIELD_OPTIONS = [
  "author",
  "acceptance_criteria",
  "estimated_minutes",
  "close_reason",
  "reviewer",
  "risk",
  "confidence",
  "sprint",
  "release",
] as const;

function normalizeMetadataRequiredFields(
  values: string[] | undefined,
  clearCriteria: boolean | undefined,
): ValidateMetadataRequiredField[] {
  const normalized = [...new Set((values ?? []).map((value) => value.trim()).filter((value) => value.length > 0))];
  if (clearCriteria) {
    if (normalized.length > 0) {
      throw new PmCliError(
        "Config set metadata-required-fields cannot combine --clear-criteria with --criterion values",
        EXIT_CODE.USAGE,
      );
    }
    return [];
  }
  if (normalized.length === 0) {
    throw new PmCliError(
      "Config set metadata-required-fields requires at least one --criterion value (or --clear-criteria to clear)",
      EXIT_CODE.USAGE,
    );
  }
  const lowered = normalized.map((value) => value.toLowerCase().replaceAll("-", "_"));
  const unsupported = lowered.filter((value) => METADATA_REQUIRED_FIELD_ALIAS_MAP[value] === undefined);
  if (unsupported.length > 0) {
    throw new PmCliError(
      `Config set metadata-required-fields received unsupported values: ${unsupported.join(", ")}. ` +
        `Supported values: ${METADATA_REQUIRED_FIELD_OPTIONS.join(", ")}`,
      EXIT_CODE.USAGE,
    );
  }
  return [...new Set(lowered.map((value) => METADATA_REQUIRED_FIELD_ALIAS_MAP[value] as ValidateMetadataRequiredField))].sort(
    (left, right) => left.localeCompare(right),
  );
}

function normalizeWarnings(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function normalizeKeyForAction(action: ConfigAction, value: string | undefined): ConfigKey | undefined {
  if (action === "list" || action === "export") {
    if (typeof value === "string" && value.trim().length > 0) {
      throw new PmCliError(`Config action "${action}" does not accept <key>`, EXIT_CODE.USAGE);
    }
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PmCliError(`Config action "${action}" requires <key>`, EXIT_CODE.USAGE);
  }
  return normalizeKey(value);
}

function readConfigValue(settings: {
  workflow: { definition_of_done: string[] };
  item_format: ItemFormat;
  history: { missing_stream: HistoryMissingStreamPolicy };
  validation: {
    sprint_release_format: SprintReleaseFormatPolicy;
    parent_reference: ParentReferencePolicy;
    metadata_profile: ValidateMetadataProfile;
    metadata_required_fields: ValidateMetadataRequiredField[];
  };
  governance: {
    preset: GovernancePreset;
    ownership_enforcement: GovernanceOwnershipEnforcement;
    create_mode_default: GovernanceCreateModeDefault;
    close_validation_default: GovernanceCloseValidationDefault;
    parent_reference: ParentReferencePolicy;
    metadata_profile: ValidateMetadataProfile;
    force_required_for_stale_lock: boolean;
  };
  testing: { record_results_to_items: boolean };
  telemetry: { enabled: boolean };
}, key: ConfigKey): ConfigValue {
  if (key === "item_format") {
    return settings.item_format;
  }
  if (key === "history_missing_stream_policy") {
    return settings.history.missing_stream;
  }
  if (key === "sprint_release_format_policy") {
    return settings.validation.sprint_release_format;
  }
  if (key === "parent_reference_policy") {
    return settings.validation.parent_reference;
  }
  if (key === "metadata_validation_profile") {
    return settings.validation.metadata_profile;
  }
  if (key === "metadata_required_fields") {
    return [...settings.validation.metadata_required_fields];
  }
  if (key === "governance_preset") {
    return settings.governance.preset;
  }
  if (key === "governance_ownership_enforcement") {
    return settings.governance.ownership_enforcement;
  }
  if (key === "governance_create_mode_default") {
    return settings.governance.create_mode_default;
  }
  if (key === "governance_close_validation_default") {
    return settings.governance.close_validation_default;
  }
  if (key === "governance_parent_reference_policy") {
    return settings.governance.parent_reference;
  }
  if (key === "governance_metadata_validation_profile") {
    return settings.governance.metadata_profile;
  }
  if (key === "governance_force_required_for_stale_lock") {
    return settings.governance.force_required_for_stale_lock ? "enabled" : "disabled";
  }
  if (key === "test_result_tracking") {
    return settings.testing.record_results_to_items ? "enabled" : "disabled";
  }
  if (key === "telemetry_tracking") {
    return settings.telemetry.enabled ? "enabled" : "disabled";
  }
  return [...settings.workflow.definition_of_done];
}

function withWarnings(result: ConfigResult, warnings: string[]): ConfigResult {
  if (warnings.length === 0) {
    return result;
  }
  return {
    ...result,
    warnings,
  };
}

async function resolveSettingsTarget(
  scope: ConfigScope,
  global: GlobalOptions,
): Promise<{ pmRoot: string; settingsPath: string }> {
  const cwd = process.cwd();
  const pmRoot = scope === "project" ? resolvePmRoot(cwd, global.path) : resolveGlobalPmRoot(cwd);
  const settingsPath = getSettingsPath(pmRoot);
  if (scope === "project" && !(await pathExists(settingsPath))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }
  return { pmRoot, settingsPath };
}

export async function runConfig(
  scopeValue: string,
  actionValue: string,
  keyValue: string | undefined,
  options: ConfigCommandOptions,
  global: GlobalOptions,
): Promise<ConfigResult> {
  const scope = normalizeScope(scopeValue);
  const action = normalizeAction(actionValue);
  const key = normalizeKeyForAction(action, keyValue);
  const target = await resolveSettingsTarget(scope, global);
  const { settings, metadata, warnings: settingsReadWarnings } = await readSettingsWithMetadata(target.pmRoot);
  const warnings = normalizeWarnings(settingsReadWarnings);

  if (action === "list") {
    const keys = (Object.keys(CONFIG_KEY_ALIASES) as ConfigKey[]).map((candidate) => ({
      key: candidate,
      aliases: CONFIG_KEY_ALIASES[candidate],
      value_kind:
        candidate === "definition_of_done" || candidate === "metadata_required_fields"
          ? ("string_array" as const)
          : ("enum" as const),
      set_flags:
        candidate === "definition_of_done"
          ? ["--criterion", "--clear-criteria"]
          : candidate === "metadata_required_fields"
            ? ["--criterion", "--clear-criteria"]
          : candidate === "item_format"
            ? ["--format"]
            : ["--policy"],
      summary: CONFIG_KEY_SUMMARIES[candidate],
      value: readConfigValue(settings, candidate),
    }));
    return withWarnings(
      {
        scope,
        keys,
        count: keys.length,
        settings_path: target.settingsPath,
        changed: false,
      },
      warnings,
    );
  }

  if (action === "export") {
    const values = {
      definition_of_done: readConfigValue(settings, "definition_of_done"),
      item_format: readConfigValue(settings, "item_format"),
      history_missing_stream_policy: readConfigValue(settings, "history_missing_stream_policy"),
      sprint_release_format_policy: readConfigValue(settings, "sprint_release_format_policy"),
      parent_reference_policy: readConfigValue(settings, "parent_reference_policy"),
      metadata_validation_profile: readConfigValue(settings, "metadata_validation_profile"),
      metadata_required_fields: readConfigValue(settings, "metadata_required_fields"),
      governance_preset: readConfigValue(settings, "governance_preset"),
      governance_ownership_enforcement: readConfigValue(settings, "governance_ownership_enforcement"),
      governance_create_mode_default: readConfigValue(settings, "governance_create_mode_default"),
      governance_close_validation_default: readConfigValue(settings, "governance_close_validation_default"),
      governance_parent_reference_policy: readConfigValue(settings, "governance_parent_reference_policy"),
      governance_metadata_validation_profile: readConfigValue(settings, "governance_metadata_validation_profile"),
      governance_force_required_for_stale_lock: readConfigValue(settings, "governance_force_required_for_stale_lock"),
      test_result_tracking: readConfigValue(settings, "test_result_tracking"),
      telemetry_tracking: readConfigValue(settings, "telemetry_tracking"),
    } satisfies Record<ConfigKey, ConfigValue>;
    return withWarnings(
      {
        scope,
        values,
        settings_path: target.settingsPath,
        changed: false,
      },
      warnings,
    );
  }

  if (action === "get") {
    if (!key) {
      throw new PmCliError('Config action "get" requires <key>', EXIT_CODE.USAGE);
    }
    if (key === "item_format") {
      return withWarnings({
        scope,
        key,
        format: settings.item_format,
        has_explicit_item_format: metadata.has_explicit_item_format,
        settings_path: target.settingsPath,
        changed: false,
      }, warnings);
    }
    if (key === "history_missing_stream_policy") {
      return withWarnings({
        scope,
        key,
        policy: settings.history.missing_stream,
        settings_path: target.settingsPath,
        changed: false,
      }, warnings);
    }
    if (key === "sprint_release_format_policy") {
      return withWarnings({
        scope,
        key,
        policy: settings.validation.sprint_release_format,
        settings_path: target.settingsPath,
        changed: false,
      }, warnings);
    }
    if (key === "parent_reference_policy") {
      return withWarnings({
        scope,
        key,
        policy: settings.validation.parent_reference,
        settings_path: target.settingsPath,
        changed: false,
      }, warnings);
    }
    if (key === "metadata_validation_profile") {
      return withWarnings({
        scope,
        key,
        policy: settings.validation.metadata_profile,
        settings_path: target.settingsPath,
        changed: false,
      }, warnings);
    }
    if (key === "metadata_required_fields") {
      return withWarnings({
        scope,
        key,
        criteria: [...settings.validation.metadata_required_fields],
        settings_path: target.settingsPath,
        changed: false,
      }, warnings);
    }
    if (key === "governance_preset") {
      return withWarnings({
        scope,
        key,
        policy: settings.governance.preset,
        settings_path: target.settingsPath,
        changed: false,
      }, warnings);
    }
    if (key === "governance_ownership_enforcement") {
      return withWarnings({
        scope,
        key,
        policy: settings.governance.ownership_enforcement,
        settings_path: target.settingsPath,
        changed: false,
      }, warnings);
    }
    if (key === "governance_create_mode_default") {
      return withWarnings({
        scope,
        key,
        policy: settings.governance.create_mode_default,
        settings_path: target.settingsPath,
        changed: false,
      }, warnings);
    }
    if (key === "governance_close_validation_default") {
      return withWarnings({
        scope,
        key,
        policy: settings.governance.close_validation_default,
        settings_path: target.settingsPath,
        changed: false,
      }, warnings);
    }
    if (key === "governance_parent_reference_policy") {
      return withWarnings({
        scope,
        key,
        policy: settings.governance.parent_reference,
        settings_path: target.settingsPath,
        changed: false,
      }, warnings);
    }
    if (key === "governance_metadata_validation_profile") {
      return withWarnings({
        scope,
        key,
        policy: settings.governance.metadata_profile,
        settings_path: target.settingsPath,
        changed: false,
      }, warnings);
    }
    if (key === "governance_force_required_for_stale_lock") {
      return withWarnings({
        scope,
        key,
        policy: settings.governance.force_required_for_stale_lock ? "enabled" : "disabled",
        settings_path: target.settingsPath,
        changed: false,
      }, warnings);
    }
    if (key === "test_result_tracking") {
      return withWarnings({
        scope,
        key,
        policy: settings.testing.record_results_to_items ? "enabled" : "disabled",
        settings_path: target.settingsPath,
        changed: false,
      }, warnings);
    }
    if (key === "telemetry_tracking") {
      return withWarnings({
        scope,
        key,
        policy: settings.telemetry.enabled ? "enabled" : "disabled",
        settings_path: target.settingsPath,
        changed: false,
      }, warnings);
    }
    return withWarnings({
      scope,
      key,
      criteria: [...settings.workflow.definition_of_done],
      settings_path: target.settingsPath,
      changed: false,
    }, warnings);
  }

  if (!key) {
    throw new PmCliError('Config action "set" requires <key>', EXIT_CODE.USAGE);
  }
  if (options.clearCriteria === true && key !== "metadata_required_fields" && key !== "definition_of_done") {
    throw new PmCliError(
      "--clear-criteria is only supported with config set definition-of-done or metadata-required-fields",
      EXIT_CODE.USAGE,
    );
  }
  if (key === "item_format") {
    const nextFormat = normalizeItemFormat(options.format);
    const changed = settings.item_format !== nextFormat || !metadata.has_explicit_item_format;
    let migration: ConfigResult["migration"] = undefined;
    settings.item_format = nextFormat;
    if (changed) {
      await writeSettings(target.pmRoot, settings, "config:set:item_format");
      const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
      const migrated = await migrateItemFilesToFormat(
        target.pmRoot,
        nextFormat,
        "config:set:item_format:migrate",
        typeRegistry.type_to_folder,
        settings.schema,
      );
      migration = {
        target_format: migrated.target_format,
        scanned: migrated.scanned,
        migrated: migrated.migrated,
        removed: migrated.removed,
        warnings: migrated.warnings,
      };
    }
    return withWarnings({
      scope,
      key,
      format: settings.item_format,
      has_explicit_item_format: true,
      migration,
      settings_path: target.settingsPath,
      changed,
    }, warnings);
  }

  if (key === "history_missing_stream_policy") {
    const nextPolicy = normalizeHistoryMissingStreamPolicy(options.policy);
    const changed = settings.history.missing_stream !== nextPolicy;
    settings.history.missing_stream = nextPolicy;
    if (changed) {
      await writeSettings(target.pmRoot, settings, "config:set:history_missing_stream_policy");
    }
    return withWarnings({
      scope,
      key,
      policy: settings.history.missing_stream,
      settings_path: target.settingsPath,
      changed,
    }, warnings);
  }

  if (key === "sprint_release_format_policy") {
    const nextPolicy = normalizeSprintReleaseFormatPolicy(options.policy);
    const changed = settings.validation.sprint_release_format !== nextPolicy;
    settings.validation.sprint_release_format = nextPolicy;
    if (changed) {
      await writeSettings(target.pmRoot, settings, "config:set:sprint_release_format_policy");
    }
    return withWarnings({
      scope,
      key,
      policy: settings.validation.sprint_release_format,
      settings_path: target.settingsPath,
      changed,
    }, warnings);
  }

  if (key === "parent_reference_policy") {
    const nextPolicy = normalizeParentReferencePolicy(options.policy);
    const changed =
      settings.validation.parent_reference !== nextPolicy ||
      settings.governance.preset !== "custom" ||
      settings.governance.parent_reference !== nextPolicy;
    settings.validation.parent_reference = nextPolicy;
    settings.governance.preset = "custom";
    settings.governance.parent_reference = nextPolicy;
    if (changed) {
      await writeSettings(target.pmRoot, settings, "config:set:parent_reference_policy");
    }
    return withWarnings({
      scope,
      key,
      policy: settings.validation.parent_reference,
      settings_path: target.settingsPath,
      changed,
    }, warnings);
  }

  if (key === "metadata_validation_profile") {
    const nextPolicy = normalizeValidateMetadataProfile(options.policy);
    const changed =
      settings.validation.metadata_profile !== nextPolicy ||
      settings.governance.preset !== "custom" ||
      settings.governance.metadata_profile !== nextPolicy;
    settings.validation.metadata_profile = nextPolicy;
    settings.governance.preset = "custom";
    settings.governance.metadata_profile = nextPolicy;
    if (changed) {
      await writeSettings(target.pmRoot, settings, "config:set:metadata_validation_profile");
    }
    return withWarnings({
      scope,
      key,
      policy: settings.validation.metadata_profile,
      settings_path: target.settingsPath,
      changed,
    }, warnings);
  }

  if (key === "metadata_required_fields") {
    const nextCriteria = normalizeMetadataRequiredFields(options.criterion, options.clearCriteria);
    const changed =
      nextCriteria.length !== settings.validation.metadata_required_fields.length ||
      nextCriteria.some((value, index) => value !== settings.validation.metadata_required_fields[index]);
    settings.validation.metadata_required_fields = nextCriteria;
    if (changed) {
      await writeSettings(target.pmRoot, settings, "config:set:metadata_required_fields");
    }
    return withWarnings({
      scope,
      key,
      criteria: [...settings.validation.metadata_required_fields],
      settings_path: target.settingsPath,
      changed,
    }, warnings);
  }

  if (key === "governance_preset") {
    const nextPolicy = normalizeGovernancePreset(options.policy);
    const changed = settings.governance.preset !== nextPolicy;
    settings.governance.preset = nextPolicy;
    if (changed) {
      await writeSettings(target.pmRoot, settings, "config:set:governance_preset");
    }
    return withWarnings({
      scope,
      key,
      policy: settings.governance.preset,
      settings_path: target.settingsPath,
      changed,
    }, warnings);
  }

  if (key === "governance_ownership_enforcement") {
    const nextPolicy = normalizeGovernanceOwnershipEnforcement(options.policy);
    const changed =
      settings.governance.preset !== "custom" || settings.governance.ownership_enforcement !== nextPolicy;
    settings.governance.preset = "custom";
    settings.governance.ownership_enforcement = nextPolicy;
    if (changed) {
      await writeSettings(target.pmRoot, settings, "config:set:governance_ownership_enforcement");
    }
    return withWarnings({
      scope,
      key,
      policy: settings.governance.ownership_enforcement,
      settings_path: target.settingsPath,
      changed,
    }, warnings);
  }

  if (key === "governance_create_mode_default") {
    const nextPolicy = normalizeGovernanceCreateModeDefault(options.policy);
    const changed =
      settings.governance.preset !== "custom" || settings.governance.create_mode_default !== nextPolicy;
    settings.governance.preset = "custom";
    settings.governance.create_mode_default = nextPolicy;
    if (changed) {
      await writeSettings(target.pmRoot, settings, "config:set:governance_create_mode_default");
    }
    return withWarnings({
      scope,
      key,
      policy: settings.governance.create_mode_default,
      settings_path: target.settingsPath,
      changed,
    }, warnings);
  }

  if (key === "governance_close_validation_default") {
    const nextPolicy = normalizeGovernanceCloseValidationDefault(options.policy);
    const changed =
      settings.governance.preset !== "custom" || settings.governance.close_validation_default !== nextPolicy;
    settings.governance.preset = "custom";
    settings.governance.close_validation_default = nextPolicy;
    if (changed) {
      await writeSettings(target.pmRoot, settings, "config:set:governance_close_validation_default");
    }
    return withWarnings({
      scope,
      key,
      policy: settings.governance.close_validation_default,
      settings_path: target.settingsPath,
      changed,
    }, warnings);
  }

  if (key === "governance_parent_reference_policy") {
    const nextPolicy = normalizeParentReferencePolicy(options.policy);
    const changed =
      settings.governance.preset !== "custom" || settings.governance.parent_reference !== nextPolicy;
    settings.governance.preset = "custom";
    settings.governance.parent_reference = nextPolicy;
    settings.validation.parent_reference = nextPolicy;
    if (changed) {
      await writeSettings(target.pmRoot, settings, "config:set:governance_parent_reference_policy");
    }
    return withWarnings({
      scope,
      key,
      policy: settings.governance.parent_reference,
      settings_path: target.settingsPath,
      changed,
    }, warnings);
  }

  if (key === "governance_metadata_validation_profile") {
    const nextPolicy = normalizeValidateMetadataProfile(options.policy);
    const changed =
      settings.governance.preset !== "custom" || settings.governance.metadata_profile !== nextPolicy;
    settings.governance.preset = "custom";
    settings.governance.metadata_profile = nextPolicy;
    settings.validation.metadata_profile = nextPolicy;
    if (changed) {
      await writeSettings(target.pmRoot, settings, "config:set:governance_metadata_validation_profile");
    }
    return withWarnings({
      scope,
      key,
      policy: settings.governance.metadata_profile,
      settings_path: target.settingsPath,
      changed,
    }, warnings);
  }

  if (key === "governance_force_required_for_stale_lock") {
    const nextPolicy = normalizeGovernanceForceRequiredForStaleLockPolicy(options.policy);
    const nextEnabled = nextPolicy === "enabled";
    const changed =
      settings.governance.preset !== "custom" || settings.governance.force_required_for_stale_lock !== nextEnabled;
    settings.governance.preset = "custom";
    settings.governance.force_required_for_stale_lock = nextEnabled;
    if (changed) {
      await writeSettings(target.pmRoot, settings, "config:set:governance_force_required_for_stale_lock");
    }
    return withWarnings({
      scope,
      key,
      policy: settings.governance.force_required_for_stale_lock ? "enabled" : "disabled",
      settings_path: target.settingsPath,
      changed,
    }, warnings);
  }

  if (key === "test_result_tracking") {
    const nextPolicy = normalizeTestResultTrackingPolicy(options.policy);
    const nextEnabled = nextPolicy === "enabled";
    const changed = settings.testing.record_results_to_items !== nextEnabled;
    settings.testing.record_results_to_items = nextEnabled;
    if (changed) {
      await writeSettings(target.pmRoot, settings, "config:set:test_result_tracking");
    }
    return withWarnings({
      scope,
      key,
      policy: settings.testing.record_results_to_items ? "enabled" : "disabled",
      settings_path: target.settingsPath,
      changed,
    }, warnings);
  }

  if (key === "telemetry_tracking") {
    const nextPolicy = normalizeTelemetryTrackingPolicy(options.policy);
    const nextEnabled = nextPolicy === "enabled";
    const changed = settings.telemetry.enabled !== nextEnabled || !settings.telemetry.first_run_prompt_completed;
    settings.telemetry.enabled = nextEnabled;
    settings.telemetry.first_run_prompt_completed = true;
    if (changed) {
      await writeSettings(target.pmRoot, settings, "config:set:telemetry_tracking");
    }
    return withWarnings({
      scope,
      key,
      policy: settings.telemetry.enabled ? "enabled" : "disabled",
      settings_path: target.settingsPath,
      changed,
    }, warnings);
  }

  const nextCriteria = normalizeCriteria(options.criterion, options.clearCriteria);
  const changed =
    nextCriteria.length !== settings.workflow.definition_of_done.length ||
    nextCriteria.some((value, index) => value !== settings.workflow.definition_of_done[index]);

  settings.workflow.definition_of_done = nextCriteria;
  if (changed) {
    await writeSettings(target.pmRoot, settings, "config:set:definition_of_done");
  }

  return withWarnings({
    scope,
    key,
    criteria: [...settings.workflow.definition_of_done],
    settings_path: target.settingsPath,
    changed,
  }, warnings);
}
