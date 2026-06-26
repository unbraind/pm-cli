/**
 * Pure routing helper for the optional positional `value` argument of `pm config set`.
 *
 * `pm config set <key> <value>` is the intuitive form agents reach for, but config
 * VALUES are actually carried by typed flags (`--format`, `--policy`, `--criterion`).
 * This module maps a config key (kebab or snake form, canonical or alias) plus a raw
 * positional value onto the typed flag it should populate, applying enabled/disabled
 * synonyms (off/on/true/false) for boolean-style policy keys. The existing per-key
 * validators in config.ts still run on the routed value, so bad values keep their
 * good error messages.
 */

/** The typed flag a positional value routes to. */
export type ConfigPositionalFlag = "format" | "policy" | "criterion";

/** Successful routing of a positional value to a single-value typed flag. */
export interface ConfigPositionalScalarRouted {
  routable: true;
  flag: "format" | "policy";
  /** Normalized scalar value for single-value flags. */
  value: string;
}

/** Successful routing of a positional value to the criteria-list flag. */
export interface ConfigPositionalListRouted {
  routable: true;
  flag: "criterion";
  /** Criteria-list flag (`--criterion`) value, supplied as a values array. */
  values: string[];
}

/**
 * Restricts config positional routed values accepted by command, SDK, and storage contracts.
 */
export type ConfigPositionalRouted = ConfigPositionalScalarRouted | ConfigPositionalListRouted;

/** A key whose value cannot be carried by a single positional (e.g. `context`). */
export interface ConfigPositionalNotRoutable {
  routable: false;
  /** Human/agent-facing reason + the flags to use instead. */
  reason: string;
}

/**
 * Restricts config positional result values accepted by command, SDK, and storage contracts.
 */
export type ConfigPositionalResult = ConfigPositionalRouted | ConfigPositionalNotRoutable;

/** Canonical snake-case config keys this helper understands. */
type CanonicalConfigKey =
  | "definition_of_done"
  | "item_format"
  | "history_missing_stream_policy"
  | "sprint_release_format_policy"
  | "parent_reference_policy"
  | "metadata_validation_profile"
  | "metadata_required_fields"
  | "lifecycle_stale_blocker_reason_patterns"
  | "lifecycle_closure_like_blocked_reason_patterns"
  | "lifecycle_closure_like_resolution_patterns"
  | "lifecycle_closure_like_actual_result_patterns"
  | "governance_preset"
  | "governance_ownership_enforcement"
  | "governance_create_mode_default"
  | "governance_close_validation_default"
  | "governance_require_close_reason"
  | "governance_create_default_type"
  | "governance_workflow_enforcement"
  | "governance_parent_reference_policy"
  | "governance_metadata_validation_profile"
  | "governance_force_required_for_stale_lock"
  | "test_result_tracking"
  | "telemetry_tracking"
  | "context";

const FORMAT_KEYS: ReadonlySet<CanonicalConfigKey> = new Set<CanonicalConfigKey>(["item_format"]);

const CRITERIA_KEYS: ReadonlySet<CanonicalConfigKey> = new Set<CanonicalConfigKey>([
  "definition_of_done",
  "metadata_required_fields",
  "lifecycle_stale_blocker_reason_patterns",
  "lifecycle_closure_like_blocked_reason_patterns",
  "lifecycle_closure_like_resolution_patterns",
  "lifecycle_closure_like_actual_result_patterns",
]);

const POLICY_KEYS: ReadonlySet<CanonicalConfigKey> = new Set<CanonicalConfigKey>([
  "history_missing_stream_policy",
  "sprint_release_format_policy",
  "parent_reference_policy",
  "metadata_validation_profile",
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
]);

/**
 * Policy keys whose only valid values are enabled/disabled. For these we accept the
 * intuitive synonyms off/on/true/false. Other policy keys pass through unchanged so
 * their own validators report the precise allowed set.
 */
const ENABLED_DISABLED_POLICY_KEYS: ReadonlySet<CanonicalConfigKey> = new Set<CanonicalConfigKey>([
  "governance_require_close_reason",
  "governance_force_required_for_stale_lock",
  "test_result_tracking",
  "telemetry_tracking",
]);

const ENABLED_DISABLED_SYNONYMS: Record<string, string> = {
  off: "disabled",
  on: "enabled",
  true: "enabled",
  false: "disabled",
  enabled: "enabled",
  disabled: "disabled",
};

/** Normalize any kebab/snake key form to the canonical snake key (or undefined). */
function toCanonicalKey(keyOrAlias: string): CanonicalConfigKey | undefined {
  const normalized = keyOrAlias.trim().toLowerCase().replaceAll("-", "_");
  if (
    FORMAT_KEYS.has(normalized as CanonicalConfigKey) ||
    CRITERIA_KEYS.has(normalized as CanonicalConfigKey) ||
    POLICY_KEYS.has(normalized as CanonicalConfigKey) ||
    normalized === "context"
  ) {
    return normalized as CanonicalConfigKey;
  }
  return undefined;
}

/**
 * Map an enabled/disabled-style value through its synonyms (case-insensitive). Values
 * that are not synonyms pass through unchanged so the downstream validator can reject
 * them with its own message.
 */
function normalizeEnabledDisabled(value: string): string {
  const normalized = value.trim().toLowerCase();
  return ENABLED_DISABLED_SYNONYMS[normalized] ?? value;
}

/**
 * Resolve which typed flag a positional `pm config set <key> <value>` value should
 * populate, plus the normalized value.
 *
 * Returns `{ routable: false, reason }` for keys that require multiple/structured
 * flags (e.g. `context`). Unknown keys also return `routable: false` so the caller
 * can fall back to the existing invalid-key path.
 */
export function resolveConfigPositionalValue(
  canonicalKeyOrAlias: string,
  value: string,
): ConfigPositionalResult {
  const key = toCanonicalKey(canonicalKeyOrAlias);
  if (key === undefined) {
    return {
      routable: false,
      reason: `Unknown config key "${canonicalKeyOrAlias}" cannot route a positional value.`,
    };
  }

  if (key === "context") {
    return {
      routable: false,
      reason:
        'Config set context does not accept a positional value. Use --default-depth, --activity-limit, --stale-threshold-days, or --section-<name> flags.',
    };
  }

  if (FORMAT_KEYS.has(key)) {
    return { routable: true, flag: "format", value };
  }

  if (CRITERIA_KEYS.has(key)) {
    return { routable: true, flag: "criterion", values: [value] };
  }

  // policy key
  const policyValue = ENABLED_DISABLED_POLICY_KEYS.has(key) ? normalizeEnabledDisabled(value) : value;
  return { routable: true, flag: "policy", value: policyValue };
}
