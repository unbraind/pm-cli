import { validateSettings, type ParsedSettings } from "./settings-validator.js";
import { runActiveOnReadHooks, runActiveOnWriteHooks } from "../extensions/index.js";
import { GOVERNANCE_PRESET_DEFAULTS, SETTINGS_DEFAULTS } from "../shared/constants.js";
import { readFileIfExists, writeFileAtomic } from "../fs/fs-utils.js";
import {
  ensureRuntimeSchemaFileScaffold,
  loadRuntimeSchemaFromOptionalFiles,
  normalizeRuntimeSchemaSettings,
} from "../schema/runtime-schema.js";
import { getSettingsPath } from "./paths.js";
import { orderObject } from "../shared/serialization.js";
import type {
  ExtensionSandboxProfile,
  ExtensionPolicyMode,
  ExtensionPolicyOverrideSettings,
  ExtensionPolicySettings,
  ExtensionTrustMode,
  GovernanceSettings,
  ItemTypeCommandOptionPolicy,
  ItemTypeDefinition,
  ItemTypeOptionDefinition,
  PmSettings,
  GovernancePreset,
  ValidateMetadataRequiredField,
} from "../../types/index.js";

const SETTINGS_WRITE_OP = "settings:write";

export interface SettingsReadMetadata {
  has_explicit_item_format: boolean;
}

export interface SettingsReadResult {
  settings: PmSettings;
  metadata: SettingsReadMetadata;
  warnings: string[];
}

function resolveGovernanceKnobsFromPreset(preset: Exclude<GovernancePreset, "custom">): Omit<GovernanceSettings, "preset"> {
  return structuredClone(GOVERNANCE_PRESET_DEFAULTS[preset]);
}

function normalizeGovernancePreset(value: GovernancePreset | undefined): GovernancePreset {
  if (value === "minimal" || value === "default" || value === "strict" || value === "custom") {
    return value;
  }
  return SETTINGS_DEFAULTS.governance.preset;
}

function normalizeGovernanceForPersist(governance: GovernanceSettings): Partial<GovernanceSettings> & { preset: GovernancePreset } {
  if (governance.preset === "custom") {
    return {
      preset: "custom",
      ownership_enforcement: governance.ownership_enforcement,
      create_mode_default: governance.create_mode_default,
      close_validation_default: governance.close_validation_default,
      parent_reference: governance.parent_reference,
      metadata_profile: governance.metadata_profile,
      force_required_for_stale_lock: governance.force_required_for_stale_lock,
    };
  }
  return {
    preset: governance.preset,
  };
}

export function resolveGovernanceKnobs(
  settings: Pick<PmSettings, "governance"> | { governance?: Partial<GovernanceSettings> },
): GovernanceSettings {
  const rawGovernance = settings.governance ?? {};
  const preset = normalizeGovernancePreset(rawGovernance.preset);
  if (preset === "custom") {
    const baseline = resolveGovernanceKnobsFromPreset("default");
    return {
      preset,
      ownership_enforcement: rawGovernance.ownership_enforcement ?? baseline.ownership_enforcement,
      create_mode_default: rawGovernance.create_mode_default ?? baseline.create_mode_default,
      close_validation_default: rawGovernance.close_validation_default ?? baseline.close_validation_default,
      parent_reference: rawGovernance.parent_reference ?? baseline.parent_reference,
      metadata_profile: rawGovernance.metadata_profile ?? baseline.metadata_profile,
      force_required_for_stale_lock: rawGovernance.force_required_for_stale_lock ?? baseline.force_required_for_stale_lock,
    };
  }
  return {
    preset,
    ...resolveGovernanceKnobsFromPreset(preset),
  };
}

function cloneDefaults(): PmSettings {
  return structuredClone(SETTINGS_DEFAULTS);
}

function buildFallbackSettingsReadResult(warning?: string): SettingsReadResult {
  return {
    settings: cloneDefaults(),
    metadata: {
      has_explicit_item_format: false,
    },
    warnings: warning ? [warning] : [],
  };
}

