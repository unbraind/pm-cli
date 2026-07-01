/**
 * @module cli/commands/config
 *
 * Implements the pm config command surface and its agent-facing runtime behavior.
 */
import { pathExists } from "../../core/fs/fs-utils.js";
import { resolveConfigPositionalValue, type ConfigKey } from "../../core/config/positional-value.js";
import {
  NESTED_SETTING_DESCRIPTORS,
  parseNestedSettingValue,
  readNestedSettingValue,
  resolveNestedSettingDescriptor,
  writeNestedSettingValue,
  type NestedSettingDescriptor,
} from "../../core/config/nested-settings.js";
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { normalizeParentReferencePolicy } from "../../core/item/parent-reference-policy.js";
import { normalizeSprintReleaseFormatPolicy } from "../../core/item/sprint-release-format.js";
import { resolveItemTypeRegistry, resolveTypeName } from "../../core/item/type-registry.js";
import { buildInvalidTypeError } from "../../core/schema/item-types-file.js";
import { resolveItemTypesFilePath } from "../../core/schema/runtime-schema.js";
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
  ContextDepth,
  GovernanceCloseValidationDefault,
  GovernanceCreateModeDefault,
  GovernanceOwnershipEnforcement,
  GovernancePreset,
  GovernanceWorkflowEnforcement,
  ItemFormat,
  ParentReferencePolicy,
  PmSettings,
  SprintReleaseFormatPolicy,
  ValidateMetadataProfile,
  ValidateMetadataRequiredField,
} from "../../types/index.js";
import { CONTEXT_DEPTH_VALUES } from "../../types/index.js";

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
  "lifecycle-stale-blocker-reason-patterns",
  "lifecycle_stale_blocker_reason_patterns",
  "lifecycle-closure-like-blocked-reason-patterns",
  "lifecycle_closure_like_blocked_reason_patterns",
  "lifecycle-closure-like-resolution-patterns",
  "lifecycle_closure_like_resolution_patterns",
  "lifecycle-closure-like-actual-result-patterns",
  "lifecycle_closure_like_actual_result_patterns",
  "governance-preset",
  "governance_preset",
  "governance-ownership-enforcement",
  "governance_ownership_enforcement",
  "governance-create-mode-default",
  "governance_create_mode_default",
  "governance-close-validation-default",
  "governance_close_validation_default",
  "governance-require-close-reason",
  "governance_require_close_reason",
  "governance-create-default-type",
  "governance_create_default_type",
  "governance-workflow-enforcement",
  "governance_workflow_enforcement",
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
  "context",
] as const;
type ConfigAction = "get" | "set" | "list" | "export";
type HistoryMissingStreamPolicy = "auto_create" | "strict_error";
type TestResultTrackingPolicy = "enabled" | "disabled";
type TelemetryTrackingPolicy = "enabled" | "disabled";
type GovernanceForceRequiredForStaleLockPolicy = "enabled" | "disabled";
type GovernanceRequireCloseReasonPolicy = "enabled" | "disabled";
type ConfigValue =
  | string
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
  | GovernanceRequireCloseReasonPolicy
  | GovernanceWorkflowEnforcement
  | GovernanceForceRequiredForStaleLockPolicy
  | TestResultTrackingPolicy
  | TelemetryTrackingPolicy
  | ContextConfigValue;

interface ContextConfigValue {
  default_depth: string;
  activity_limit: number;
  stale_threshold_days: number;
  sections: Record<string, boolean>;
}

interface ConfigKeyDescriptor {
  key: ConfigKey;
  aliases: string[];
  value_kind: "string_array" | "enum" | "object";
  set_flags: string[];
  summary: string;
  value: ConfigValue;
}

/**
 * Documents the config command options payload exchanged by command, SDK, and package integrations.
 */
export interface ConfigCommandOptions {
  criterion?: string[];
  format?: string;
  policy?: string;
  value?: string;
  clearCriteria?: boolean;
  defaultDepth?: string;
  activityLimit?: string;
  staleThresholdDays?: string;
  sectionHierarchy?: string;
  sectionActivity?: string;
  sectionProgress?: string;
  sectionBlockers?: string;
  sectionFiles?: string;
  sectionWorkload?: string;
  sectionStaleness?: string;
  sectionTests?: string;
}

/**
 * Documents the nested setting result value payload exchanged by command, SDK, and package integrations.
 */
export interface NestedSettingResultValue {
  key: string;
  path: string;
  kind: NestedSettingDescriptor["kind"];
  value: string | number | boolean | null;
}

/**
 * Documents the config result payload exchanged by command, SDK, and package integrations.
 */
export interface ConfigResult {
  scope: ConfigScope;
  key?: ConfigKey | string;
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
    | GovernanceRequireCloseReasonPolicy
    | GovernanceWorkflowEnforcement
    | GovernanceForceRequiredForStaleLockPolicy
    | TestResultTrackingPolicy
    | TelemetryTrackingPolicy
    | string;
  nested_setting?: NestedSettingResultValue;
  nested_settings?: NestedSettingResultValue[];
  keys?: ConfigKeyDescriptor[];
  values?: Record<ConfigKey, ConfigValue>;
  count?: number;
  context_settings?: ContextConfigValue;
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
  lifecycle_stale_blocker_reason_patterns: [
    "lifecycle-stale-blocker-reason-patterns",
    "lifecycle_stale_blocker_reason_patterns",
  ],
  lifecycle_closure_like_blocked_reason_patterns: [
    "lifecycle-closure-like-blocked-reason-patterns",
    "lifecycle_closure_like_blocked_reason_patterns",
  ],
  lifecycle_closure_like_resolution_patterns: [
    "lifecycle-closure-like-resolution-patterns",
    "lifecycle_closure_like_resolution_patterns",
  ],
  lifecycle_closure_like_actual_result_patterns: [
    "lifecycle-closure-like-actual-result-patterns",
    "lifecycle_closure_like_actual_result_patterns",
  ],
  governance_preset: ["governance-preset", "governance_preset"],
  governance_ownership_enforcement: ["governance-ownership-enforcement", "governance_ownership_enforcement"],
  governance_create_mode_default: ["governance-create-mode-default", "governance_create_mode_default"],
  governance_close_validation_default: [
    "governance-close-validation-default",
    "governance_close_validation_default",
  ],
  governance_require_close_reason: [
    "governance-require-close-reason",
    "governance_require_close_reason",
  ],
  governance_create_default_type: ["governance-create-default-type", "governance_create_default_type"],
  governance_workflow_enforcement: ["governance-workflow-enforcement", "governance_workflow_enforcement"],
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
  context: ["context"],
};

