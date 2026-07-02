/**
 * Nested leaf settings exposed via `pm config <scope> set/get <key> <value>`.
 *
 * These are simple string/number leaves of {@link PmSettings} (provider URLs,
 * vector-store adapter, search tuning) that previously required hand-editing
 * `.agents/pm/settings.json`. They live here so the same dotted path is
 * documented in one place and surfaced both to the config dispatcher and to
 * `pm config list` (so `pm config list --json` is discoverable).
 *
 * Shape conventions:
 * - `path` is the dotted JSON path in {@link PmSettings} (e.g. `search.provider`).
 * - `kind` is the value shape: "string" | "boolean" | "integer" | "number" | "ratio"
 *   - "ratio" must be a finite number in [0, 1].
 *   - "integer" must be a finite non-negative integer. Set `min: 1` for keys
 *     where the runtime silently falls back when 0 is supplied (e.g. batch
 *     size, timeout, max-results limits).
 *   - "number" must be a finite number — negatives ARE allowed (e.g. score
 *     thresholds may legitimately be negative when a provider normalizes
 *     scores into a signed range).
 *
 * Adding a key here makes it acceptable to `pm config <scope> set <key> <value>`
 * with no other code changes — the dispatcher walks the dotted path on the
 * already-validated PmSettings shape.
 */

/** Supported coercion shapes for nested settings exposed through `pm config`. */
export type NestedSettingKind = "string" | "boolean" | "integer" | "number" | "ratio";

/**
 * Documents the nested setting descriptor payload exchanged by command, SDK, and package integrations.
 */
export interface NestedSettingDescriptor {
  /** CLI key (snake_case). Kebab-case form is accepted by normalizing `-` → `_`. */
  key: string;
  /** Dotted JSON path in PmSettings. */
  path: string;
  /** Value shape. */
  kind: NestedSettingKind;
  /** Short human-facing summary for `pm config list`. */
  summary: string;
  /** Optional accepted values for string settings. */
  choices?: readonly string[];
  /** Require a non-empty trimmed string value for string settings. */
  non_empty?: boolean;
  /**
   * Optional minimum value for `integer` / `number` kinds. When set,
   * `parseNestedSettingValue` rejects values strictly below `min`. Useful for
   * settings where 0 would be silently ignored by the runtime (batch sizes,
   * timeouts, max-results limits).
   */
  min?: number;
}

/**
 * Search/provider/vector-store leaves. Order is the display order in
 * `pm config list` and in error hints.
 */