function hasExplicitItemFormat(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return false;
  }
  const itemFormat = (raw as Record<string, unknown>).item_format;
  return itemFormat === "toon" || itemFormat === "json_markdown";
}

function normalizeStringList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter((value) => value.length > 0))].sort((left, right) =>
    left.localeCompare(right),
  );
}

function normalizeAgentGuidanceSettings(
  value: Partial<PmSettings["agent_guidance"]> | undefined,
): PmSettings["agent_guidance"] {
  const defaults = SETTINGS_DEFAULTS.agent_guidance;
  const templateVersion = value?.template_version;
  return {
    prompt_completed: value?.prompt_completed === true,
    declined: value?.declined === true,
    declined_at: typeof value?.declined_at === "string" ? value.declined_at : defaults.declined_at,
    template_version:
      typeof templateVersion === "number" && Number.isInteger(templateVersion) && templateVersion > 0
        ? templateVersion
        : defaults.template_version,
    last_checked_files: normalizeStringList(value?.last_checked_files ?? defaults.last_checked_files),
  };
}

function normalizeLowerStringList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim().toLowerCase()).filter((value) => value.length > 0))].sort(
    (left, right) => left.localeCompare(right),
  );
}

function normalizeExtensionPolicyMode(value: ExtensionPolicyMode | undefined): ExtensionPolicyMode {
  if (value === "off" || value === "warn" || value === "enforce") {
    return value;
  }
  return SETTINGS_DEFAULTS.extensions.policy.mode;
}

function normalizeExtensionTrustMode(value: ExtensionTrustMode | undefined): ExtensionTrustMode {
  if (value === "off" || value === "warn" || value === "enforce") {
    return value;
  }
  return SETTINGS_DEFAULTS.extensions.policy.trust_mode;
}

function normalizeExtensionSandboxProfile(value: ExtensionSandboxProfile | undefined): ExtensionSandboxProfile {
  if (value === "none" || value === "restricted" || value === "strict") {
    return value;
  }
  return SETTINGS_DEFAULTS.extensions.policy.default_sandbox_profile;
}

function normalizeExtensionPolicyOverride(
  override: ExtensionPolicyOverrideSettings,
): ExtensionPolicyOverrideSettings | null {
  const name = override.name.trim().toLowerCase();
  if (name.length === 0) {
    return null;
  }
  const normalized: ExtensionPolicyOverrideSettings = {
    name,
  };
  if (override.disabled === true) {
    normalized.disabled = true;
  }
  if (override.require_trusted === true) {
    normalized.require_trusted = true;
  }
  if (override.require_provenance === true) {
    normalized.require_provenance = true;
  }
  if (override.sandbox_profile !== undefined) {
    normalized.sandbox_profile = normalizeExtensionSandboxProfile(override.sandbox_profile);
  }
  const allowedCapabilities = normalizeLowerStringList(override.allowed_capabilities);
  const blockedCapabilities = normalizeLowerStringList(override.blocked_capabilities);
  const allowedSurfaces = normalizeLowerStringList(override.allowed_surfaces);
  const blockedSurfaces = normalizeLowerStringList(override.blocked_surfaces);
  const allowedCommands = normalizeLowerStringList(override.allowed_commands);
  const blockedCommands = normalizeLowerStringList(override.blocked_commands);
  const allowedActions = normalizeLowerStringList(override.allowed_actions);
  const blockedActions = normalizeLowerStringList(override.blocked_actions);
  const allowedServices = normalizeLowerStringList(override.allowed_services);
  const blockedServices = normalizeLowerStringList(override.blocked_services);
  if (allowedCapabilities.length > 0) {
    normalized.allowed_capabilities = allowedCapabilities;
  }
  if (blockedCapabilities.length > 0) {
    normalized.blocked_capabilities = blockedCapabilities;
  }
  if (allowedSurfaces.length > 0) {
    normalized.allowed_surfaces = allowedSurfaces;
  }
  if (blockedSurfaces.length > 0) {
    normalized.blocked_surfaces = blockedSurfaces;
  }
  if (allowedCommands.length > 0) {
    normalized.allowed_commands = allowedCommands;
  }
  if (blockedCommands.length > 0) {
    normalized.blocked_commands = blockedCommands;
  }
  if (allowedActions.length > 0) {
    normalized.allowed_actions = allowedActions;
  }
  if (blockedActions.length > 0) {
    normalized.blocked_actions = blockedActions;
  }
  if (allowedServices.length > 0) {
    normalized.allowed_services = allowedServices;
  }
  if (blockedServices.length > 0) {
    normalized.blocked_services = blockedServices;
  }
  return normalized;
}