// Canonical kebab-case forms (first alias entry per key). Used for the invalid-key
// hint so agents see ~21 keys instead of all ~45 kebab+snake variants; snake_case
// forms stay fully accepted as input via CONFIG_KEY_VALUES/normalizeKey.
const CANONICAL_CONFIG_KEYS: readonly string[] = (Object.keys(CONFIG_KEY_ALIASES) as ConfigKey[]).map(
  (candidate) => CONFIG_KEY_ALIASES[candidate][0],
);
const CONFIG_KEY_BY_ALIAS: Readonly<Record<string, ConfigKey>> = Object.fromEntries(
  (Object.keys(CONFIG_KEY_ALIASES) as ConfigKey[]).flatMap((key) =>
    CONFIG_KEY_ALIASES[key].map((alias) => [alias, key] as const),
  ),
) as Readonly<Record<string, ConfigKey>>;

const CONFIG_KEY_SUMMARIES: Record<ConfigKey, string> = {
  definition_of_done: "Definition of Done criteria list.",
  item_format: "Default item file format.",
  history_missing_stream_policy: "Missing history stream handling policy.",
  sprint_release_format_policy: "Sprint/release format validation policy.",
  parent_reference_policy: "Parent reference validation policy.",
  metadata_validation_profile: "Validate metadata profile policy (core|strict|custom).",
  metadata_required_fields: "Validate custom metadata required-fields list.",
  lifecycle_stale_blocker_reason_patterns:
    "Validate lifecycle stale-blocker reason substring patterns (criteria list).",
  lifecycle_closure_like_blocked_reason_patterns:
    "Validate lifecycle closure-like blocked_reason substring patterns (criteria list).",
  lifecycle_closure_like_resolution_patterns:
    "Validate lifecycle closure-like resolution substring patterns (criteria list).",
  lifecycle_closure_like_actual_result_patterns:
    "Validate lifecycle closure-like actual_result substring patterns (criteria list).",
  governance_preset: "Governance preset policy (minimal|default|strict|custom).",
  governance_ownership_enforcement: "Governance ownership enforcement policy (none|warn|strict).",
  governance_create_mode_default: "Governance default create mode (progressive|strict).",
  governance_close_validation_default: "Governance default close validation mode (off|warn|strict).",
  governance_require_close_reason: "Governance close-reason requirement policy (enabled|disabled).",
  governance_create_default_type: "Governance default item type for `pm create` when --type is omitted.",
  governance_workflow_enforcement: "Governance per-type transition enforcement mode (off|warn|strict).",
  governance_parent_reference_policy: "Governance parent reference policy (warn|strict_error).",
  governance_metadata_validation_profile: "Governance metadata validation profile (core|strict|custom).",
  governance_force_required_for_stale_lock: "Governance stale-lock force policy (enabled|disabled).",
  test_result_tracking: "Item-level linked test result persistence policy.",
  telemetry_tracking: "Telemetry usage reporting policy.",
  context: "Context command settings (depth, section toggles, limits).",
};

const LIFECYCLE_PATTERN_CONFIG_KEYS = [
  "lifecycle_stale_blocker_reason_patterns",
  "lifecycle_closure_like_blocked_reason_patterns",
  "lifecycle_closure_like_resolution_patterns",
  "lifecycle_closure_like_actual_result_patterns",
] as const satisfies readonly ConfigKey[];
type LifecyclePatternConfigKey = (typeof LIFECYCLE_PATTERN_CONFIG_KEYS)[number];
type CriteriaConfigKey = "metadata_required_fields" | LifecyclePatternConfigKey;
type ValidationConfigKey =
  | "history_missing_stream_policy"
  | "sprint_release_format_policy"
  | "parent_reference_policy"
  | "metadata_validation_profile";
type GovernancePolicyConfigKey =
  | "governance_ownership_enforcement"
  | "governance_create_mode_default"
  | "governance_close_validation_default";
type GovernanceValidationConfigKey =
  | "governance_parent_reference_policy"
  | "governance_metadata_validation_profile"
  | "governance_workflow_enforcement";
type GovernancePresetOrTypeConfigKey = "governance_preset" | "governance_create_default_type";

const CRITERIA_CONFIG_KEYS: ReadonlySet<ConfigKey> = new Set<ConfigKey>([
  "metadata_required_fields",
  ...LIFECYCLE_PATTERN_CONFIG_KEYS,
]);
const TRACKING_CONFIG_KEYS: ReadonlySet<ConfigKey> = new Set<ConfigKey>([
  "test_result_tracking",
  "telemetry_tracking",
]);
const GOVERNANCE_BOOLEAN_CONFIG_KEYS: ReadonlySet<ConfigKey> = new Set<ConfigKey>([
  "governance_require_close_reason",
  "governance_force_required_for_stale_lock",
]);
const GOVERNANCE_POLICY_CONFIG_KEYS: ReadonlySet<ConfigKey> = new Set<ConfigKey>([
  "governance_ownership_enforcement",
  "governance_create_mode_default",
  "governance_close_validation_default",
]);
const GOVERNANCE_VALIDATION_CONFIG_KEYS: ReadonlySet<ConfigKey> = new Set<ConfigKey>([
  "governance_parent_reference_policy",
  "governance_metadata_validation_profile",
  "governance_workflow_enforcement",
]);
const GOVERNANCE_PRESET_OR_TYPE_CONFIG_KEYS: ReadonlySet<ConfigKey> = new Set<ConfigKey>([
  "governance_preset",
  "governance_create_default_type",
]);

const isCriteriaValueConfigKey = (key: ConfigKey): key is CriteriaConfigKey => CRITERIA_CONFIG_KEYS.has(key);
const isGovernancePolicyConfigKey = (key: ConfigKey): key is GovernancePolicyConfigKey =>
  GOVERNANCE_POLICY_CONFIG_KEYS.has(key);
const isGovernanceValidationConfigKey = (key: ConfigKey): key is GovernanceValidationConfigKey =>
  GOVERNANCE_VALIDATION_CONFIG_KEYS.has(key);
const isGovernancePresetOrTypeConfigKey = (key: ConfigKey): key is GovernancePresetOrTypeConfigKey =>
  GOVERNANCE_PRESET_OR_TYPE_CONFIG_KEYS.has(key);

