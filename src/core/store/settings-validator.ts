/**
 * Dependency-free settings validator.
 *
 * Mirrors the previous `zod` schema for `settings.json` exactly (type checks,
 * required-vs-optional fields, integer/positive constraints, literal unions, and
 * unknown-key stripping with all-or-nothing failure semantics) without paying
 * the ~85ms cost of importing `zod` on every command's hot read path.
 *
 * The validator intentionally reproduces the zod schema's shape — including
 * fields that `PmSettings` carries but the schema does not (e.g. `search.tuning`)
 * are stripped here just as zod stripped them — so settings behavior is
 * byte-identical to the previous implementation.
 */
import {
  GOVERNANCE_PRESET_VALUES,
  RUNTIME_FIELD_COMMAND_VALUES,
  RUNTIME_FIELD_TYPE_VALUES,
  RUNTIME_STATUS_ROLE_VALUES,
  RUNTIME_UNKNOWN_FIELD_POLICY_VALUES,
} from "../../types.js";
import type {
  AgentGuidanceSettings,
  ExtensionPolicySettings,
  GovernanceSettings,
  ItemTypeDefinition,
  RuntimeSchemaSettings,
} from "../../types.js";

/** Validated, unknown-key-stripped settings input (pre-merge), matching the legacy zod inference. */
export interface ParsedSettings {
  version: number;
  id_prefix: string;
  author_default: string;
  item_format?: "toon" | "json_markdown";
  locks: { ttl_seconds: number };
  output: { default_format: "toon" | "json" };
  history?: { missing_stream: "auto_create" | "strict_error" };
  validation?: {
    sprint_release_format: "warn" | "strict_error";
    parent_reference?: "warn" | "strict_error";
    metadata_profile?: "core" | "strict" | "custom";
    metadata_required_fields?: string[];
    lifecycle_stale_blocker_reason_patterns?: string[];
    lifecycle_closure_like_blocked_reason_patterns?: string[];
    lifecycle_closure_like_resolution_patterns?: string[];
    lifecycle_closure_like_actual_result_patterns?: string[];
  };
  governance?: Partial<GovernanceSettings>;
  workflow?: { definition_of_done: string[] };
  testing?: { record_results_to_items: boolean };
  telemetry?: {
    enabled: boolean;
    first_run_prompt_completed?: boolean;
    capture_level?: "minimal" | "redacted" | "max";
    endpoint?: string;
    installation_id?: string;
    retention_days?: number;
  };
  agent_guidance?: Partial<AgentGuidanceSettings>;
  item_types?: { definitions: ItemTypeDefinition[] };
  schema?: Partial<RuntimeSchemaSettings>;
  context?: {
    default_depth?: "brief" | "standard" | "deep";
    activity_limit?: number;
    stale_threshold_days?: number;
    sections?: {
      hierarchy?: boolean;
      activity?: boolean;
      progress?: boolean;
      blockers?: boolean;
      files?: boolean;
      workload?: boolean;
      staleness?: boolean;
      tests?: boolean;
    };
  };
  extensions: {
    enabled: string[];
    disabled: string[];
    policy?: Partial<ExtensionPolicySettings>;
  };
  search: {
    score_threshold: number;
    hybrid_semantic_weight?: number;
    max_results: number;
    embedding_model: string;
    embedding_corpus_max_characters?: number;
    embedding_batch_size: number;
    embedding_timeout_ms?: number;
    scanner_max_batch_retries: number;
    provider?: string;
    mutation_refresh_policy?: "cache_only" | "semantic_configured" | "semantic_auto";
  };
  providers: {
    openai: { base_url: string; api_key: string; model: string };
    ollama: { base_url: string; model: string };
  };
  vector_store: {
    adapter?: string;
    qdrant: { url: string; api_key: string };
    lancedb: { path: string };
  };
}

export type SettingsValidationResult = { success: true; data: ParsedSettings } | { success: false };

type Outcome<T> = { ok: true; value: T } | { ok: false };
type Check<T> = (input: unknown) => Outcome<T>;

// Generic over `never` so it is assignable to every `Outcome<T>`.
const FAIL: Outcome<never> = { ok: false };