function normalizeExtensionPolicyOverrides(
  overrides: ExtensionPolicyOverrideSettings[] | undefined,
): ExtensionPolicyOverrideSettings[] {
  const dedupedByName = new Map<string, ExtensionPolicyOverrideSettings>();
  for (const override of overrides ?? []) {
    const normalized = normalizeExtensionPolicyOverride(override);
    if (!normalized) {
      continue;
    }
    dedupedByName.set(normalized.name, normalized);
  }
  return [...dedupedByName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function normalizeExtensionPolicySettings(policy: Partial<ExtensionPolicySettings> | undefined): ExtensionPolicySettings {
  const defaults = SETTINGS_DEFAULTS.extensions.policy;
  return {
    mode: normalizeExtensionPolicyMode(policy?.mode),
    trust_mode: normalizeExtensionTrustMode(policy?.trust_mode),
    require_provenance: policy?.require_provenance === true,
    trusted_extensions: normalizeLowerStringList(policy?.trusted_extensions ?? defaults.trusted_extensions),
    default_sandbox_profile: normalizeExtensionSandboxProfile(policy?.default_sandbox_profile),
    allowed_extensions: normalizeLowerStringList(policy?.allowed_extensions ?? defaults.allowed_extensions),
    blocked_extensions: normalizeLowerStringList(policy?.blocked_extensions ?? defaults.blocked_extensions),
    allowed_capabilities: normalizeLowerStringList(policy?.allowed_capabilities ?? defaults.allowed_capabilities),
    blocked_capabilities: normalizeLowerStringList(policy?.blocked_capabilities ?? defaults.blocked_capabilities),
    allowed_surfaces: normalizeLowerStringList(policy?.allowed_surfaces ?? defaults.allowed_surfaces),
    blocked_surfaces: normalizeLowerStringList(policy?.blocked_surfaces ?? defaults.blocked_surfaces),
    allowed_commands: normalizeLowerStringList(policy?.allowed_commands ?? defaults.allowed_commands),
    blocked_commands: normalizeLowerStringList(policy?.blocked_commands ?? defaults.blocked_commands),
    allowed_actions: normalizeLowerStringList(policy?.allowed_actions ?? defaults.allowed_actions),
    blocked_actions: normalizeLowerStringList(policy?.blocked_actions ?? defaults.blocked_actions),
    allowed_services: normalizeLowerStringList(policy?.allowed_services ?? defaults.allowed_services),
    blocked_services: normalizeLowerStringList(policy?.blocked_services ?? defaults.blocked_services),
    extension_overrides: normalizeExtensionPolicyOverrides(policy?.extension_overrides ?? defaults.extension_overrides),
  };
}

function normalizeValidationMetadataRequiredFields(values: string[] | undefined): ValidateMetadataRequiredField[] {
  const normalized = [...new Set((values ?? []).map((value) => value.trim().toLowerCase().replaceAll("-", "_")))]
    .filter((value) => value.length > 0)
    .sort((left, right) => left.localeCompare(right));
  return normalized.filter((value): value is ValidateMetadataRequiredField =>
    [
      "author",
      "acceptance_criteria",
      "estimated_minutes",
      "close_reason",
      "reviewer",
      "risk",
      "confidence",
      "sprint",
      "release",
    ].includes(value),
  );
}

function normalizeValidationPatternList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim().toLowerCase()).filter((value) => value.length > 0))].sort(
    (left, right) => left.localeCompare(right),
  );
}