function isCriteriaConfigKey(key: ConfigKey): boolean {
  return key === "definition_of_done" || isCriteriaValueConfigKey(key);
}

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
  const key = CONFIG_KEY_BY_ALIAS[value];
  if (key) {
    return key;
  }
  const nestedKeys = NESTED_SETTING_DESCRIPTORS.map((descriptor) => descriptor.key).join(", ");
  throw new PmCliError(
    `Invalid config key "${value}". Supported: ${CANONICAL_CONFIG_KEYS.join(", ")} (underscore variants also accepted). Nested leaf settings: ${nestedKeys}.`,
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
  if (normalized === "toon") {
    return "toon";
  }
  if (normalized === "json_markdown") {
    throw new PmCliError(
      "Config set item-format no longer accepts json_markdown. Markdown item files are legacy read/migration input only.",
      EXIT_CODE.USAGE,
    );
  }
  throw new PmCliError("Config set item-format requires --format toon", EXIT_CODE.USAGE);
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

function normalizeGovernanceWorkflowEnforcement(value: unknown): GovernanceWorkflowEnforcement {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase().replaceAll("-", "_") : undefined;
  if (normalized === "off" || normalized === "warn" || normalized === "strict") {
    return normalized;
  }
  if (normalized === "none" || normalized === "disabled") {
    return "off";
  }
  throw new PmCliError(
    "Config set governance-workflow-enforcement requires one of: off, warn, strict",
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

function normalizeGovernanceRequireCloseReasonPolicy(
  value: string | undefined,
): GovernanceRequireCloseReasonPolicy {
  const normalized = value?.trim().toLowerCase().replaceAll("-", "_");
  if (normalized === "enabled" || normalized === "disabled") {
    return normalized;
  }
  throw new PmCliError(
    "Config set governance-require-close-reason requires --policy with one of: enabled, disabled",
    EXIT_CODE.USAGE,
  );
}

function normalizePolicyForConflict(key: ConfigKey | undefined, value: string): string {
  switch (key) {
    case "history_missing_stream_policy":
      return normalizeHistoryMissingStreamPolicy(value);
    case "sprint_release_format_policy":
      return normalizeSprintReleaseFormatPolicy(value);
    case "parent_reference_policy":
    case "governance_parent_reference_policy":
      return normalizeParentReferencePolicy(value);
    case "metadata_validation_profile":
    case "governance_metadata_validation_profile":
      return normalizeValidateMetadataProfile(value);
    case "governance_preset":
      return normalizeGovernancePreset(value);
    case "governance_ownership_enforcement":
      return normalizeGovernanceOwnershipEnforcement(value);
    case "governance_create_mode_default":
      return normalizeGovernanceCreateModeDefault(value);
    case "governance_close_validation_default":
      return normalizeGovernanceCloseValidationDefault(value);
    case "governance_require_close_reason":
      return normalizeGovernanceRequireCloseReasonPolicy(value);
    case "governance_workflow_enforcement":
      return normalizeGovernanceWorkflowEnforcement(value);
    case "governance_force_required_for_stale_lock":
      return normalizeGovernanceForceRequiredForStaleLockPolicy(value);
    case "test_result_tracking":
      return normalizeTestResultTrackingPolicy(value);
    case "telemetry_tracking":
      return normalizeTelemetryTrackingPolicy(value);
    default:
      return value.trim().toLowerCase().replaceAll("-", "_");
  }
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

function normalizeLifecyclePatternCriteria(
  key: ConfigKey,
  values: string[] | undefined,
  clearCriteria: boolean | undefined,
): string[] {
  const normalized = [...new Set((values ?? []).map((value) => value.trim().toLowerCase()).filter((value) => value.length > 0))].sort(
    (left, right) => left.localeCompare(right),
  );
  if (clearCriteria) {
    if (normalized.length > 0) {
      throw new PmCliError(
        `Config set ${CONFIG_KEY_ALIASES[key][0]} cannot combine --clear-criteria with --criterion values`,
        EXIT_CODE.USAGE,
      );
    }
    return [];
  }
  if (normalized.length === 0) {
    throw new PmCliError(
      `Config set ${CONFIG_KEY_ALIASES[key][0]} requires at least one --criterion value (or --clear-criteria to clear)`,
      EXIT_CODE.USAGE,
    );
  }
  return normalized;
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

/**
 * Narrows the `ConfigKey | undefined` carried into the get/set branches back to
 * a concrete `ConfigKey`. By the time those branches run, `normalizeKeyForAction`
 * has already thrown on a missing key and nested settings have returned earlier,
 * so the `undefined` case is unreachable at runtime — the throw is a defensive
 * type-narrowing guard only.
 */
function assertConfigKeyDefined(key: ConfigKey | undefined): asserts key is ConfigKey {
  /* c8 ignore next 3 -- defensive: get/set always carry a key (see normalizeKeyForAction). */
  if (!key) {
    throw new PmCliError("Config action requires <key>", EXIT_CODE.USAGE);
  }
}

const CONFIG_VALUE_READERS: Readonly<Record<ConfigKey, (settings: PmSettings) => ConfigValue>> = {
  definition_of_done: (settings) => [...settings.workflow.definition_of_done],
  item_format: (settings) => settings.item_format,
  history_missing_stream_policy: (settings) => settings.history.missing_stream,
  sprint_release_format_policy: (settings) => settings.validation.sprint_release_format,
  parent_reference_policy: (settings) => settings.validation.parent_reference,
  metadata_validation_profile: (settings) => settings.validation.metadata_profile,
  metadata_required_fields: (settings) => [...settings.validation.metadata_required_fields],
  lifecycle_stale_blocker_reason_patterns: (settings) => [
    ...settings.validation.lifecycle_stale_blocker_reason_patterns,
  ],
  lifecycle_closure_like_blocked_reason_patterns: (settings) => [
    ...settings.validation.lifecycle_closure_like_blocked_reason_patterns,
  ],
  lifecycle_closure_like_resolution_patterns: (settings) => [
    ...settings.validation.lifecycle_closure_like_resolution_patterns,
  ],
  lifecycle_closure_like_actual_result_patterns: (settings) => [
    ...settings.validation.lifecycle_closure_like_actual_result_patterns,
  ],
  governance_preset: (settings) => settings.governance.preset,
  governance_ownership_enforcement: (settings) => settings.governance.ownership_enforcement,
  governance_create_mode_default: (settings) => settings.governance.create_mode_default,
  governance_close_validation_default: (settings) => settings.governance.close_validation_default,
  governance_require_close_reason: (settings) => settings.governance.require_close_reason ? "enabled" : "disabled",
  governance_create_default_type: (settings) => settings.governance.create_default_type ?? "",
  governance_workflow_enforcement: (settings) => settings.governance.workflow_enforcement ?? "off",
  governance_parent_reference_policy: (settings) => settings.governance.parent_reference,
  governance_metadata_validation_profile: (settings) => settings.governance.metadata_profile,
  governance_force_required_for_stale_lock: (settings) =>
    settings.governance.force_required_for_stale_lock ? "enabled" : "disabled",
  test_result_tracking: (settings) => settings.testing.record_results_to_items ? "enabled" : "disabled",
  telemetry_tracking: (settings) => settings.telemetry.enabled ? "enabled" : "disabled",
  context: (settings) => ({
    default_depth: settings.context.default_depth,
    activity_limit: settings.context.activity_limit,
    stale_threshold_days: settings.context.stale_threshold_days,
    sections: { ...settings.context.sections },
  }),
};

function readConfigValue(settings: PmSettings, key: ConfigKey): ConfigValue {
  return CONFIG_VALUE_READERS[key](settings);
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

function parseSectionToggle(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "enabled" || normalized === "on" || normalized === "1") return true;
  if (normalized === "false" || normalized === "disabled" || normalized === "off" || normalized === "0") return false;
  throw new PmCliError(
    `Context section toggle must be true|false|enabled|disabled, got "${raw}"`,
    EXIT_CODE.USAGE,
  );
}

async function applyContextConfig(
  settings: PmSettings,
  options: ConfigCommandOptions,
  target: { pmRoot: string; settingsPath: string },
  scope: ConfigScope,
  warnings: string[],
): Promise<ConfigResult> {
  let changed = false;
  const ctx = settings.context;

  if (options.defaultDepth !== undefined) {
    const normalized = options.defaultDepth.trim().toLowerCase();
    if (!CONTEXT_DEPTH_VALUES.includes(normalized as ContextDepth)) {
      throw new PmCliError(
        `Context --default-depth must be one of ${CONTEXT_DEPTH_VALUES.join("|")}`,
        EXIT_CODE.USAGE,
      );
    }
    if (ctx.default_depth !== normalized) {
      ctx.default_depth = normalized as ContextDepth;
      changed = true;
    }
  }

  if (options.activityLimit !== undefined) {
    const parsed = parseInt(options.activityLimit.trim(), 10);
    if (isNaN(parsed) || parsed <= 0) {
      throw new PmCliError("Context --activity-limit must be a positive integer", EXIT_CODE.USAGE);
    }
    if (ctx.activity_limit !== parsed) {
      ctx.activity_limit = parsed;
      changed = true;
    }
  }

  if (options.staleThresholdDays !== undefined) {
    const parsed = parseInt(options.staleThresholdDays.trim(), 10);
    if (isNaN(parsed) || parsed <= 0) {
      throw new PmCliError("Context --stale-threshold-days must be a positive integer", EXIT_CODE.USAGE);
    }
    if (ctx.stale_threshold_days !== parsed) {
      ctx.stale_threshold_days = parsed;
      changed = true;
    }
  }

  const sectionToggles: [string, string | undefined][] = [
    ["hierarchy", options.sectionHierarchy],
    ["activity", options.sectionActivity],
    ["progress", options.sectionProgress],
    ["blockers", options.sectionBlockers],
    ["files", options.sectionFiles],
    ["workload", options.sectionWorkload],
    ["staleness", options.sectionStaleness],
    ["tests", options.sectionTests],
  ];

  for (const [sectionName, rawValue] of sectionToggles) {
    const toggle = parseSectionToggle(rawValue);
    if (toggle !== undefined) {
      const key = sectionName as keyof typeof ctx.sections;
      if (ctx.sections[key] !== toggle) {
        ctx.sections[key] = toggle;
        changed = true;
      }
    }
  }

  if (changed) {
    await writeSettings(target.pmRoot, settings, "config:set:context");
  }

  return withWarnings({
    scope,
    key: "context",
    context_settings: {
      default_depth: ctx.default_depth,
      activity_limit: ctx.activity_limit,
      stale_threshold_days: ctx.stale_threshold_days,
      sections: { ...ctx.sections },
    },
    settings_path: target.settingsPath,
    changed,
  }, warnings);
}

function applyNestedSettingPositionalValue(
  keyValue: string,
  valueValue: string,
  options: ConfigCommandOptions,
): ConfigCommandOptions {
  if (options.value !== undefined && options.value !== valueValue) {
    throw new PmCliError(
      `Config set ${keyValue} received both positional value "${valueValue}" and --value "${options.value}". Pass only one.`,
      EXIT_CODE.USAGE,
    );
  }
  return { ...options, value: valueValue };
}

/**
 * Route an intuitive `pm config set <key> <value>` positional value onto the typed
 * flag it belongs to (--format/--policy/--criterion), applying enabled/disabled
 * synonyms. Returns the (possibly augmented) options. The typed-flag forms keep
 * working exactly as before: a positional value is only injected when its flag was
 * not already supplied, and a conflicting explicit flag is a clear error.
 */
function applyPositionalValue(
  action: ConfigAction,
  keyValue: string | undefined,
  normalizedKey: ConfigKey | undefined,
  nestedSetting: NestedSettingDescriptor | undefined,
  valueValue: string | undefined,
  options: ConfigCommandOptions,
): ConfigCommandOptions {
  if (valueValue === undefined) {
    return options;
  }
  if (action !== "set") {
    throw new PmCliError(
      `Config action "${action}" does not accept a positional value. Only "set" takes <value>.`,
      EXIT_CODE.USAGE,
    );
  }
  if (typeof keyValue !== "string" || keyValue.trim().length === 0) {
    throw new PmCliError('Config action "set" requires <key> before a positional <value>.', EXIT_CODE.USAGE);
  }

  if (nestedSetting) {
    return applyNestedSettingPositionalValue(keyValue, valueValue, options);
  }

  assertConfigKeyDefined(normalizedKey);
  const routed = resolveConfigPositionalValue(normalizedKey, valueValue);
  if (!routed.routable) {
    throw new PmCliError(routed.reason, EXIT_CODE.USAGE);
  }

  if (routed.flag === "criterion") {
    if (options.criterion !== undefined && options.criterion.length > 0) {
      throw new PmCliError(
        `Config set ${keyValue} received both positional value "${valueValue}" and --criterion. Pass criteria via --criterion only when supplying more than one value.`,
        EXIT_CODE.USAGE,
      );
    }
    return { ...options, criterion: routed.values };
  }

  if (routed.flag === "format") {
    /* c8 ignore start -- only `toon` is valid, so normalized explicit/positional formats cannot conflict. */
    if (
      options.format !== undefined &&
      normalizeItemFormat(options.format) !== normalizeItemFormat(routed.value)
    ) {
      throw new PmCliError(
        `Config set ${keyValue} received both positional value "${valueValue}" and --format "${options.format}". Pass only one.`,
        EXIT_CODE.USAGE,
      );
    }
    /* c8 ignore stop */
    return { ...options, format: routed.value };
  }

  // policy flag (--policy)
  if (
    options.policy !== undefined &&
    normalizePolicyForConflict(normalizedKey, options.policy) !==
      normalizePolicyForConflict(normalizedKey, routed.value)
  ) {
    throw new PmCliError(
      `Config set ${keyValue} received both positional value "${valueValue}" and --policy "${options.policy}". Pass only one.`,
      EXIT_CODE.USAGE,
    );
  }
  return { ...options, policy: routed.value };
}

interface ConfigExecutionContext {
  scope: ConfigScope;
  target: { pmRoot: string; settingsPath: string };
  settings: PmSettings;
  metadata: { has_explicit_item_format: boolean };
  warnings: string[];
}

function buildConfigListResult(context: ConfigExecutionContext): ConfigResult {
  const keys = (Object.keys(CONFIG_KEY_ALIASES) as ConfigKey[]).map((candidate) => ({
    key: candidate,
    aliases: CONFIG_KEY_ALIASES[candidate],
    value_kind: candidate === "context"
      ? ("object" as const)
      : isCriteriaConfigKey(candidate) ? ("string_array" as const) : ("enum" as const),
    set_flags:
      candidate === "context"
        ? ["--default-depth", "--activity-limit", "--stale-threshold-days", "--section-<name>"]
        : isCriteriaConfigKey(candidate) ? ["--criterion", "--clear-criteria"] : candidate === "item_format" ? ["--format"] : ["--policy"],
    summary: CONFIG_KEY_SUMMARIES[candidate],
    value: readConfigValue(context.settings, candidate),
  }));
  const nestedSettings: NestedSettingResultValue[] = NESTED_SETTING_DESCRIPTORS.map((descriptor) => ({
    key: descriptor.key,
    path: descriptor.path,
    kind: descriptor.kind,
    value: readNestedSettingValue(context.settings, descriptor),
  }));
  return withWarnings(
    {
      scope: context.scope,
      keys,
      nested_settings: nestedSettings,
      count: keys.length,
      settings_path: context.target.settingsPath,
      changed: false,
    },
    context.warnings,
  );
}

function buildConfigExportResult(context: ConfigExecutionContext): ConfigResult {
  const values = Object.fromEntries(
    (Object.keys(CONFIG_KEY_ALIASES) as ConfigKey[]).map((key) => [key, readConfigValue(context.settings, key)]),
  ) as Record<ConfigKey, ConfigValue>;
  return withWarnings(
    {
      scope: context.scope,
      values,
      settings_path: context.target.settingsPath,
      changed: false,
    },
    context.warnings,
  );
}

function buildConfigGetResult(context: ConfigExecutionContext, key: ConfigKey): ConfigResult {
  const value = readConfigValue(context.settings, key);
  const base = {
    scope: context.scope,
    key,
    settings_path: context.target.settingsPath,
    changed: false,
  };
  if (key === "item_format") {
    return withWarnings(
      {
        ...base,
        format: context.settings.item_format,
        has_explicit_item_format: context.metadata.has_explicit_item_format,
      },
      context.warnings,
    );
  }
  if (key === "context") {
    return withWarnings({ ...base, context_settings: value as ContextConfigValue }, context.warnings);
  }
  if (Array.isArray(value)) {
    return withWarnings({ ...base, criteria: value }, context.warnings);
  }
  return withWarnings({ ...base, policy: value as ConfigResult["policy"] }, context.warnings);
}

async function buildNestedSettingResult(
  context: ConfigExecutionContext,
  action: ConfigAction,
  nestedSetting: NestedSettingDescriptor,
  options: ConfigCommandOptions,
): Promise<ConfigResult> {
  if (action === "get") {
    const currentValue = readNestedSettingValue(context.settings, nestedSetting);
    return withWarnings(
      {
        scope: context.scope,
        key: nestedSetting.key,
        nested_setting: {
          key: nestedSetting.key,
          path: nestedSetting.path,
          kind: nestedSetting.kind,
          value: currentValue,
        },
        settings_path: context.target.settingsPath,
        changed: false,
      },
      context.warnings,
    );
  }

  const rawValue = options.value;
  if (typeof rawValue !== "string") {
    throw new PmCliError(
      `Config set ${nestedSetting.key} requires a value. Pass it positionally (\`pm config ${context.scope} set ${nestedSetting.key} <value>\`) or via --value.`,
      EXIT_CODE.USAGE,
    );
  }
  const parsed = parseNestedSettingValue(nestedSetting, rawValue);
  if (!parsed.ok) {
    throw new PmCliError(parsed.error.message, EXIT_CODE.USAGE);
  }
  const changed = writeNestedSettingValue(
    context.settings as unknown as Record<string, unknown>,
    nestedSetting,
    parsed.parsed.value,
  );
  if (changed) {
    await writeSettings(context.target.pmRoot, context.settings, `config:set:${nestedSetting.path}`);
  }
  return withWarnings(
    {
      scope: context.scope,
      key: nestedSetting.key,
      nested_setting: {
        key: nestedSetting.key,
        path: nestedSetting.path,
        kind: nestedSetting.kind,
        value: parsed.parsed.value,
      },
      settings_path: context.target.settingsPath,
      changed,
    },
    context.warnings,
  );
}

async function writeConfigSettingsIfChanged(
  context: ConfigExecutionContext,
  changed: boolean,
  reason: string,
): Promise<void> {
  if (changed) {
    await writeSettings(context.target.pmRoot, context.settings, reason);
  }
}

function buildPolicyResult(
  context: ConfigExecutionContext,
  key: ConfigKey,
  policy: ConfigResult["policy"],
  changed: boolean,
): ConfigResult {
  return withWarnings(
    {
      scope: context.scope,
      key,
      policy,
      settings_path: context.target.settingsPath,
      changed,
    },
    context.warnings,
  );
}

function buildCriteriaResult(
  context: ConfigExecutionContext,
  key: ConfigKey,
  criteria: string[],
  changed: boolean,
): ConfigResult {
  return withWarnings(
    {
      scope: context.scope,
      key,
      criteria,
      settings_path: context.target.settingsPath,
      changed,
    },
    context.warnings,
  );
}

async function setItemFormatConfig(context: ConfigExecutionContext, options: ConfigCommandOptions): Promise<ConfigResult> {
  const nextFormat = normalizeItemFormat(options.format);
  const changed = context.settings.item_format !== nextFormat || !context.metadata.has_explicit_item_format;
  let migration: ConfigResult["migration"] = undefined;
  if (changed) {
    const typeRegistry = resolveItemTypeRegistry(context.settings, getActiveExtensionRegistrations());
    const migrated = await migrateItemFilesToFormat(
      context.target.pmRoot,
      nextFormat,
      "config:set:item_format:migrate",
      typeRegistry.type_to_folder,
      context.settings.schema,
    );
    migration = {
      target_format: migrated.target_format,
      scanned: migrated.scanned,
      migrated: migrated.migrated,
      removed: migrated.removed,
      warnings: migrated.warnings,
    };
    context.settings.item_format = nextFormat;
    await writeSettings(context.target.pmRoot, context.settings, "config:set:item_format");
  }
  return withWarnings(
    {
      scope: context.scope,
      key: "item_format",
      format: context.settings.item_format,
      has_explicit_item_format: true,
      migration,
      settings_path: context.target.settingsPath,
      changed,
    },
    context.warnings,
  );
}

async function setValidationConfig(
  context: ConfigExecutionContext,
  key: ValidationConfigKey,
  options: ConfigCommandOptions,
): Promise<ConfigResult> {
  if (key === "history_missing_stream_policy") {
    const nextPolicy = normalizeHistoryMissingStreamPolicy(options.policy);
    const changed = context.settings.history.missing_stream !== nextPolicy;
    context.settings.history.missing_stream = nextPolicy;
    await writeConfigSettingsIfChanged(context, changed, "config:set:history_missing_stream_policy");
    return buildPolicyResult(context, key, context.settings.history.missing_stream, changed);
  }
  if (key === "sprint_release_format_policy") {
    const nextPolicy = normalizeSprintReleaseFormatPolicy(options.policy);
    const changed = context.settings.validation.sprint_release_format !== nextPolicy;
    context.settings.validation.sprint_release_format = nextPolicy;
    await writeConfigSettingsIfChanged(context, changed, "config:set:sprint_release_format_policy");
    return buildPolicyResult(context, key, context.settings.validation.sprint_release_format, changed);
  }
  if (key === "parent_reference_policy") {
    const nextPolicy = normalizeParentReferencePolicy(options.policy);
    const changed =
      context.settings.validation.parent_reference !== nextPolicy ||
      context.settings.governance.preset !== "custom" ||
      context.settings.governance.parent_reference !== nextPolicy;
    context.settings.validation.parent_reference = nextPolicy;
    context.settings.governance.preset = "custom";
    context.settings.governance.parent_reference = nextPolicy;
    await writeConfigSettingsIfChanged(context, changed, "config:set:parent_reference_policy");
    return buildPolicyResult(context, key, context.settings.validation.parent_reference, changed);
  }
  const nextPolicy = normalizeValidateMetadataProfile(options.policy);
  const changed =
    context.settings.validation.metadata_profile !== nextPolicy ||
    context.settings.governance.preset !== "custom" ||
    context.settings.governance.metadata_profile !== nextPolicy;
  context.settings.validation.metadata_profile = nextPolicy;
  context.settings.governance.preset = "custom";
  context.settings.governance.metadata_profile = nextPolicy;
  await writeConfigSettingsIfChanged(context, changed, "config:set:metadata_validation_profile");
  return buildPolicyResult(context, key, context.settings.validation.metadata_profile, changed);
}

async function setCriteriaConfig(
  context: ConfigExecutionContext,
  key: CriteriaConfigKey,
  options: ConfigCommandOptions,
): Promise<ConfigResult> {
  if (key === "metadata_required_fields") {
    const nextCriteria = normalizeMetadataRequiredFields(options.criterion, options.clearCriteria);
    const changed =
      nextCriteria.length !== context.settings.validation.metadata_required_fields.length ||
      nextCriteria.some((value, index) => value !== context.settings.validation.metadata_required_fields[index]);
    context.settings.validation.metadata_required_fields = nextCriteria;
    await writeConfigSettingsIfChanged(context, changed, "config:set:metadata_required_fields");
    return buildCriteriaResult(context, key, [...context.settings.validation.metadata_required_fields], changed);
  }

  const lifecycleTargets: Record<LifecyclePatternConfigKey, string[]> = {
    lifecycle_stale_blocker_reason_patterns: context.settings.validation.lifecycle_stale_blocker_reason_patterns,
    lifecycle_closure_like_blocked_reason_patterns:
      context.settings.validation.lifecycle_closure_like_blocked_reason_patterns,
    lifecycle_closure_like_resolution_patterns:
      context.settings.validation.lifecycle_closure_like_resolution_patterns,
    lifecycle_closure_like_actual_result_patterns:
      context.settings.validation.lifecycle_closure_like_actual_result_patterns,
  };
  const currentCriteria = lifecycleTargets[key];

  const nextCriteria = normalizeLifecyclePatternCriteria(key, options.criterion, options.clearCriteria);
  const changed =
    nextCriteria.length !== currentCriteria.length ||
    nextCriteria.some((value, index) => value !== currentCriteria[index]);
  currentCriteria.splice(0, currentCriteria.length, ...nextCriteria);
  await writeConfigSettingsIfChanged(context, changed, `config:set:${key}`);
  return buildCriteriaResult(context, key, [...currentCriteria], changed);
}

async function setGovernancePresetOrTypeConfig(
  context: ConfigExecutionContext,
  key: GovernancePresetOrTypeConfigKey,
  options: ConfigCommandOptions,
): Promise<ConfigResult> {
  if (key === "governance_preset") {
    const nextPolicy = normalizeGovernancePreset(options.policy);
    const changed = context.settings.governance.preset !== nextPolicy;
    context.settings.governance.preset = nextPolicy;
    await writeConfigSettingsIfChanged(context, changed, "config:set:governance_preset");
    return buildPolicyResult(context, key, context.settings.governance.preset, changed);
  }

  const policyProvided = typeof options.policy === "string";
  const rawType = policyProvided ? options.policy!.trim() : "";
  if (policyProvided && rawType.length === 0) {
    const changed = context.settings.governance.create_default_type !== undefined;
    delete context.settings.governance.create_default_type;
    await writeConfigSettingsIfChanged(context, changed, "config:set:governance_create_default_type");
    return buildPolicyResult(context, key, context.settings.governance.create_default_type ?? "", changed);
  }
  if (rawType.length === 0) {
    throw new PmCliError(
      'Config set governance-create-default-type requires an item type value (or an empty value "" to clear it)',
      EXIT_CODE.USAGE,
    );
  }
  const typeRegistry = resolveItemTypeRegistry(context.settings, getActiveExtensionRegistrations());
  const resolvedType = resolveTypeName(rawType, typeRegistry);
  if (!resolvedType) {
    throw new PmCliError(
      buildInvalidTypeError(rawType, typeRegistry.types, resolveItemTypesFilePath(context.target.pmRoot, context.settings.schema)),
      EXIT_CODE.USAGE,
    );
  }
  const changed = context.settings.governance.create_default_type !== resolvedType;
  context.settings.governance.create_default_type = resolvedType;
  await writeConfigSettingsIfChanged(context, changed, "config:set:governance_create_default_type");
  return buildPolicyResult(context, key, context.settings.governance.create_default_type, changed);
}

async function setGovernancePolicyConfig(
  context: ConfigExecutionContext,
  key: GovernancePolicyConfigKey,
  options: ConfigCommandOptions,
): Promise<ConfigResult> {
  if (key === "governance_ownership_enforcement") {
    const nextPolicy = normalizeGovernanceOwnershipEnforcement(options.policy);
    const changed =
      context.settings.governance.preset !== "custom" ||
      context.settings.governance.ownership_enforcement !== nextPolicy;
    context.settings.governance.preset = "custom";
    context.settings.governance.ownership_enforcement = nextPolicy;
    await writeConfigSettingsIfChanged(context, changed, "config:set:governance_ownership_enforcement");
    return buildPolicyResult(context, key, context.settings.governance.ownership_enforcement, changed);
  }
  if (key === "governance_create_mode_default") {
    const nextPolicy = normalizeGovernanceCreateModeDefault(options.policy);
    const changed =
      context.settings.governance.preset !== "custom" ||
      context.settings.governance.create_mode_default !== nextPolicy;
    context.settings.governance.preset = "custom";
    context.settings.governance.create_mode_default = nextPolicy;
    await writeConfigSettingsIfChanged(context, changed, "config:set:governance_create_mode_default");
    return buildPolicyResult(context, key, context.settings.governance.create_mode_default, changed);
  }
  const nextPolicy = normalizeGovernanceCloseValidationDefault(options.policy);
  const changed =
    context.settings.governance.preset !== "custom" ||
    context.settings.governance.close_validation_default !== nextPolicy;
  context.settings.governance.preset = "custom";
  context.settings.governance.close_validation_default = nextPolicy;
  await writeConfigSettingsIfChanged(context, changed, "config:set:governance_close_validation_default");
  return buildPolicyResult(context, key, context.settings.governance.close_validation_default, changed);
}

async function setGovernanceValidationConfig(
  context: ConfigExecutionContext,
  key: GovernanceValidationConfigKey,
  options: ConfigCommandOptions,
): Promise<ConfigResult> {
  if (key === "governance_parent_reference_policy") {
    const nextPolicy = normalizeParentReferencePolicy(options.policy);
    const changed =
      context.settings.governance.preset !== "custom" ||
      context.settings.governance.parent_reference !== nextPolicy;
    context.settings.governance.preset = "custom";
    context.settings.governance.parent_reference = nextPolicy;
    context.settings.validation.parent_reference = nextPolicy;
    await writeConfigSettingsIfChanged(context, changed, "config:set:governance_parent_reference_policy");
    return buildPolicyResult(context, key, context.settings.governance.parent_reference, changed);
  }
  if (key === "governance_metadata_validation_profile") {
    const nextPolicy = normalizeValidateMetadataProfile(options.policy);
    const changed =
      context.settings.governance.preset !== "custom" ||
      context.settings.governance.metadata_profile !== nextPolicy;
    context.settings.governance.preset = "custom";
    context.settings.governance.metadata_profile = nextPolicy;
    context.settings.validation.metadata_profile = nextPolicy;
    await writeConfigSettingsIfChanged(context, changed, "config:set:governance_metadata_validation_profile");
    return buildPolicyResult(context, key, context.settings.governance.metadata_profile, changed);
  }
  const nextPolicy = normalizeGovernanceWorkflowEnforcement(options.policy);
  const changed = (context.settings.governance.workflow_enforcement ?? "off") !== nextPolicy;
  context.settings.governance.workflow_enforcement = nextPolicy;
  await writeConfigSettingsIfChanged(context, changed, "config:set:governance_workflow_enforcement");
  return buildPolicyResult(context, key, context.settings.governance.workflow_enforcement, changed);
}

async function setGovernanceBooleanConfig(
  context: ConfigExecutionContext,
  key: ConfigKey,
  options: ConfigCommandOptions,
): Promise<ConfigResult> {
  if (key === "governance_require_close_reason") {
    const nextPolicy = normalizeGovernanceRequireCloseReasonPolicy(options.policy);
    const nextEnabled = nextPolicy === "enabled";
    const changed = context.settings.governance.require_close_reason !== nextEnabled;
    context.settings.governance.require_close_reason = nextEnabled;
    await writeConfigSettingsIfChanged(context, changed, "config:set:governance_require_close_reason");
    return buildPolicyResult(context, key, context.settings.governance.require_close_reason ? "enabled" : "disabled", changed);
  }
  const nextPolicy = normalizeGovernanceForceRequiredForStaleLockPolicy(options.policy);
  const nextEnabled = nextPolicy === "enabled";
  const changed =
    context.settings.governance.preset !== "custom" ||
    context.settings.governance.force_required_for_stale_lock !== nextEnabled;
  context.settings.governance.preset = "custom";
  context.settings.governance.force_required_for_stale_lock = nextEnabled;
  await writeConfigSettingsIfChanged(context, changed, "config:set:governance_force_required_for_stale_lock");
  return buildPolicyResult(
    context,
    key,
    context.settings.governance.force_required_for_stale_lock ? "enabled" : "disabled",
    changed,
  );
}

async function setTrackingConfig(
  context: ConfigExecutionContext,
  key: ConfigKey,
  options: ConfigCommandOptions,
): Promise<ConfigResult> {
  if (key === "test_result_tracking") {
    const nextPolicy = normalizeTestResultTrackingPolicy(options.policy);
    const nextEnabled = nextPolicy === "enabled";
    const changed = context.settings.testing.record_results_to_items !== nextEnabled;
    context.settings.testing.record_results_to_items = nextEnabled;
    await writeConfigSettingsIfChanged(context, changed, "config:set:test_result_tracking");
    return buildPolicyResult(context, key, context.settings.testing.record_results_to_items ? "enabled" : "disabled", changed);
  }
  const nextPolicy = normalizeTelemetryTrackingPolicy(options.policy);
  const nextEnabled = nextPolicy === "enabled";
  const changed =
    context.settings.telemetry.enabled !== nextEnabled ||
    !context.settings.telemetry.first_run_prompt_completed;
  context.settings.telemetry.enabled = nextEnabled;
  context.settings.telemetry.first_run_prompt_completed = true;
  await writeConfigSettingsIfChanged(context, changed, "config:set:telemetry_tracking");
  return buildPolicyResult(context, key, context.settings.telemetry.enabled ? "enabled" : "disabled", changed);
}

async function setDefinitionOfDoneConfig(
  context: ConfigExecutionContext,
  key: ConfigKey,
  options: ConfigCommandOptions,
): Promise<ConfigResult> {
  const nextCriteria = normalizeCriteria(options.criterion, options.clearCriteria);
  const changed =
    nextCriteria.length !== context.settings.workflow.definition_of_done.length ||
    nextCriteria.some((value, index) => value !== context.settings.workflow.definition_of_done[index]);
  context.settings.workflow.definition_of_done = nextCriteria;
  await writeConfigSettingsIfChanged(context, changed, "config:set:definition_of_done");
  return buildCriteriaResult(context, key, [...context.settings.workflow.definition_of_done], changed);
}

async function setConfigValue(
  context: ConfigExecutionContext,
  key: ConfigKey,
  options: ConfigCommandOptions,
): Promise<ConfigResult> {
  if (options.clearCriteria === true && !isCriteriaConfigKey(key)) {
    throw new PmCliError("--clear-criteria is only supported with config set criteria-list keys", EXIT_CODE.USAGE);
  }
  if (key === "item_format") {
    return setItemFormatConfig(context, options);
  }
  if (key === "context") {
    return applyContextConfig(context.settings, options, context.target, context.scope, context.warnings);
  }
  if (key === "definition_of_done") {
    return setDefinitionOfDoneConfig(context, key, options);
  }
  if (isCriteriaValueConfigKey(key)) {
    return setCriteriaConfig(context, key, options);
  }
  if (TRACKING_CONFIG_KEYS.has(key)) {
    return setTrackingConfig(context, key, options);
  }
  if (GOVERNANCE_BOOLEAN_CONFIG_KEYS.has(key)) {
    return setGovernanceBooleanConfig(context, key, options);
  }
  if (isGovernancePolicyConfigKey(key)) {
    return setGovernancePolicyConfig(context, key, options);
  }
  if (isGovernanceValidationConfigKey(key)) {
    return setGovernanceValidationConfig(context, key, options);
  }
  if (isGovernancePresetOrTypeConfigKey(key)) {
    return setGovernancePresetOrTypeConfig(context, key, options);
  }
  return setValidationConfig(context, key as ValidationConfigKey, options);
}

/**
 * Implements run config for the public runtime surface of this module.
 */
export async function runConfig(
  scopeValue: string,
  actionValue: string,
  keyValue: string | undefined,
  options: ConfigCommandOptions,
  global: GlobalOptions,
  valueValue?: string,
): Promise<ConfigResult> {
  const scope = normalizeScope(scopeValue);
  const action = normalizeAction(actionValue);
  const nestedSetting =
    (action === "get" || action === "set") ? resolveNestedSettingDescriptor(keyValue) : undefined;
  const key = nestedSetting ? undefined : normalizeKeyForAction(action, keyValue);
  const routedOptions = applyPositionalValue(action, keyValue, key, nestedSetting, valueValue, options);
  const target = await resolveSettingsTarget(scope, global);
  const { settings, metadata, warnings: settingsReadWarnings } = await readSettingsWithMetadata(target.pmRoot);
  const context: ConfigExecutionContext = {
    scope,
    target,
    settings,
    metadata,
    warnings: normalizeWarnings(settingsReadWarnings),
  };

  if (nestedSetting) {
    return buildNestedSettingResult(context, action, nestedSetting, routedOptions);
  }
  if (action === "list") {
    return buildConfigListResult(context);
  }
  if (action === "export") {
    return buildConfigExportResult(context);
  }

  assertConfigKeyDefined(key);
  return action === "get" ? buildConfigGetResult(context, key) : setConfigValue(context, key, routedOptions);
}

export const _testOnlyConfigCommand = {
  applyPositionalValue,
  normalizeAction,
  normalizeCriteria,
  normalizeGovernanceCloseValidationDefault,
  normalizeGovernanceCreateModeDefault,
  normalizeGovernanceForceRequiredForStaleLockPolicy,
  normalizeGovernanceOwnershipEnforcement,
  normalizeGovernancePreset,
  normalizeGovernanceRequireCloseReasonPolicy,
  normalizeGovernanceWorkflowEnforcement,
  normalizeHistoryMissingStreamPolicy,
  normalizeItemFormat,
  normalizeKey,
  normalizeMetadataRequiredFields,
  normalizePolicyForConflict,
  normalizeScope,
  normalizeTelemetryTrackingPolicy,
  normalizeTestResultTrackingPolicy,
  normalizeValidateMetadataProfile,
  normalizeWarnings,
};