export const NESTED_SETTING_DESCRIPTORS: readonly NestedSettingDescriptor[] = [
  {
    key: "search_provider",
    path: "search.provider",
    kind: "string",
    summary: "Search embedding provider name (e.g. openai, ollama, or an extension provider).",
  },
  {
    key: "search_mutation_refresh_policy",
    path: "search.mutation_refresh_policy",
    kind: "string",
    choices: ["cache_only", "semantic_configured", "semantic_auto"],
    summary: "Mutation-time search refresh policy: cache_only, semantic_configured, or semantic_auto.",
  },
  {
    key: "search_query_expansion_enabled",
    path: "search.query_expansion.enabled",
    kind: "boolean",
    summary: "Enable or disable query expansion for semantic/hybrid search.",
  },
  {
    key: "search_query_expansion_provider",
    path: "search.query_expansion.provider",
    kind: "string",
    summary: "Query expansion provider name (built-in openai/ollama or extension provider).",
  },
  {
    key: "search_rerank_enabled",
    path: "search.rerank.enabled",
    kind: "boolean",
    summary: "Enable or disable post-retrieval reranking for hybrid search.",
  },
  {
    key: "search_rerank_model",
    path: "search.rerank.model",
    kind: "string",
    summary: "Rerank model name override used by built-in providers.",
  },
  {
    key: "search_rerank_top_k",
    path: "search.rerank.top_k",
    kind: "integer",
    min: 1,
    summary: "Number of top hybrid candidates to rerank when rerank is enabled.",
  },
  {
    key: "search_embedding_model",
    path: "search.embedding_model",
    kind: "string",
    summary: "Default embedding model name (overrides provider-specific model when set).",
  },
  {
    key: "search_embedding_corpus_max_characters",
    path: "search.embedding_corpus_max_characters",
    kind: "integer",
    min: 1,
    summary: "Maximum semantic corpus characters per item before truncation.",
  },
  {
    key: "search_embedding_batch_size",
    path: "search.embedding_batch_size",
    kind: "integer",
    min: 1,
    summary: "Number of items embedded per request batch.",
  },
  {
    key: "search_embedding_timeout_ms",
    path: "search.embedding_timeout_ms",
    kind: "integer",
    min: 1,
    summary: "Per-request embedding timeout in milliseconds.",
  },
  {
    key: "search_score_threshold",
    path: "search.score_threshold",
    kind: "number",
    summary: "Minimum score for a hit to be returned (0 keeps all matches).",
  },
  {
    key: "search_hybrid_semantic_weight",
    path: "search.hybrid_semantic_weight",
    kind: "ratio",
    summary: "Hybrid mode semantic weight in [0, 1] (1-weight goes to keyword).",
  },
  {
    key: "search_max_results",
    path: "search.max_results",
    kind: "integer",
    min: 1,
    summary: "Default upper bound on search hits when --limit is not supplied.",
  },
  {
    key: "search_bm25_k1",
    path: "search.bm25.k1",
    kind: "number",
    min: 0,
    summary: "Offline BM25 term-frequency saturation (k1); higher saturates repeated terms slower (default 1.2).",
  },
  {
    key: "search_bm25_b",
    path: "search.bm25.b",
    kind: "ratio",
    summary: "Offline BM25 document-length normalization (b) in [0, 1]; 0 disables, 1 fully normalizes (default 0.75).",
  },
  {
    key: "openai_base_url",
    path: "providers.openai.base_url",
    kind: "string",
    summary: "OpenAI-compatible API base URL (LM Studio/vLLM also use this).",
  },
  {
    key: "openai_api_key",
    path: "providers.openai.api_key",
    kind: "string",
    summary: "OpenAI-compatible API key.",
  },
  {
    key: "openai_model",
    path: "providers.openai.model",
    kind: "string",
    summary: "OpenAI-compatible embedding model name.",
  },
  {
    key: "ollama_base_url",
    path: "providers.ollama.base_url",
    kind: "string",
    summary: "Ollama API base URL (typically http://localhost:11434).",
  },
  {
    key: "ollama_model",
    path: "providers.ollama.model",
    kind: "string",
    summary: "Ollama embedding model name (e.g. nomic-embed-text).",
  },
  {
    key: "vector_store_adapter",
    path: "vector_store.adapter",
    kind: "string",
    summary: "Vector store adapter name (lancedb, qdrant, or an extension adapter).",
  },
  {
    key: "vector_store_collection_name",
    path: "vector_store.collection_name",
    kind: "string",
    non_empty: true,
    summary: "Vector collection/table name shared by Qdrant and LanceDB adapters.",
  },
  {
    key: "qdrant_url",
    path: "vector_store.qdrant.url",
    kind: "string",
    summary: "Qdrant HTTP API URL.",
  },
  {
    key: "qdrant_api_key",
    path: "vector_store.qdrant.api_key",
    kind: "string",
    summary: "Qdrant API key (empty if running unauthenticated).",
  },
  {
    key: "lancedb_path",
    path: "vector_store.lancedb.path",
    kind: "string",
    summary: "LanceDB storage path (relative to pm root or absolute).",
  },
  // General workspace leaves (id/author/output/locks/schema governance). These
  // are documented user-facing settings in CONFIGURATION.md that previously
  // required hand-editing settings.json.
  {
    key: "id_prefix",
    path: "id_prefix",
    kind: "string",
    non_empty: true,
    summary: "Prefix for generated item IDs (e.g. \"pm\" produces pm-xxxx).",
  },
  {
    key: "author_default",
    path: "author_default",
    kind: "string",
    non_empty: true,
    summary: "Default author recorded on mutations when --author is not supplied.",
  },
  {
    key: "output_default_format",
    path: "output.default_format",
    kind: "string",
    choices: ["toon", "json"],
    summary: "Default output format for commands that support it: toon or json.",
  },
  {
    key: "locks_ttl_seconds",
    path: "locks.ttl_seconds",
    kind: "integer",
    min: 1,
    summary: "Claim/lock time-to-live in seconds before a stale lock can be reclaimed.",
  },
  {
    key: "checkpoints_retention_days",
    path: "checkpoints.retention_days",
    kind: "integer",
    min: 1,
    summary: "Age in days above which pm gc --scope checkpoints prunes bulk-mutation rollback checkpoints.",
  },
  {
    key: "schema_unknown_field_policy",
    path: "schema.unknown_field_policy",
    kind: "string",
    choices: ["allow", "warn", "reject"],
    summary: "How item I/O handles metadata keys not in the field registry: allow, warn, or reject.",
  },
  // History compaction policy leaves (pm health advisory + pm history-compact
  // bulk-sweep default threshold). Disabled by default; enabling makes large
  // streams discoverable without a manual stats pass.
  {
    key: "history_compact_policy_enabled",
    path: "history.compact_policy.enabled",
    kind: "boolean",
    summary: "Enable the history-compaction advisory: pm health warns on over-threshold streams.",
  },
  {
    key: "history_compact_policy_max_entries",
    path: "history.compact_policy.max_entries",
    kind: "integer",
    min: 1,
    summary: "Entry count above which a history stream is flagged (and the default pm history-compact --all-over threshold).",
  },
  {
    key: "history_compact_policy_trigger",
    path: "history.compact_policy.trigger",
    kind: "string",
    choices: ["health_warn", "auto"],
    summary: "History-compaction policy intent: health_warn (advisory only) or auto (scheduled sweeps expected).",
  },
];

