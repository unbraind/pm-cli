/**
 * @module cli/runtime/telemetry-outcome
 * Derives command completion outcomes from structured results and process exit state.
 */
import { isPmSuccessfulExitCode } from "../../sdk/cli-contracts/command-exit-contracts.js";
import {
  type TelemetryCommandOutcome,
  type TelemetryCommandResolution,
  type TelemetryErrorCategory,
  type TelemetryResolutionStage,
  EXIT_CODE,
  asRecordOrNull,
  deriveTelemetryCommandResolution,
  getActiveCommandResult,
  resolveTelemetryErrorCategory
} from "../../sdk/runtime-primitives.js";

const TELEMETRY_COMMAND_RESOLUTION_SET = new Set<TelemetryCommandResolution>([
  "success",
  "nonexistent_command",
  "invalid_option",
  "missing_required_option",
  "missing_required_argument",
  "invalid_usage",
  "validation_failed",
  "health_findings",
  "validation_findings",
  "conflict",
  "runtime_failed",
  "unknown_failed",
]);

const TELEMETRY_RESOLUTION_STAGE_SET = new Set<TelemetryResolutionStage>(["parse", "preflight", "execute", "unknown"]);

const TELEMETRY_ERROR_CATEGORY_SET = new Set<TelemetryErrorCategory>(["usage", "validation", "conflict", "runtime", "unknown"]);

/** Read a string-valued field from a structured command result without coercion. */
function readRecordString(record: Record<string, unknown> | null, ...keys: string[]): string | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string") {
      const normalized = candidate.trim();
      if (normalized.length > 0) {
        return normalized;
      }
    }
  }
  return undefined;
}

/** Read a boolean-valued field from a structured command result without coercion. */
function readRecordBoolean(record: Record<string, unknown> | null, ...keys: string[]): boolean | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "boolean") {
      return candidate;
    }
  }
  return undefined;
}

/** Read a number-valued field from a structured command result without coercion. */
function readRecordNumber(record: Record<string, unknown> | null, ...keys: string[]): number | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return Math.max(0, Math.trunc(candidate));
    }
  }
  return undefined;
}

/** Accept only declared command-resolution values for telemetry receipts. */
function normalizeTelemetryCommandResolution(value: string | undefined): TelemetryCommandResolution | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!TELEMETRY_COMMAND_RESOLUTION_SET.has(normalized as TelemetryCommandResolution)) {
    return undefined;
  }
  return normalized as TelemetryCommandResolution;
}

/** Accept only declared resolution-stage values for telemetry receipts. */
function normalizeTelemetryResolutionStage(value: string | undefined): TelemetryResolutionStage | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!TELEMETRY_RESOLUTION_STAGE_SET.has(normalized as TelemetryResolutionStage)) {
    return undefined;
  }
  return normalized as TelemetryResolutionStage;
}

/** Accept only declared error-category values for telemetry receipts. */
function normalizeTelemetryErrorCategory(value: string | undefined): TelemetryErrorCategory | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!TELEMETRY_ERROR_CATEGORY_SET.has(normalized as TelemetryErrorCategory)) {
    return undefined;
  }
  return normalized as TelemetryErrorCategory;
}

/* c8 ignore start */

/** Derive a completion failure message from the command result and process outcome. */
function inferPostActionFailureMessage(result: Record<string, unknown> | null): string | undefined {
  const explicit = readRecordString(result, "error", "message");
  if (explicit) {
    return explicit;
  }

  const warnings = result?.warnings;
  if (Array.isArray(warnings)) {
    const firstWarning = warnings.find((value) => typeof value === "string" && value.trim().length > 0);
    /* c8 ignore next */
    if (typeof firstWarning === "string") {
      return firstWarning.trim();
    }
  }

  const skippedTriggered = readRecordBoolean(result, "fail_on_skipped_triggered", "failOnSkippedTriggered");
  if (skippedTriggered) {
    return "linked_test_fail_on_skipped_triggered";
  }

  const failedCount = readRecordNumber(result, "failed");
  if (typeof failedCount === "number" && failedCount > 0) {
    return `failed_runs:${failedCount}`;
  }

  const runResults = result?.run_results;
  if (Array.isArray(runResults)) {
    const failedRuns = runResults.filter((entry) => {
      const row = asRecordOrNull(entry);
      return row?.status === "failed";
    }).length;
    /* c8 ignore next */
    if (failedRuns > 0) {
      return `failed_runs:${failedRuns}`;
    }
  }

  return undefined;
}

/* c8 ignore stop */

/** Derive the canonical completion error code from the structured result. */
function inferPostActionErrorCode(ok: boolean, exitCode: number): string | undefined {
  if (ok) {
    return undefined;
  }
  if (exitCode === EXIT_CODE.USAGE) {
    return "invalid_command_usage";
  }
  if (exitCode === EXIT_CODE.NOT_FOUND) {
    return "item_not_found";
  }
  if (exitCode === EXIT_CODE.CONFLICT) {
    return "lock_conflict";
  }
  if (exitCode === EXIT_CODE.DEPENDENCY_FAILED) {
    return "dependency_failed";
  }
  return "command_failed";
}

/** Combine structured command receipts and exit state into a terminal telemetry outcome. */
function buildPostActionTelemetryOutcome(): TelemetryCommandOutcome {
  const result = asRecordOrNull(getActiveCommandResult());
  const processExitCode = typeof process.exitCode === "number" && Number.isFinite(process.exitCode) ? Math.max(0, Math.trunc(process.exitCode)) : undefined;
  const resultExitCode = readRecordNumber(result, "exit_code", "exitCode");
  const exitCode = processExitCode ?? resultExitCode ?? EXIT_CODE.SUCCESS;
  const ok = isPmSuccessfulExitCode(exitCode);
  const errorCode = readRecordString(result, "error_code", "errorCode") ?? inferPostActionErrorCode(ok, exitCode);
  const errorCategory =
    normalizeTelemetryErrorCategory(readRecordString(result, "error_category", "errorCategory")) ?? (!ok ? resolveTelemetryErrorCategory(errorCode) : undefined);
  const errorMessage = !ok ? (inferPostActionFailureMessage(result) ?? `command_exit_${exitCode}`) : undefined;
  const commandResolution =
    normalizeTelemetryCommandResolution(readRecordString(result, "command_resolution", "commandResolution")) ??
    deriveTelemetryCommandResolution({
      ok,
      errorCode,
      errorCategory,
    });
  const resolutionStage = normalizeTelemetryResolutionStage(readRecordString(result, "resolution_stage", "resolutionStage")) ?? "execute";
  return {
    ok,
    error: errorMessage,
    exit_code: exitCode,
    error_code: errorCode,
    error_category: errorCategory,
    command_resolution: commandResolution,
    resolution_stage: resolutionStage,
  };
}

export { buildPostActionTelemetryOutcome,inferPostActionErrorCode,inferPostActionFailureMessage,normalizeTelemetryCommandResolution,normalizeTelemetryErrorCategory,normalizeTelemetryResolutionStage,readRecordBoolean,readRecordNumber,readRecordString };