const vString: Check<string> = (input) => (typeof input === "string" ? { ok: true, value: input } : FAIL);
const vBoolean: Check<boolean> = (input) => (typeof input === "boolean" ? { ok: true, value: input } : FAIL);

function vNumber(options: { int?: boolean; positive?: boolean } = {}): Check<number> {
  return (input) => {
    // `Number.isFinite` rejects non-numbers, NaN, and ±Infinity in one check.
    if (typeof input !== "number" || !Number.isFinite(input)) {
      return FAIL;
    }
    if (options.int && (!Number.isInteger(input) || !Number.isSafeInteger(input))) {
      return FAIL;
    }
    if (options.positive && input <= 0) {
      return FAIL;
    }
    return { ok: true, value: input };
  };
}

function vLiteral<const T extends string>(...allowed: readonly T[]): Check<T> {
  return (input) =>
    typeof input === "string" && (allowed as readonly string[]).includes(input)
      ? { ok: true, value: input as T }
      : FAIL;
}

function vArray<T>(item: Check<T>): Check<T[]> {
  return (input) => {
    if (!Array.isArray(input)) {
      return FAIL;
    }
    const value: T[] = [];
    for (const element of input) {
      const result = item(element);
      if (!result.ok) {
        return FAIL;
      }
      value.push(result.value);
    }
    return { ok: true, value };
  };
}

function vOptional<T>(inner: Check<T>): Check<T | undefined> {
  return (input) => (input === undefined ? { ok: true, value: undefined } : inner(input));
}

function vObject(shape: Record<string, Check<unknown>>): Check<Record<string, unknown>> {
  return (input) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return FAIL;
    }
    const record = input as Record<string, unknown>;
    const value: Record<string, unknown> = {};
    for (const [key, check] of Object.entries(shape)) {
      const result = check(record[key]);
      if (!result.ok) {
        return FAIL;
      }
      // Mirror zod: absent optional keys are omitted; unknown keys are dropped.
      if (result.value !== undefined) {
        value[key] = result.value;
      }
    }
    return { ok: true, value };
  };
}

const itemTypeOption = vObject({
  key: vString,
  values: vArray(vString),
  required: vOptional(vBoolean),
  aliases: vOptional(vArray(vString)),
  description: vOptional(vString),
});

const itemTypeCommandOptionPolicy = vObject({
  command: vLiteral("create", "update"),
  option: vString,
  required: vOptional(vBoolean),
  visible: vOptional(vBoolean),
  enabled: vOptional(vBoolean),
});

const itemTypeDefinition = vObject({
  name: vString,
  description: vOptional(vString),
  // Per-type create-time default status (config-driven); preserved so inline
  // settings.item_types.definitions behave identically to schema/types.json.
  default_status: vOptional(vString),
  folder: vOptional(vString),
  aliases: vOptional(vArray(vString)),
  required_create_fields: vOptional(vArray(vString)),
  required_create_repeatables: vOptional(vArray(vString)),
  options: vOptional(vArray(itemTypeOption)),
  command_option_policies: vOptional(vArray(itemTypeCommandOptionPolicy)),
});

const runtimeStatusDefinition = vObject({
  id: vString,
  aliases: vOptional(vArray(vString)),
  roles: vOptional(vArray(vLiteral(...RUNTIME_STATUS_ROLE_VALUES))),
  description: vOptional(vString),
  order: vOptional(vNumber()),
});

const runtimeFieldDefinition = vObject({
  key: vString,
  metadata_key: vOptional(vString),
  front_matter_key: vOptional(vString),
  cli_flag: vOptional(vString),
  cli_aliases: vOptional(vArray(vString)),
  description: vOptional(vString),
  type: vOptional(vLiteral(...RUNTIME_FIELD_TYPE_VALUES)),
  commands: vOptional(vArray(vLiteral(...RUNTIME_FIELD_COMMAND_VALUES))),
  repeatable: vOptional(vBoolean),
  required: vOptional(vBoolean),
  required_on_create: vOptional(vBoolean),
  required_types: vOptional(vArray(vString)),
  allow_unset: vOptional(vBoolean),
});