function normalizeItemTypeOptionDefinition(option: ItemTypeOptionDefinition): ItemTypeOptionDefinition | null {
  const key = option.key.trim();
  if (key.length === 0) {
    return null;
  }
  const values = normalizeStringList(option.values);
  const aliases = normalizeStringList(option.aliases);
  const description = option.description?.trim();
  return {
    key,
    values,
    required: option.required === true ? true : undefined,
    aliases: aliases.length > 0 ? aliases : undefined,
    description: description && description.length > 0 ? description : undefined,
  };
}

function normalizeItemTypeCommandOptionPolicy(
  policy: ItemTypeCommandOptionPolicy,
): ItemTypeCommandOptionPolicy | null {
  const option = policy.option.trim();
  if (option.length === 0) {
    return null;
  }
  return {
    command: policy.command,
    option,
    required: policy.required,
    visible: policy.visible,
    enabled: policy.enabled,
  };
}

function normalizeItemTypeDefinition(definition: ItemTypeDefinition): ItemTypeDefinition | null {
  const name = definition.name.trim();
  if (name.length === 0) {
    return null;
  }
  const hasRequiredCreateFields = definition.required_create_fields !== undefined;
  const hasRequiredCreateRepeatables = definition.required_create_repeatables !== undefined;
  const hasOptions = definition.options !== undefined;
  const hasCommandOptionPolicies = definition.command_option_policies !== undefined;
  const folder = definition.folder?.trim();
  const aliases = normalizeStringList(definition.aliases);
  const requiredCreateFields = normalizeStringList(definition.required_create_fields);
  const requiredCreateRepeatables = normalizeStringList(definition.required_create_repeatables);
  const options = (definition.options ?? [])
    .map((option) => normalizeItemTypeOptionDefinition(option))
    .filter((option): option is ItemTypeOptionDefinition => option !== null)
    .sort((left, right) => left.key.localeCompare(right.key));
  const commandOptionPolicies = (() => {
    const dedupedByKey = new Map<string, ItemTypeCommandOptionPolicy>();
    for (const policy of definition.command_option_policies ?? []) {
      const normalized = normalizeItemTypeCommandOptionPolicy(policy);
      if (!normalized) {
        continue;
      }
      dedupedByKey.set(`${normalized.command}:${normalized.option.toLowerCase()}`, normalized);
    }
    return [...dedupedByKey.values()].sort((left, right) =>
      left.command === right.command
        ? left.option.localeCompare(right.option)
        : left.command.localeCompare(right.command),
    );
  })();
  return {
    name,
    folder: folder && folder.length > 0 ? folder : undefined,
    aliases: aliases.length > 0 ? aliases : undefined,
    required_create_fields: hasRequiredCreateFields ? requiredCreateFields : undefined,
    required_create_repeatables: hasRequiredCreateRepeatables ? requiredCreateRepeatables : undefined,
    options: hasOptions ? options : undefined,
    command_option_policies: hasCommandOptionPolicies ? commandOptionPolicies : undefined,
  };
}

/**
 * Produce a normalized, deduplicated, and alphabetically ordered list of item type definitions.
 *
 * Treats `undefined` as an empty input and drops any invalid definitions. When multiple definitions
 * share the same name (case-insensitive), only one entry per name is kept. The returned list is
 * sorted by `name` using locale-aware string comparison.
 *
 * @param definitions - The input list of item type definitions to normalize (may be `undefined`)
 * @returns An array of validated `ItemTypeDefinition` objects with duplicates removed and sorted by name
 */
