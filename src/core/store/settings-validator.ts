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
import type { PmMaxVersionExceededModeSetting } from "../extensions/extension-types.js";

/** Validated, unknown-key-stripped settings input (pre-merge), matching the legacy zod inference. */
export interface ParsedSettings {
  /** Value that configures or reports version for this contract. */
  version: number;
  /** Value that configures or reports id prefix for this contract. */
  id_prefix: string;
  /** Item id allocation policy (random base36 token length appended to the prefix). */
  ids?: { token_length?: number };
  /** Value that configures or reports author default for this contract. */
  author_default: string;
  /** Shared pre-write mutation guard policy. */
  mutation_guard?: {
    require_attributed_author?: boolean;
    secret_guard?: "off" | "advise" | "block";
    stale_in_progress_hours?: number;
  };
  /** Value that configures or reports item format for this contract. */
  item_format?: "toon" | "json_markdown";
  /** Value that configures or reports locks for this contract. */
  locks: { ttl_seconds: number; wait_ms?: number };
  /** Value that configures or reports checkpoints for this contract. */
  checkpoints?: { retention_days?: number };
  /** Value that configures or reports output for this contract. */
  output: { default_format: "toon" | "json" };
  /** Value that configures or reports history for this contract. */
  history?: {
    missing_stream: "auto_create" | "strict_error";
    compact_policy?: {
      enabled?: boolean;
      max_entries?: number;
      trigger?: "health_warn" | "auto";
    };
  };
  /** Value that configures or reports validation for this contract. */
  validation?: {
    sprint_release_format: "warn" | "strict_error";
    parent_reference?: "warn" | "strict_error";
    metadata_profile?: "core" | "strict" | "custom";
    metadata_required_fields?: string[];
    lifecycle_stale_blocker_reason_patterns?: string[];
    lifecycle_closure_like_blocked_reason_patterns?: string[];
    lifecycle_closure_like_resolution_patterns?: string[];
    lifecycle_closure_like_actual_result_patterns?: string[];
    estimate_defaults_by_type?: Record<string, number>;
  };
  /** Value that configures or reports governance for this contract. */
  governance?: Partial<GovernanceSettings>;
  /** Value that configures or reports workflow for this contract. */
  workflow?: { definition_of_done: string[] };
  /** Value that configures or reports testing for this contract. */
  testing?: { record_results_to_items: boolean };
  /** Value that configures or reports telemetry for this contract. */
  telemetry?: {
    enabled: boolean;
    first_run_prompt_completed?: boolean;
    capture_level?: "minimal" | "redacted" | "max";
    endpoint?: string;
    installation_id?: string;
    retention_days?: number;
  };
  /** Value that configures or reports agent guidance for this contract. */
  agent_guidance?: Partial<AgentGuidanceSettings>;
  /** Value that configures or reports item types for this contract. */
  item_types?: { definitions: ItemTypeDefinition[] };
  /** Value that configures or reports schema for this contract. */
  schema?: Partial<RuntimeSchemaSettings>;
  /** Value that configures or reports context for this contract. */
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
  /** Value that configures or reports extensions for this contract. */
  extensions: {
    enabled: string[];
    disabled: string[];
    policy?: Partial<ExtensionPolicySettings> & {
      pm_max_version_exceeded_mode?: PmMaxVersionExceededModeSetting;
    };
  };
  /** Value that configures or reports search for this contract. */
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
    corpus_fields?: string[];
    mutation_refresh_policy?:
      | "cache_only"
      | "semantic_configured"
      | "semantic_auto";
    query_expansion?: {
      enabled?: boolean;
      provider?: string;
    };
    rerank?: {
      enabled?: boolean;
      model?: string;
      top_k?: number;
    };
    bm25?: {
      k1?: number;
      b?: number;
    };
  };
  /** Value that configures or reports providers for this contract. */
  providers: {
    openai: { base_url: string; api_key: string; model: string };
    ollama: { base_url: string; model: string };
  };
  /** Value that configures or reports vector store for this contract. */
  vector_store: {
    adapter?: string;
    collection_name?: string;
    qdrant: { url: string; api_key: string };
    lancedb: { path: string };
  };
}

/** Restricts settings validation result values accepted by command, SDK, and storage contracts. */
export type SettingsValidationResult =
  | { success: true; data: ParsedSettings }
  | { success: false };

type Outcome<T> = { ok: true; value: T } | { ok: false };
type Check<T> = (input: unknown) => Outcome<T>;

// Generic over `never` so it is assignable to every `Outcome<T>`.
const FAIL: Outcome<never> = { ok: false };

const vString: Check<string> = (input) =>
  typeof input === "string" ? { ok: true, value: input } : FAIL;
const vBoolean: Check<boolean> = (input) =>
  typeof input === "boolean" ? { ok: true, value: input } : FAIL;

function vNumber(
  options: {
    int?: boolean;
    positive?: boolean;
    min?: number;
    max?: number;
  } = {},
): Check<number> {
  return (input) => {
    // `Number.isFinite` rejects non-numbers, NaN, and ±Infinity in one check.
    if (typeof input !== "number" || !Number.isFinite(input)) {
      return FAIL;
    }
    if (
      options.int &&
      (!Number.isInteger(input) || !Number.isSafeInteger(input))
    ) {
      return FAIL;
    }
    if (options.positive && input <= 0) {
      return FAIL;
    }
    if (typeof options.min === "number" && input < options.min) {
      return FAIL;
    }
    if (typeof options.max === "number" && input > options.max) {
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
  return (input) =>
    input === undefined ? { ok: true, value: undefined } : inner(input);
}

/** A plain object with arbitrary string keys whose values each pass `valueCheck`. Rejects arrays and null. Used for free-form maps like `validation.estimate_defaults_by_type` (item-type -> default minutes). */
function vRecordOf<T>(valueCheck: Check<T>): Check<Record<string, T>> {
  return (input) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return FAIL;
    }
    const value: Record<string, T> = {};
    for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
      const result = valueCheck(raw);
      if (!result.ok) {
        return FAIL;
      }
      value[key] = result.value;
    }
    return { ok: true, value };
  };
}