const statusTransitionPair: Check<[string, string]> = (input) => {
  if (!Array.isArray(input) || input.length !== 2) {
    return FAIL;
  }
  const [from, to] = input;
  if (typeof from !== "string" || typeof to !== "string") {
    return FAIL;
  }
  return { ok: true, value: [from, to] };
};

const typeWorkflowDefinition = vObject({
  type: vString,
  allowed_transitions: vArray(statusTransitionPair),
});

const runtimeSchemaSettings = vOptional(
  vObject({
    version: vOptional(vNumber({ int: true })),
    files: vOptional(
      vObject({
        types: vOptional(vString),
        statuses: vOptional(vString),
        fields: vOptional(vString),
        workflows: vOptional(vString),
      }),
    ),
    statuses: vOptional(vArray(runtimeStatusDefinition)),
    fields: vOptional(vArray(runtimeFieldDefinition)),
    workflow: vOptional(
      vObject({
        draft_status: vOptional(vString),
        open_status: vOptional(vString),
        in_progress_status: vOptional(vString),
        blocked_status: vOptional(vString),
        close_status: vOptional(vString),
        canceled_status: vOptional(vString),
      }),
    ),
    type_workflows: vOptional(vArray(typeWorkflowDefinition)),
    unknown_field_policy: vOptional(vLiteral(...RUNTIME_UNKNOWN_FIELD_POLICY_VALUES)),
  }),
);

const governanceSettings = vOptional(
  vObject({
    preset: vOptional(vLiteral(...GOVERNANCE_PRESET_VALUES)),
    ownership_enforcement: vOptional(vLiteral("none", "warn", "strict")),
    create_mode_default: vOptional(vLiteral("progressive", "strict")),
    close_validation_default: vOptional(vLiteral("off", "warn", "strict")),
    parent_reference: vOptional(vLiteral("warn", "strict_error")),
    metadata_profile: vOptional(vLiteral("core", "strict", "custom")),
    force_required_for_stale_lock: vOptional(vBoolean),
    create_default_type: vOptional(vString),
    workflow_enforcement: vOptional(vLiteral("off", "warn", "strict")),
  }),
);

const extensionPolicyOverride = vObject({
  name: vString,
  disabled: vOptional(vBoolean),
  require_trusted: vOptional(vBoolean),
  require_provenance: vOptional(vBoolean),
  sandbox_profile: vOptional(vLiteral("none", "restricted", "strict")),
  allowed_capabilities: vOptional(vArray(vString)),
  blocked_capabilities: vOptional(vArray(vString)),
  allowed_surfaces: vOptional(vArray(vString)),
  blocked_surfaces: vOptional(vArray(vString)),
  allowed_commands: vOptional(vArray(vString)),
  blocked_commands: vOptional(vArray(vString)),
  allowed_actions: vOptional(vArray(vString)),
  blocked_actions: vOptional(vArray(vString)),
  allowed_services: vOptional(vArray(vString)),
  blocked_services: vOptional(vArray(vString)),
});

const extensionPolicy = vOptional(
  vObject({
    mode: vOptional(vLiteral("off", "warn", "enforce")),
    trust_mode: vOptional(vLiteral("off", "warn", "enforce")),
    require_provenance: vOptional(vBoolean),
    trusted_extensions: vOptional(vArray(vString)),
    default_sandbox_profile: vOptional(vLiteral("none", "restricted", "strict")),
    allowed_extensions: vOptional(vArray(vString)),
    blocked_extensions: vOptional(vArray(vString)),
    allowed_capabilities: vOptional(vArray(vString)),
    blocked_capabilities: vOptional(vArray(vString)),
    allowed_surfaces: vOptional(vArray(vString)),
    blocked_surfaces: vOptional(vArray(vString)),
    allowed_commands: vOptional(vArray(vString)),
    blocked_commands: vOptional(vArray(vString)),
    allowed_actions: vOptional(vArray(vString)),
    blocked_actions: vOptional(vArray(vString)),
    allowed_services: vOptional(vArray(vString)),
    blocked_services: vOptional(vArray(vString)),
    extension_overrides: vOptional(vArray(extensionPolicyOverride)),
  }),
);

