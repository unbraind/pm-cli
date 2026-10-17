/**
 * @module sdk/governance/health/projection
 *
 * Pure health evidence projections shared by CLI, MCP and SDK diagnostics.
 */
import type { HealthCheck, HealthResult, RunHealthOptions } from "../health.js";

/** Maximum detail sample retained by compact health projections. */
export const BRIEF_HEALTH_DETAIL_LIMIT = 8;
/** Maximum warning rows retained while blocking causes remain complete. */
export const HEALTH_WARNING_LIMIT = 100;

/** Return bounded string detail and report whether values were withheld. */
export function summarizeList(
  values: string[],
  limit: number,
): { values: string[]; truncated: boolean } {
  if (values.length <= limit) {
    return { values, truncated: false };
  }
  return {
    values: values.slice(0, limit),
    truncated: true,
  };
}

/** Count arbitrary rows while bounding the retained evidence sample. */
export function summarizeRecordList(
  value: unknown,
  limit: number,
): { count: number; sample: unknown[]; truncated: boolean } {
  if (!Array.isArray(value)) {
    return {
      count: 0,
      sample: [],
      truncated: false,
    };
  }
  return {
    count: value.length,
    sample: value.slice(0, limit),
    truncated: value.length > limit,
  };
}

function summarizeExtensionRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const record = value as Record<string, unknown>;
  return {
    layer: record.layer,
    directory: record.directory,
    name: record.name,
    version: record.version,
    enabled: record.enabled,
    status: record.status,
    has_activate: record.has_activate,
    capabilities: record.capabilities,
  };
}

/** Bound extension identity samples without retaining executable registrations. */
export function summarizeExtensionList(
  value: unknown,
  limit: number,
): { count: number; sample: unknown[]; truncated: boolean } {
  const summary = summarizeRecordList(value, limit);
  return {
    ...summary,
    sample: summary.sample.map((entry) => summarizeExtensionRecord(entry)),
  };
}

/** Count string warnings and retain a bounded sample for diagnostic output. */
export function summarizeStringList(
  value: unknown,
  limit: number,
): { count: number; sample: string[]; truncated: boolean } {
  if (!Array.isArray(value)) {
    return {
      count: 0,
      sample: [],
      truncated: false,
    };
  }
  const strings = value.filter(
    (entry): entry is string => typeof entry === "string",
  );
  return {
    count: strings.length,
    sample: strings.slice(0, limit),
    truncated: strings.length > limit,
  };
}

type HealthDetailSummarizer = (
  details: Record<string, unknown>,
  limit: number,
) => Record<string, unknown>;

function summarizeActivationMigrationStatus(
  value: unknown,
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const status = value as Record<string, unknown>;
  return {
    applied_count: status.applied_count,
    pending_count: status.pending_count,
    failed_count: status.failed_count,
  };
}

