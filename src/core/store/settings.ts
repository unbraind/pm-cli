import { z } from "zod";
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
  GovernanceSettings,
  ItemTypeCommandOptionPolicy,
  ItemTypeDefinition,
  ItemTypeOptionDefinition,
  PmSettings,
  GovernancePreset,
  ValidateMetadataRequiredField,
} from "../../types/index.js";

const itemTypeOptionSchema = z.object({
  key: z.string(),
  values: z.array(z.string()),
  required: z.boolean().optional(),
  aliases: z.array(z.string()).optional(),
  description: z.string().optional(),
});

const itemTypeCommandOptionPolicySchema = z.object({
  command: z.union([z.literal("create"), z.literal("update")]),
  option: z.string(),
  required: z.boolean().optional(),
  visible: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

const itemTypeDefinitionSchema = z.object({
  name: z.string(),
  folder: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  required_create_fields: z.array(z.string()).optional(),
  required_create_repeatables: z.array(z.string()).optional(),
  options: z.array(itemTypeOptionSchema).optional(),
  command_option_policies: z.array(itemTypeCommandOptionPolicySchema).optional(),
});

const runtimeStatusDefinitionSchema = z.object({
  id: z.string(),
  aliases: z.array(z.string()).optional(),
  roles: z
    .array(
      z.union([
        z.literal("draft"),
        z.literal("active"),
        z.literal("blocked"),
        z.literal("terminal"),
        z.literal("terminal_done"),
        z.literal("terminal_canceled"),
        z.literal("default_open"),
        z.literal("default_close"),
        z.literal("default_cancel"),
      ]),
    )
    .optional(),
  description: z.string().optional(),
  order: z.number().optional(),
});

const runtimeFieldDefinitionSchema = z.object({
  key: z.string(),
  front_matter_key: z.string().optional(),
  cli_flag: z.string().optional(),
  cli_aliases: z.array(z.string()).optional(),
  description: z.string().optional(),
  type: z.union([z.literal("string"), z.literal("number"), z.literal("boolean"), z.literal("string_array")]).optional(),
  commands: z
    .array(
      z.union([
        z.literal("create"),
        z.literal("update"),
        z.literal("update_many"),
        z.literal("list"),
        z.literal("search"),
        z.literal("calendar"),
        z.literal("context"),
      ]),
    )
    .optional(),
  repeatable: z.boolean().optional(),
  required: z.boolean().optional(),
  required_on_create: z.boolean().optional(),
  required_types: z.array(z.string()).optional(),
  allow_unset: z.boolean().optional(),
});

const runtimeSchemaSettingsSchema = z
  .object({
    version: z.number().int().optional(),
    files: z
      .object({
        types: z.string().optional(),
        statuses: z.string().optional(),
        fields: z.string().optional(),
        workflows: z.string().optional(),
      })
      .optional(),
    statuses: z.array(runtimeStatusDefinitionSchema).optional(),
    fields: z.array(runtimeFieldDefinitionSchema).optional(),
    workflow: z
      .object({
        draft_status: z.string().optional(),
        open_status: z.string().optional(),
        in_progress_status: z.string().optional(),
        blocked_status: z.string().optional(),
        close_status: z.string().optional(),
        canceled_status: z.string().optional(),
      })
      .optional(),
    unknown_field_policy: z.union([z.literal("allow"), z.literal("warn"), z.literal("reject")]).optional(),
  })
  .optional();

const governanceSettingsSchema = z
  .object({
    preset: z.union([z.literal("minimal"), z.literal("default"), z.literal("strict"), z.literal("custom")]).optional(),
    ownership_enforcement: z.union([z.literal("none"), z.literal("warn"), z.literal("strict")]).optional(),
    create_mode_default: z.union([z.literal("progressive"), z.literal("strict")]).optional(),
    close_validation_default: z.union([z.literal("off"), z.literal("warn"), z.literal("strict")]).optional(),
    parent_reference: z.union([z.literal("warn"), z.literal("strict_error")]).optional(),
    metadata_profile: z.union([z.literal("core"), z.literal("strict"), z.literal("custom")]).optional(),
    force_required_for_stale_lock: z.boolean().optional(),
  })
  .optional();

const settingsSchema = z.object({
  version: z.number().int(),
  id_prefix: z.string(),
  author_default: z.string(),
  item_format: z.union([z.literal("toon"), z.literal("json_markdown")]).optional(),
  locks: z.object({
    ttl_seconds: z.number().int(),
  }),
  output: z.object({
    default_format: z.union([z.literal("toon"), z.literal("json")]),
  }),
  history: z
    .object({
      missing_stream: z.union([z.literal("auto_create"), z.literal("strict_error")]),
    })
    .optional(),
  validation: z
    .object({
      sprint_release_format: z.union([z.literal("warn"), z.literal("strict_error")]),
      parent_reference: z.union([z.literal("warn"), z.literal("strict_error")]).optional(),
      metadata_profile: z.union([z.literal("core"), z.literal("strict"), z.literal("custom")]).optional(),
      metadata_required_fields: z.array(z.string()).optional(),
      lifecycle_stale_blocker_reason_patterns: z.array(z.string()).optional(),
      lifecycle_closure_like_blocked_reason_patterns: z.array(z.string()).optional(),
      lifecycle_closure_like_resolution_patterns: z.array(z.string()).optional(),
      lifecycle_closure_like_actual_result_patterns: z.array(z.string()).optional(),
    })
    .optional(),
  governance: governanceSettingsSchema,
  workflow: z
    .object({
      definition_of_done: z.array(z.string()),
    })
    .optional(),
  testing: z
    .object({
      record_results_to_items: z.boolean(),
    })
    .optional(),
  telemetry: z
    .object({
      enabled: z.boolean(),
      first_run_prompt_completed: z.boolean().optional(),
      capture_level: z.union([z.literal("minimal"), z.literal("redacted"), z.literal("max")]).optional(),
      endpoint: z.string().optional(),
      installation_id: z.string().optional(),
      retention_days: z.number().int().positive().optional(),
    })
    .optional(),
  item_types: z
    .object({
      definitions: z.array(itemTypeDefinitionSchema),
    })
    .optional(),
  schema: runtimeSchemaSettingsSchema,
  extensions: z.object({
    enabled: z.array(z.string()),
    disabled: z.array(z.string()),
  }),
  search: z.object({
    score_threshold: z.number(),
    hybrid_semantic_weight: z.number().optional(),
    max_results: z.number().int(),
    embedding_model: z.string(),
    embedding_batch_size: z.number().int(),
    scanner_max_batch_retries: z.number().int(),
    provider: z.string().optional(),
  }),
  providers: z.object({
    openai: z.object({
      base_url: z.string(),
      api_key: z.string(),
      model: z.string(),
    }),
    ollama: z.object({
      base_url: z.string(),
      model: z.string(),
    }),
  }),
  vector_store: z.object({
    adapter: z.string().optional(),
    qdrant: z.object({
      url: z.string(),
      api_key: z.string(),
    }),
    lancedb: z.object({
      path: z.string(),
    }),
  }),
});

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

function mergeSettings(raw: unknown): PmSettings {
  const defaults = cloneDefaults();
  const parsed = settingsSchema.safeParse(raw);
  if (!parsed.success) {
    return defaults;
  }
  const settings = parsed.data;
  const governance = resolveGovernanceKnobs({
    governance: settings.governance ?? { preset: "default" },
  });
  return {
    ...defaults,
    ...settings,
    item_format: settings.item_format ?? defaults.item_format,
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
    item_types: {
      definitions: normalizeItemTypeDefinitions(settings.item_types?.definitions),
    },
    schema: normalizeRuntimeSchemaSettings(settings.schema ?? defaults.schema),
    extensions: {
      enabled: [...settings.extensions.enabled],
      disabled: [...settings.extensions.disabled],
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
    item_types: {
      definitions: normalizeItemTypeDefinitions(settings.item_types?.definitions),
    },
    schema: normalizeRuntimeSchemaSettings(settings.schema),
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
    "item_types",
    "schema",
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
  ordered.extensions = orderObject(ordered.extensions as Record<string, unknown>, ["enabled", "disabled"]);
  ordered.search = orderObject(ordered.search as Record<string, unknown>, [
    "score_threshold",
    "hybrid_semantic_weight",
    "max_results",
    "embedding_model",
    "embedding_batch_size",
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

  const validated = settingsSchema.safeParse(parsed);
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