const DESCRIPTOR_BY_KEY: ReadonlyMap<string, NestedSettingDescriptor> = new Map(
  NESTED_SETTING_DESCRIPTORS.map((descriptor) => [descriptor.key, descriptor]),
);

/**
 * Map a raw user-supplied key (kebab or snake case, any casing) onto a known
 * nested-leaf descriptor. Returns `undefined` when the key is not a nested
 * leaf (callers can then fall back to the regular ConfigKey path).
 */
export function resolveNestedSettingDescriptor(raw: string | undefined): NestedSettingDescriptor | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase().replaceAll("-", "_");
  if (normalized.length === 0) {
    return undefined;
  }
  return DESCRIPTOR_BY_KEY.get(normalized);
}

/** Recoverable parsed value with the descriptor it satisfied. */
export interface NestedSettingParsedValue {
  descriptor: NestedSettingDescriptor;
  value: string | number | boolean;
}

/** Throwable validation error returned as a structured result. */
export interface NestedSettingParseError {
  message: string;
}

/**
 * Restricts nested setting parse result values accepted by command, SDK, and storage contracts.
 */
export type NestedSettingParseResult =
  | { ok: true; parsed: NestedSettingParsedValue }
  | { ok: false; error: NestedSettingParseError };

function parseNestedBooleanValue(descriptor: NestedSettingDescriptor, rawValue: string): NestedSettingParseResult {
  const normalized = rawValue.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
    return { ok: true, parsed: { descriptor, value: true } };
  }
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
    return { ok: true, parsed: { descriptor, value: false } };
  }
  return {
    ok: false,
    error: {
      message: `Config set ${descriptor.key} requires a boolean value (true|false), got "${rawValue}"`,
    },
  };
}

function parseNestedStringValue(
  descriptor: NestedSettingDescriptor,
  rawValue: string,
  trimmed: string,
): NestedSettingParseResult {
  if (descriptor.non_empty === true && trimmed.length === 0) {
    return {
      ok: false,
      error: { message: `Config set ${descriptor.key} requires a non-empty value` },
    };
  }
  if (descriptor.choices && !descriptor.choices.includes(trimmed)) {
    return {
      ok: false,
      error: {
        message: `Config set ${descriptor.key} must be one of ${descriptor.choices.join("|")}, got "${rawValue}"`,
      },
    };
  }
  return { ok: true, parsed: { descriptor, value: trimmed } };
}

function parseFiniteNestedNumber(
  descriptor: NestedSettingDescriptor,
  rawValue: string,
  trimmed: string,
): { ok: true; value: number } | { ok: false; error: NestedSettingParseError } {
  if (trimmed.length === 0) {
    return {
      ok: false,
      error: { message: `Config set ${descriptor.key} requires a non-empty value` },
    };
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    return {
      ok: false,
      error: { message: `Config set ${descriptor.key} requires a finite number, got "${rawValue}"` },
    };
  }
  return { ok: true, value: parsed };
}