const HEALTH_DETAIL_SUMMARIZERS = {
  settings: (details, limit) => ({
    version: details.version,
    id_prefix: details.id_prefix,
    locks_ttl_seconds: details.locks_ttl_seconds,
    warnings: summarizeStringList(details.warnings, limit),
  }),
  directories: (details, limit) => ({
    required_count: Array.isArray(details.required)
      ? details.required.length
      : 0,
    optional_count: Array.isArray(details.optional)
      ? details.optional.length
      : 0,
    missing_required: summarizeStringList(details.missing_required, limit),
    missing_optional: summarizeStringList(details.missing_optional, limit),
    missing: summarizeStringList(details.missing, limit),
    strict_directories: details.strict_directories,
  }),
  settings_values: (details, limit) => ({
    warnings: summarizeStringList(details.warnings, limit),
  }),
  telemetry: (details) => ({
    enabled: details.enabled,
    capture_level: details.capture_level,
    endpoint: details.endpoint,
    queue_exists: details.queue_exists,
    queue_entries: details.queue_entries,
    queue_draining: details.queue_draining,
    queue_invalid_rows: details.queue_invalid_rows,
    queue_rows_total: details.queue_rows_total,
    last_successful_flush_at: details.last_successful_flush_at,
    last_failed_flush_at: details.last_failed_flush_at,
    endpoint_probe: details.endpoint_probe,
    env_overrides: details.env_overrides,
  }),
  extensions: (details, limit) => {
    const activation =
      typeof details.activation === "object" && details.activation !== null
        ? (details.activation as Record<string, unknown>)
        : {};
    return {
      disabled_by_flag: details.disabled_by_flag,
      discovered: summarizeExtensionList(details.discovered, limit),
      effective: summarizeExtensionList(details.effective, limit),
      loaded: summarizeExtensionList(details.loaded, limit),
      failed: summarizeRecordList(details.failed, limit),
      warnings: summarizeStringList(details.warnings, limit),
      activation: {
        failed: summarizeRecordList(activation.failed, limit),
        warnings: summarizeStringList(activation.warnings, limit),
        hook_counts: activation.hook_counts,
        command_handler_count: activation.command_handler_count,
        service_override_count: activation.service_override_count,
        renderer_override_count: activation.renderer_override_count,
        registration_counts: activation.registration_counts,
        migration_status: summarizeActivationMigrationStatus(
          activation.migration_status,
        ),
      },
      author_manifest: details.author_manifest,
      triage: details.triage,
      capability_contract: details.capability_contract,
      capability_guidance: summarizeRecordList(
        details.capability_guidance,
        limit,
      ),
      host_version_census: details.host_version_census,
    };
  },
  storage: (details, limit) => {
    // Preserve compatibility with brief payloads from older builds and extensions.
    const authorAttribution =
      typeof details.author_attribution === "object" &&
      details.author_attribution !== null
        ? (details.author_attribution as Record<string, unknown>)
        : undefined;
    return {
      ...details,
      ...(authorAttribution
        ? {
            author_attribution: {
              ...authorAttribution,
              affected_item_ids: summarizeStringList(
                authorAttribution.affected_item_ids,
                limit,
              ),
              samples: summarizeRecordList(authorAttribution.samples, limit),
            },
          }
        : {}),
    };
  },
  locks: (details) => ({
    active_lock_count: details.active_lock_count,
    stale_lock_count: details.stale_lock_count,
    unreadable_lock_count: details.unreadable_lock_count,
    unparseable_lock_count: details.unparseable_lock_count,
  }),
  integrity: (details, limit) => {
    const trackedRuntimeCache =
      typeof details.tracked_runtime_cache === "object" &&
      details.tracked_runtime_cache !== null
        ? (details.tracked_runtime_cache as Record<string, unknown>)
        : undefined;
    return {
      checked_item_files: details.checked_item_files,
      checked_history_streams: details.checked_history_streams,
      counts: details.counts,
      item_unreadable: summarizeStringList(details.item_unreadable, limit),
      item_conflict_markers: summarizeRecordList(
        details.item_conflict_markers,
        limit,
      ),
      item_parse_failures: summarizeStringList(
        details.item_parse_failures,
        limit,
      ),
      tracked_runtime_cache:
        trackedRuntimeCache === undefined
          ? details.tracked_runtime_cache
          : {
              ...trackedRuntimeCache,
              tracked_paths: summarizeStringList(
                trackedRuntimeCache.tracked_paths,
                limit,
              ),
            },
      history_unreadable: summarizeStringList(
        details.history_unreadable,
        limit,
      ),
      history_conflict_markers: summarizeRecordList(
        details.history_conflict_markers,
        limit,
      ),
      history_invalid_json: summarizeRecordList(
        details.history_invalid_json,
        limit,
      ),
      skipped: details.skipped,
    };
  },
  history_drift: (details, limit) => {
    const cacheConfirmation =
      typeof details.cache_confirmation === "object" &&
      details.cache_confirmation !== null
        ? (details.cache_confirmation as Record<string, unknown>)
        : undefined;
    return {
      checked_items: details.checked_items,
      cache_hit_verification: details.cache_hit_verification,
      cache_confirmation:
        cacheConfirmation === undefined
          ? details.cache_confirmation
          : {
              ...cacheConfirmation,
              candidate_items: summarizeStringList(
                cacheConfirmation.candidate_items,
                limit,
              ),
              confirmed_items: summarizeStringList(
                cacheConfirmation.confirmed_items,
                limit,
              ),
              resolved_false_positive_items: summarizeStringList(
                cacheConfirmation.resolved_false_positive_items,
                limit,
              ),
            },
      counts: details.counts,
      drifted_items: summarizeStringList(details.drifted_items, limit),
      merge_receipt_attributed_items: summarizeStringList(
        details.merge_receipt_attributed_items,
        limit,
      ),
      missing_streams: summarizeStringList(details.missing_streams, limit),
      unreadable_streams: summarizeStringList(
        details.unreadable_streams,
        limit,
      ),
      hash_mismatches: summarizeStringList(details.hash_mismatches, limit),
      chain_mismatches: summarizeStringList(details.chain_mismatches, limit),
      version_skews: summarizeStringList(details.version_skews, limit),
      workspace_state_mismatches: summarizeStringList(
        details.workspace_state_mismatches,
        limit,
      ),
      workspace_state_missing: summarizeStringList(
        details.workspace_state_missing,
        limit,
      ),
      workspace_state_unreadable: summarizeStringList(
        details.workspace_state_unreadable,
        limit,
      ),
      skipped: details.skipped,
    };
  },
  vectorization: (details, limit) => ({
    semantic_runtime_available: details.semantic_runtime_available,
    compatibility_mode_auto_defaults: details.compatibility_mode_auto_defaults,
    auto_ollama_defaults_applied: details.auto_ollama_defaults_applied,
    auto_ollama_defaults_skipped_reason:
      details.auto_ollama_defaults_skipped_reason,
    auto_ollama_defaults_remediation: details.auto_ollama_defaults_remediation,
    refresh_policy: details.refresh_policy,
    provider_active: details.provider_active,
    vector_store_active: details.vector_store_active,
    items: details.items,
    ledger_entries_before: details.ledger_entries_before,
    stale_items_before_total: details.stale_items_before_total,
    stale_items_before: summarizeStringList(details.stale_items_before, limit),
    refresh_attempted: details.refresh_attempted,
    refresh_skipped_reason: details.refresh_skipped_reason,
    refresh_result: details.refresh_result,
    ledger_entries_after: details.ledger_entries_after,
    stale_items_after_total: details.stale_items_after_total,
    stale_items_after: summarizeStringList(details.stale_items_after, limit),
    skipped: details.skipped,
  }),
} satisfies Record<HealthCheck["name"], HealthDetailSummarizer>;