const settingsCheck = vObject({
  version: vNumber({ int: true }),
  id_prefix: vString,
  author_default: vString,
  item_format: vOptional(vLiteral("toon", "json_markdown")),
  locks: vObject({ ttl_seconds: vNumber({ int: true }) }),
  output: vObject({ default_format: vLiteral("toon", "json") }),
  history: vOptional(vObject({ missing_stream: vLiteral("auto_create", "strict_error") })),
  validation: vOptional(
    vObject({
      sprint_release_format: vLiteral("warn", "strict_error"),
      parent_reference: vOptional(vLiteral("warn", "strict_error")),
      metadata_profile: vOptional(vLiteral("core", "strict", "custom")),
      metadata_required_fields: vOptional(vArray(vString)),
      lifecycle_stale_blocker_reason_patterns: vOptional(vArray(vString)),
      lifecycle_closure_like_blocked_reason_patterns: vOptional(vArray(vString)),
      lifecycle_closure_like_resolution_patterns: vOptional(vArray(vString)),
      lifecycle_closure_like_actual_result_patterns: vOptional(vArray(vString)),
    }),
  ),
  governance: governanceSettings,
  workflow: vOptional(vObject({ definition_of_done: vArray(vString) })),
  testing: vOptional(vObject({ record_results_to_items: vBoolean })),
  telemetry: vOptional(
    vObject({
      enabled: vBoolean,
      first_run_prompt_completed: vOptional(vBoolean),
      capture_level: vOptional(vLiteral("minimal", "redacted", "max")),
      endpoint: vOptional(vString),
      installation_id: vOptional(vString),
      retention_days: vOptional(vNumber({ int: true, positive: true })),
    }),
  ),
  agent_guidance: vOptional(
    vObject({
      prompt_completed: vOptional(vBoolean),
      declined: vOptional(vBoolean),
      declined_at: vOptional(vString),
      template_version: vOptional(vNumber({ int: true, positive: true })),
      last_checked_files: vOptional(vArray(vString)),
    }),
  ),
  item_types: vOptional(vObject({ definitions: vArray(itemTypeDefinition) })),
  schema: runtimeSchemaSettings,
  context: vOptional(
    vObject({
      default_depth: vOptional(vLiteral("brief", "standard", "deep")),
      activity_limit: vOptional(vNumber({ int: true, positive: true })),
      stale_threshold_days: vOptional(vNumber({ int: true, positive: true })),
      sections: vOptional(
        vObject({
          hierarchy: vOptional(vBoolean),
          activity: vOptional(vBoolean),
          progress: vOptional(vBoolean),
          blockers: vOptional(vBoolean),
          files: vOptional(vBoolean),
          workload: vOptional(vBoolean),
          staleness: vOptional(vBoolean),
          tests: vOptional(vBoolean),
        }),
      ),
    }),
  ),
  extensions: vObject({
    enabled: vArray(vString),
    disabled: vArray(vString),
    policy: extensionPolicy,
  }),
  search: vObject({
    score_threshold: vNumber(),
    hybrid_semantic_weight: vOptional(vNumber()),
    max_results: vNumber({ int: true }),
    embedding_model: vString,
    embedding_corpus_max_characters: vOptional(vNumber()),
    embedding_batch_size: vNumber({ int: true }),
    embedding_timeout_ms: vOptional(vNumber({ int: true })),
    scanner_max_batch_retries: vNumber({ int: true }),
    provider: vOptional(vString),
    mutation_refresh_policy: vOptional(vLiteral("cache_only", "semantic_configured", "semantic_auto")),
  }),
  providers: vObject({
    openai: vObject({ base_url: vString, api_key: vString, model: vString }),
    ollama: vObject({ base_url: vString, model: vString }),
  }),
  vector_store: vObject({
    adapter: vOptional(vString),
    qdrant: vObject({ url: vString, api_key: vString }),
    lancedb: vObject({ path: vString }),
  }),
});

/** Validate raw settings, returning stripped, type-checked data or failure (matching the legacy zod safeParse). */
export function validateSettings(raw: unknown): SettingsValidationResult {
  const result = settingsCheck(raw);
  if (!result.ok) {
    return { success: false };
  }
  return { success: true, data: result.value as unknown as ParsedSettings };
}