function parseNestedIntegerValue(
  descriptor: NestedSettingDescriptor,
  rawValue: string,
  value: number,
): NestedSettingParseResult {
  if (!Number.isInteger(value) || value < 0) {
    return {
      ok: false,
      error: { message: `Config set ${descriptor.key} requires a non-negative integer, got "${rawValue}"` },
    };
  }
  if (descriptor.min !== undefined && value < descriptor.min) {
    return {
      ok: false,
      error: {
        message: `Config set ${descriptor.key} requires an integer >= ${descriptor.min}, got "${rawValue}" (the runtime silently ignores 0 here and falls back to the default)`,
      },
    };
  }
  return { ok: true, parsed: { descriptor, value } };
}

function parseNestedRatioValue(
  descriptor: NestedSettingDescriptor,
  rawValue: string,
  value: number,
): NestedSettingParseResult {
  if (value < 0 || value > 1) {
    return {
      ok: false,
      error: { message: `Config set ${descriptor.key} requires a number in [0, 1], got "${rawValue}"` },
    };
  }
  return { ok: true, parsed: { descriptor, value } };
}

function parseNestedNumberValue(
  descriptor: NestedSettingDescriptor,
  rawValue: string,
  value: number,
): NestedSettingParseResult {
  if (descriptor.min !== undefined && value < descriptor.min) {
    return {
      ok: false,
      error: { message: `Config set ${descriptor.key} requires a number >= ${descriptor.min}, got "${rawValue}"` },
    };
  }
  return { ok: true, parsed: { descriptor, value } };
}

/**
 * Validate and coerce a raw string value for a nested-leaf setting. The
 * returned value is the typed leaf that should be written into PmSettings.
 *
 * Empty strings are allowed for "string" leaves unless `non_empty` is set.
 */
export function parseNestedSettingValue(
  descriptor: NestedSettingDescriptor,
  rawValue: string,
): NestedSettingParseResult {
  if (typeof rawValue !== "string") {
    return { ok: false, error: { message: `Config set ${descriptor.key} requires a string value` } };
  }
  const trimmed = rawValue.trim();
  if (descriptor.kind === "boolean") {
    return parseNestedBooleanValue(descriptor, rawValue);
  }
  if (descriptor.kind === "string") {
    return parseNestedStringValue(descriptor, rawValue, trimmed);
  }

  // Number("") === 0, which would silently accept empty / whitespace-only input
  // as a valid zero. Reject explicitly so misconfigurations don't slip through.
  const parsed = parseFiniteNestedNumber(descriptor, rawValue, trimmed);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }
  if (descriptor.kind === "integer") {
    return parseNestedIntegerValue(descriptor, rawValue, parsed.value);
  }
  if (descriptor.kind === "ratio") {
    return parseNestedRatioValue(descriptor, rawValue, parsed.value);
  }
  // kind === "number" — negatives are allowed; only apply an explicit `min`.
  return parseNestedNumberValue(descriptor, rawValue, parsed.value);
}

/** Walk a dotted path on an arbitrary record (best-effort, returns null on miss). */
export function readNestedSettingValue(
  settings: unknown,
  descriptor: NestedSettingDescriptor,
): string | number | boolean | null {
  const segments = descriptor.path.split(".");
  let cursor: unknown = settings;
  for (const segment of segments) {
    if (typeof cursor !== "object" || cursor === null) {
      return null;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  if (typeof cursor === "string" || typeof cursor === "number" || typeof cursor === "boolean") {
    return cursor;
  }
  return null;
}

/**
 * Set a leaf value on a settings object by walking the descriptor's dotted
 * path. Missing intermediate objects are created. Returns `true` when the
 * value actually changed.
 */
export function writeNestedSettingValue(
  settings: Record<string, unknown>,
  descriptor: NestedSettingDescriptor,
  value: string | number | boolean,
): boolean {
  const segments = descriptor.path.split(".");
  let cursor: Record<string, unknown> = settings;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const existing = cursor[segment];
    if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
      const next: Record<string, unknown> = {};
      cursor[segment] = next;
      cursor = next;
    } else {
      cursor = existing as Record<string, unknown>;
    }
  }
  const leafKey = segments[segments.length - 1];
  const previous = cursor[leafKey];
  if (previous === value) {
    return false;
  }
  cursor[leafKey] = value;
  return true;
}