/** Summarize one health check using its diagnostic-specific detail contract. */
export function summarizeHealthCheckDetails(
  check: HealthCheck,
  limit: number,
): Record<string, unknown> {
  const summarize = HEALTH_DETAIL_SUMMARIZERS[check.name];
  return summarize ? summarize(check.details, limit) : check.details;
}

/** Keep healthy extension verdicts independent of registry size; explicit full output restores the registry. */
function summarizeHealthyExtensionDetails(check: HealthCheck): Record<string, unknown> {
  return {
    disabled_by_flag: check.details.disabled_by_flag,
    loaded_count: Array.isArray(check.details.loaded) ? check.details.loaded.length : 0,
    failed_count: 0,
    warning_count: 0,
    restore_with: "pm health --full",
  };
}

/** Never expand a check merely by wrapping short evidence in sample metadata. */
function boundedHealthCheckDetails(check: HealthCheck): Record<string, unknown> {
  if (check.name === "extensions" && check.status === "ok") return summarizeHealthyExtensionDetails(check);
  const summarized = summarizeHealthCheckDetails(check, BRIEF_HEALTH_DETAIL_LIMIT);
  return Buffer.byteLength(JSON.stringify(summarized)) < Buffer.byteLength(JSON.stringify(check.details)) ? summarized : check.details;
}