function vObject(
  shape: Record<string, Check<unknown>>,
): Check<Record<string, unknown>> {
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
    unknown_field_policy: vOptional(
      vLiteral(...RUNTIME_UNKNOWN_FIELD_POLICY_VALUES),
    ),
  }),
);

const governanceSettings = vOptional(
  vObject({
    preset: vOptional(vLiteral(...GOVERNANCE_PRESET_VALUES)),
    ownership_enforcement: vOptional(vLiteral("none", "warn", "strict")),
    create_mode_default: vOptional(vLiteral("progressive", "strict")),
    close_validation_default: vOptional(vLiteral("off", "warn", "strict")),
    require_close_reason: vOptional(vBoolean),
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

// `pm_max_version_exceeded_mode` accepts either a single mode literal or a
// per-layer override object (pm-k5e8); any other shape fails validation.
const pmMaxVersionExceededModeLiteral = vLiteral("block", "warn");
const pmMaxVersionExceededMode: Check<unknown> = (input) =>
  typeof input === "string"
    ? pmMaxVersionExceededModeLiteral(input)
    : vObject({
        global: vOptional(pmMaxVersionExceededModeLiteral),
        project: vOptional(pmMaxVersionExceededModeLiteral),
      })(input);

const extensionPolicy = vOptional(
  vObject({
    mode: vOptional(vLiteral("off", "warn", "enforce")),
    trust_mode: vOptional(vLiteral("off", "warn", "enforce")),
    pm_max_version_exceeded_mode: vOptional(pmMaxVersionExceededMode),
    require_provenance: vOptional(vBoolean),
    trusted_extensions: vOptional(vArray(vString)),
    default_sandbox_profile: vOptional(
      vLiteral("none", "restricted", "strict"),
    ),
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
  ids: vOptional(
    vObject({
      token_length: vOptional(vNumber({ int: true, min: 4, max: 12 })),
    }),
  ),
  author_default: vString,
  mutation_guard: vOptional(
    vObject({
      require_attributed_author: vOptional(vBoolean),
      secret_guard: vOptional(vLiteral("off", "advise", "block")),
      stale_in_progress_hours: vOptional(
        vNumber({ int: true, positive: true }),
      ),
    }),
  ),
  item_format: vOptional(vLiteral("toon", "json_markdown")),
  locks: vObject({
    ttl_seconds: vNumber({ int: true }),
    wait_ms: vOptional(vNumber({ int: true, min: 0 })),
  }),
  checkpoints: vOptional(
    vObject({
      retention_days: vOptional(vNumber({ int: true, positive: true })),
    }),
  ),
  output: vObject({ default_format: vLiteral("toon", "json") }),
  history: vOptional(
    vObject({
      missing_stream: vLiteral("auto_create", "strict_error"),
      compact_policy: vOptional(
        vObject({
          enabled: vOptional(vBoolean),
          max_entries: vOptional(vNumber({ int: true, positive: true })),
          trigger: vOptional(vLiteral("health_warn", "auto")),
        }),
      ),
    }),
  ),
  validation: vOptional(
    vObject({
      sprint_release_format: vLiteral("warn", "strict_error"),
      parent_reference: vOptional(vLiteral("warn", "strict_error")),
      metadata_profile: vOptional(vLiteral("core", "strict", "custom")),
      metadata_required_fields: vOptional(vArray(vString)),
      lifecycle_stale_blocker_reason_patterns: vOptional(vArray(vString)),
      lifecycle_closure_like_blocked_reason_patterns: vOptional(
        vArray(vString),
      ),
      lifecycle_closure_like_resolution_patterns: vOptional(vArray(vString)),
      lifecycle_closure_like_actual_result_patterns: vOptional(vArray(vString)),
      estimate_defaults_by_type: vOptional(
        vRecordOf(vNumber({ int: true, positive: true })),
      ),
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
          recently_created: vOptional(vBoolean),
          unparented: vOptional(vBoolean),
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
    corpus_fields: vOptional(vArray(vString)),
    mutation_refresh_policy: vOptional(
      vLiteral("cache_only", "semantic_configured", "semantic_auto"),
    ),
    query_expansion: vOptional(
      vObject({
        enabled: vOptional(vBoolean),
        provider: vOptional(vString),
      }),
    ),
    rerank: vOptional(
      vObject({
        enabled: vOptional(vBoolean),
        model: vOptional(vString),
        top_k: vOptional(vNumber({ int: true, positive: true })),
      }),
    ),
    // pm-75k9: offline BM25 tuning. Unlike `search.tuning` (intentionally
    // stripped for legacy zod parity), bm25 is validated so it persists across
    // writeSettings round-trips — these knobs must survive to take effect.
    bm25: vOptional(
      vObject({
        k1: vOptional(vNumber()),
        b: vOptional(vNumber()),
      }),
    ),
  }),
  providers: vObject({
    openai: vObject({ base_url: vString, api_key: vString, model: vString }),
    ollama: vObject({ base_url: vString, model: vString }),
  }),
  vector_store: vObject({
    adapter: vOptional(vString),
    collection_name: vOptional(vString),
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