export function normalizeItemTypeDefinitions(definitions: ItemTypeDefinition[] | undefined): ItemTypeDefinition[] {
  const normalized = (definitions ?? [])
    .map((definition) => normalizeItemTypeDefinition(definition))
    .filter((definition): definition is ItemTypeDefinition => definition !== null);
  const dedupedByName = new Map<string, ItemTypeDefinition>();
  for (const definition of normalized) {
    dedupedByName.set(definition.name.toLowerCase(), definition);
  }
  return [...dedupedByName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Merge a validated settings object with defaults and produce a fully populated, normalized settings object.
 *
 * @param settings - A validated ParsedSettings input (already conforming to the expected schema).
 * @returns A complete PmSettings with defaults applied, governance knobs resolved, `item_format` coerced when required, and nested sections normalized (validation, agent_guidance, item_types, schema, extensions, providers, vector_store, context, search, telemetry, workflow, testing, etc.).
 */
function mergeSettings(settings: ParsedSettings): PmSettings {
  const defaults = cloneDefaults();
  const governance = resolveGovernanceKnobs({
    governance: settings.governance ?? { preset: "default" },
  });
  return {
    ...defaults,
    ...settings,
    item_format: settings.item_format === "json_markdown" ? "toon" : (settings.item_format ?? defaults.item_format),
    locks: { ...defaults.locks, ...settings.locks },
    output: { ...defaults.output, ...settings.output },
    history: { ...defaults.history, ...(settings.history ?? {}) },
    validation: {
      ...defaults.validation,
      ...(settings.validation ?? {}),
      parent_reference: governance.parent_reference,
      metadata_profile: governance.metadata_profile,
      metadata_required_fields: normalizeValidationMetadataRequiredFields(settings.validation?.metadata_required_fields),
      lifecycle_stale_blocker_reason_patterns: normalizeValidationPatternList(
        settings.validation?.lifecycle_stale_blocker_reason_patterns ??
          defaults.validation.lifecycle_stale_blocker_reason_patterns,
      ),
      lifecycle_closure_like_blocked_reason_patterns: normalizeValidationPatternList(
        settings.validation?.lifecycle_closure_like_blocked_reason_patterns ??
          defaults.validation.lifecycle_closure_like_blocked_reason_patterns,
      ),
      lifecycle_closure_like_resolution_patterns: normalizeValidationPatternList(
        settings.validation?.lifecycle_closure_like_resolution_patterns ??
          defaults.validation.lifecycle_closure_like_resolution_patterns,
      ),
      lifecycle_closure_like_actual_result_patterns: normalizeValidationPatternList(
        settings.validation?.lifecycle_closure_like_actual_result_patterns ??
          defaults.validation.lifecycle_closure_like_actual_result_patterns,
      ),
    },
    governance,
    workflow: {
      definition_of_done: [...(settings.workflow?.definition_of_done ?? defaults.workflow.definition_of_done)],
    },
    testing: {
      record_results_to_items: settings.testing?.record_results_to_items ?? defaults.testing.record_results_to_items,
    },
    telemetry: {
      enabled: settings.telemetry?.enabled ?? defaults.telemetry.enabled,
      first_run_prompt_completed:
        settings.telemetry?.first_run_prompt_completed ?? defaults.telemetry.first_run_prompt_completed,
      capture_level: settings.telemetry?.capture_level ?? defaults.telemetry.capture_level,
      endpoint: settings.telemetry?.endpoint ?? defaults.telemetry.endpoint,
      installation_id: settings.telemetry?.installation_id ?? defaults.telemetry.installation_id,
      retention_days: settings.telemetry?.retention_days ?? defaults.telemetry.retention_days,
    },
    agent_guidance: normalizeAgentGuidanceSettings(settings.agent_guidance ?? defaults.agent_guidance),
    item_types: {
      definitions: normalizeItemTypeDefinitions(settings.item_types?.definitions),
    },
    schema: normalizeRuntimeSchemaSettings(settings.schema ?? defaults.schema),
    context: {
      default_depth: settings.context?.default_depth ?? defaults.context.default_depth,
      activity_limit: settings.context?.activity_limit ?? defaults.context.activity_limit,
      stale_threshold_days: settings.context?.stale_threshold_days ?? defaults.context.stale_threshold_days,
      sections: {
        ...defaults.context.sections,
        ...(settings.context?.sections ?? {}),
      },
    },
    extensions: {
      enabled: [...settings.extensions.enabled],
      disabled: [...settings.extensions.disabled],
      policy: normalizeExtensionPolicySettings(settings.extensions.policy ?? defaults.extensions.policy),
    },
    search: { ...defaults.search, ...settings.search },
    providers: {
      openai: { ...defaults.providers.openai, ...settings.providers.openai },
      ollama: { ...defaults.providers.ollama, ...settings.providers.ollama },
    },
    vector_store: {
      adapter: settings.vector_store.adapter ?? defaults.vector_store.adapter,
      qdrant: { ...defaults.vector_store.qdrant, ...settings.vector_store.qdrant },
      lancedb: { ...defaults.vector_store.lancedb, ...settings.vector_store.lancedb },
    },
  };
}

export function serializeSettings(settings: PmSettings): string {
  const governance = resolveGovernanceKnobs(settings);
  const normalizedSettings: PmSettings = {
    ...settings,
    item_format: "toon",
    validation: {
      ...settings.validation,
      parent_reference: governance.parent_reference,
      metadata_profile: governance.metadata_profile,
      metadata_required_fields: normalizeValidationMetadataRequiredFields(settings.validation?.metadata_required_fields),
      lifecycle_stale_blocker_reason_patterns: normalizeValidationPatternList(
        settings.validation?.lifecycle_stale_blocker_reason_patterns ??
          SETTINGS_DEFAULTS.validation.lifecycle_stale_blocker_reason_patterns,
      ),
      lifecycle_closure_like_blocked_reason_patterns: normalizeValidationPatternList(
        settings.validation?.lifecycle_closure_like_blocked_reason_patterns ??
          SETTINGS_DEFAULTS.validation.lifecycle_closure_like_blocked_reason_patterns,
      ),
      lifecycle_closure_like_resolution_patterns: normalizeValidationPatternList(
        settings.validation?.lifecycle_closure_like_resolution_patterns ??
          SETTINGS_DEFAULTS.validation.lifecycle_closure_like_resolution_patterns,
      ),
      lifecycle_closure_like_actual_result_patterns: normalizeValidationPatternList(
        settings.validation?.lifecycle_closure_like_actual_result_patterns ??
          SETTINGS_DEFAULTS.validation.lifecycle_closure_like_actual_result_patterns,
      ),
    },
    governance,
    agent_guidance: normalizeAgentGuidanceSettings(settings.agent_guidance),
    item_types: {
      definitions: normalizeItemTypeDefinitions(settings.item_types?.definitions),
    },
    schema: normalizeRuntimeSchemaSettings(settings.schema),
    context: {
      default_depth: settings.context?.default_depth ?? SETTINGS_DEFAULTS.context.default_depth,
      activity_limit: settings.context?.activity_limit ?? SETTINGS_DEFAULTS.context.activity_limit,
      stale_threshold_days: settings.context?.stale_threshold_days ?? SETTINGS_DEFAULTS.context.stale_threshold_days,
      sections: {
        ...SETTINGS_DEFAULTS.context.sections,
        ...(settings.context?.sections ?? {}),
      },
    },
    extensions: {
      enabled: normalizeStringList(settings.extensions?.enabled),
      disabled: normalizeStringList(settings.extensions?.disabled),
      policy: normalizeExtensionPolicySettings(settings.extensions?.policy),
    },
  };
  const ordered = orderObject(
    {
      ...(normalizedSettings as unknown as Record<string, unknown>),
      governance: normalizeGovernanceForPersist(governance) as unknown,
    },
    [
    "version",
    "id_prefix",
    "author_default",
    "item_format",
    "locks",
    "output",
    "history",
    "validation",
    "governance",
    "workflow",
    "testing",
    "telemetry",
    "agent_guidance",
    "item_types",
    "schema",
    "context",
    "extensions",
    "search",
    "providers",
    "vector_store",
    ],
  );

  ordered.locks = orderObject(ordered.locks as Record<string, unknown>, ["ttl_seconds"]);
  ordered.output = orderObject(ordered.output as Record<string, unknown>, ["default_format"]);
  ordered.history = orderObject(ordered.history as Record<string, unknown>, ["missing_stream"]);
  ordered.validation = orderObject(ordered.validation as Record<string, unknown>, [
    "sprint_release_format",
    "parent_reference",
    "metadata_profile",
    "metadata_required_fields",
    "lifecycle_stale_blocker_reason_patterns",
    "lifecycle_closure_like_blocked_reason_patterns",
    "lifecycle_closure_like_resolution_patterns",
    "lifecycle_closure_like_actual_result_patterns",
  ]);
  ordered.governance = orderObject(ordered.governance as Record<string, unknown>, [
    "preset",
    "ownership_enforcement",
    "create_mode_default",
    "close_validation_default",
    "parent_reference",
    "metadata_profile",
    "force_required_for_stale_lock",
  ]);
  ordered.workflow = orderObject(ordered.workflow as Record<string, unknown>, ["definition_of_done"]);
  ordered.testing = orderObject(ordered.testing as Record<string, unknown>, ["record_results_to_items"]);
  ordered.telemetry = orderObject(ordered.telemetry as Record<string, unknown>, [
    "enabled",
    "first_run_prompt_completed",
    "capture_level",
    "endpoint",
    "installation_id",
    "retention_days",
  ]);
  ordered.agent_guidance = orderObject(ordered.agent_guidance as Record<string, unknown>, [
    "prompt_completed",
    "declined",
    "declined_at",
    "template_version",
    "last_checked_files",
  ]);
  ordered.item_types = orderObject(ordered.item_types as Record<string, unknown>, ["definitions"]);
  ordered.schema = orderObject(ordered.schema as Record<string, unknown>, [
    "version",
    "files",
    "statuses",
    "fields",
    "workflow",
    "unknown_field_policy",
  ]);
  (ordered.schema as Record<string, unknown>).files = orderObject(
    ((ordered.schema as Record<string, unknown>).files ?? {}) as Record<string, unknown>,
    ["types", "statuses", "fields", "workflows"],
  );
  (ordered.schema as Record<string, unknown>).workflow = orderObject(
    ((ordered.schema as Record<string, unknown>).workflow ?? {}) as Record<string, unknown>,
    ["draft_status", "open_status", "in_progress_status", "blocked_status", "close_status", "canceled_status"],
  );
  ordered.context = orderObject(ordered.context as Record<string, unknown>, [
    "default_depth",
    "activity_limit",
    "stale_threshold_days",
    "sections",
  ]);
  (ordered.context as Record<string, unknown>).sections = orderObject(
    ((ordered.context as Record<string, unknown>).sections ?? {}) as Record<string, unknown>,
    ["hierarchy", "activity", "progress", "blockers", "files", "workload", "staleness", "tests"],
  );
  ordered.extensions = orderObject(ordered.extensions as Record<string, unknown>, ["enabled", "disabled", "policy"]);
  (ordered.extensions as Record<string, unknown>).policy = orderObject(
    (((ordered.extensions as Record<string, unknown>).policy ?? {}) as Record<string, unknown>),
    [
      "mode",
      "trust_mode",
      "require_provenance",
      "trusted_extensions",
      "default_sandbox_profile",
      "allowed_extensions",
      "blocked_extensions",
      "allowed_capabilities",
      "blocked_capabilities",
      "allowed_surfaces",
      "blocked_surfaces",
      "allowed_commands",
      "blocked_commands",
      "allowed_actions",
      "blocked_actions",
      "allowed_services",
      "blocked_services",
      "extension_overrides",
    ],
  );
  ((ordered.extensions as Record<string, unknown>).policy as Record<string, unknown>).extension_overrides = (
    (((ordered.extensions as Record<string, unknown>).policy as Record<string, unknown>).extension_overrides ?? []) as unknown[]
  ).map((entry) =>
    orderObject((entry ?? {}) as Record<string, unknown>, [
      "name",
      "disabled",
      "require_trusted",
      "require_provenance",
      "sandbox_profile",
      "allowed_capabilities",
      "blocked_capabilities",
      "allowed_surfaces",
      "blocked_surfaces",
      "allowed_commands",
      "blocked_commands",
      "allowed_actions",
      "blocked_actions",
      "allowed_services",
      "blocked_services",
    ]),
  );
  ordered.search = orderObject(ordered.search as Record<string, unknown>, [
    "score_threshold",
    "hybrid_semantic_weight",
    "max_results",
    "embedding_model",
    "embedding_batch_size",
    "embedding_timeout_ms",
    "scanner_max_batch_retries",
    "provider",
  ]);
  ordered.providers = orderObject(ordered.providers as Record<string, unknown>, ["openai", "ollama"]);
  (ordered.providers as Record<string, unknown>).openai = orderObject(
    ((ordered.providers as Record<string, unknown>).openai ?? {}) as Record<string, unknown>,
    ["base_url", "api_key", "model"],
  );
  (ordered.providers as Record<string, unknown>).ollama = orderObject(
    ((ordered.providers as Record<string, unknown>).ollama ?? {}) as Record<string, unknown>,
    ["base_url", "model"],
  );
  ordered.vector_store = orderObject(ordered.vector_store as Record<string, unknown>, ["adapter", "qdrant", "lancedb"]);
  (ordered.vector_store as Record<string, unknown>).qdrant = orderObject(
    ((ordered.vector_store as Record<string, unknown>).qdrant ?? {}) as Record<string, unknown>,
    ["url", "api_key"],
  );
  (ordered.vector_store as Record<string, unknown>).lancedb = orderObject(
    ((ordered.vector_store as Record<string, unknown>).lancedb ?? {}) as Record<string, unknown>,
    ["path"],
  );

  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * Read project settings from disk, validate and merge them with defaults, and return settings plus metadata and warnings.
 *
 * @param pmRoot - Filesystem path of the project root used to locate the settings file
 * @returns An object containing:
 *   - `settings`: the merged and normalized project settings
 *   - `metadata.has_explicit_item_format`: `true` when the original file explicitly specified an item format, `false` otherwise
 *   - `warnings`: array of warning codes or messages produced while reading, validating, merging, or scaffolding settings
 */
export async function readSettingsWithMetadata(pmRoot: string): Promise<SettingsReadResult> {
  const settingsPath = getSettingsPath(pmRoot);
  const raw = await readFileIfExists(settingsPath);
  if (raw === null) {
    return buildFallbackSettingsReadResult();
  }
  await runActiveOnReadHooks({
    path: settingsPath,
    scope: "project",
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return buildFallbackSettingsReadResult("settings_read_invalid_json");
  }

  const validated = validateSettings(parsed);
  if (!validated.success) {
    return buildFallbackSettingsReadResult("settings_read_invalid_schema");
  }

  try {
    const mergedSettings = mergeSettings(validated.data);
    const schemaScaffold = await ensureRuntimeSchemaFileScaffold(pmRoot, mergedSettings.schema);
    const loadedSchemaSections = await loadRuntimeSchemaFromOptionalFiles(pmRoot, mergedSettings.schema);
    const settings = {
      ...mergedSettings,
      item_types: {
        definitions: normalizeItemTypeDefinitions([
          ...mergedSettings.item_types.definitions,
          ...(loadedSchemaSections.type_definitions_from_file ?? []),
        ]),
      },
      schema: loadedSchemaSections.schema,
    };
    return {
      settings,
      metadata: {
        has_explicit_item_format: hasExplicitItemFormat(parsed),
      },
      warnings: [
        ...(validated.data.item_format === "json_markdown"
          ? ["settings_item_format_legacy_json_markdown_coerced_to_toon"]
          : []),
        ...schemaScaffold.created_paths.map((createdPath) => `runtime_schema_bootstrap_created:${createdPath}`),
        ...loadedSchemaSections.warnings,
      ],
    };
  } catch {
    return buildFallbackSettingsReadResult("settings_read_merge_failed");
  }
}

export async function readSettings(pmRoot: string): Promise<PmSettings> {
  return (await readSettingsWithMetadata(pmRoot)).settings;
}

export async function writeSettings(pmRoot: string, settings: PmSettings, op = SETTINGS_WRITE_OP): Promise<void> {
  const settingsPath = getSettingsPath(pmRoot);
  await writeFileAtomic(settingsPath, serializeSettings(settings));
  await runActiveOnWriteHooks({
    path: settingsPath,
    scope: "project",
    op,
  });
}