/** Bound diagnostic detail and warnings while retaining every blocking cause and the authoritative verdict. */
function applyBriefHealthProjection(result: HealthResult): HealthResult {
  const warningsSummary = summarizeStringList(
    result.warnings,
    BRIEF_HEALTH_DETAIL_LIMIT,
  );
  return {
    ok: result.ok,
    ...(result.verdict ? { verdict: result.verdict } : {}),
    checks: result.checks.map((check) => ({
      name: check.name,
      status: check.status,
      ok: check.ok,
      details: boundedHealthCheckDetails(check),
    })),
    warnings: warningsSummary.sample,
    findings: result.findings.filter(
      (finding) =>
        warningsSummary.sample.includes(finding.warning) ||
        result.failed_because.includes(finding.warning),
    ),
    failed_because: result.failed_because,
    projection: {
      mode: "brief",
      warning_count: warningsSummary.count,
      warnings_truncated: warningsSummary.truncated,
      detail_limit: BRIEF_HEALTH_DETAIL_LIMIT,
    },
    generated_at: result.generated_at,
  };
}

function isSkippedHealthCheck(check: HealthCheck): boolean {
  return check.details.skipped === true;
}

/** Emit verdicts for checks that ran, retain blocking causes, and name omitted checks for recovery. */
function applySummaryHealthProjection(result: HealthResult): HealthResult {
  const warningsSummary = summarizeStringList(
    result.warnings,
    BRIEF_HEALTH_DETAIL_LIMIT,
  );
  const omittedChecks = result.checks
    .filter(isSkippedHealthCheck)
    .map((check) => check.name);
  return {
    ok: result.ok,
    ...(result.verdict ? { verdict: result.verdict } : {}),
    checks: result.checks
      .filter((check) => !isSkippedHealthCheck(check))
      .map((check) => ({
        name: check.name,
        status: check.status,
        ok: check.ok,
        details: {},
      })),
    warning_count: warningsSummary.count,
    warnings: warningsSummary.sample,
    findings: result.findings.filter(
      (finding) =>
        warningsSummary.sample.includes(finding.warning) ||
        result.failed_because.includes(finding.warning),
    ),
    failed_because: result.failed_because,
    projection: {
      mode: "summary",
      warning_count: warningsSummary.count,
      warnings_truncated: warningsSummary.truncated,
      detail_limit: BRIEF_HEALTH_DETAIL_LIMIT,
      omitted_checks: omittedChecks,
    },
    generated_at: result.generated_at,
  };
}

/** Select the requested evidence projection after computing the authoritative verdict. */
function selectHealthProjection(result: HealthResult, options: RunHealthOptions, summaryMode: boolean): HealthResult {
  if (options.full === true) return result;
  if (summaryMode) return applySummaryHealthProjection(result);
  if (options.brief === true) return applyBriefHealthProjection(result);
  return {
    ...result,
    checks: result.checks.map((check) => check.name === "extensions" && check.status === "ok"
      ? { ...check, details: summarizeHealthyExtensionDetails(check) }
      : check),
    projection: {
      mode: "standard",
      warning_count: result.warning_count!,
      warnings_truncated: result.warnings_truncated === true,
      detail_limit: BRIEF_HEALTH_DETAIL_LIMIT,
    },
  };
}

/** Bound health warnings and select evidence without changing the computed verdict. */
export function projectHealthResult(
  result: HealthResult,
  options: RunHealthOptions,
  summaryMode: boolean,
): HealthResult {
  const warningCount = result.warning_count ?? result.warnings.length;
  const boundedResult: HealthResult = {
    ...result,
    warning_count: warningCount,
    warning_limit: HEALTH_WARNING_LIMIT,
    warnings_truncated: warningCount > HEALTH_WARNING_LIMIT,
    warnings: result.warnings.slice(0, HEALTH_WARNING_LIMIT),
    findings: (result.findings ?? []).filter(
      (finding) =>
        result.warnings
          .slice(0, HEALTH_WARNING_LIMIT)
          .includes(finding.warning) ||
        result.failed_because.includes(finding.warning),
    ),
  };
  const projected = selectHealthProjection(boundedResult, options, summaryMode);
  return {
    ...projected,
    warning_count: warningCount,
    warning_limit: HEALTH_WARNING_LIMIT,
    warnings_truncated: warningCount > projected.warnings.length,
    ...(projected.projection
      ? {
          projection: {
            ...projected.projection,
            warning_count: warningCount,
            warnings_truncated: warningCount > projected.warnings.length,
          },
        }
      : {}),
  };
}
