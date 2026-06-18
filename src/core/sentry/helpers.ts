/**
 * @module core/sentry/helpers
 *
 * Integrates Sentry instrumentation and release diagnostics for Helpers.
 */
import { getSentry } from "./instrument.js";
import { PmCliError } from "../shared/errors.js";
import { EXIT_CODE, type TelemetryErrorCategory } from "../shared/constants.js";
import {
  deriveTelemetryCommandResolution,
  deriveTelemetryCommandTaxonomy,
  type TelemetryCommandResolution,
  type TelemetryResolutionStage,
} from "../telemetry/observability.js";
import type { Span } from "@sentry/node";

let activeCommandSpan: Span | undefined;

function setSpanAttribute(
  span: Span,
  key: string,
  value: string | number | boolean | undefined,
): void {
  if (value === undefined) {
    return;
  }
  const attributeTarget = span as unknown as { setAttribute?: (attrKey: string, attrValue: string | number | boolean) => void };
  if (typeof attributeTarget.setAttribute === "function") {
    attributeTarget.setAttribute(key, value);
  }
}

/**
 * Implements sentry set command context for the public runtime surface of this module.
 */
export function sentrySetCommandContext(
  command: string,
  args: string[],
  options: Record<string, unknown>,
  metadata?: {
    source_context?: string;
    source_context_source?: string;
  },
): void {
  const Sentry = getSentry();
  if (!Sentry) return;
  const taxonomy = deriveTelemetryCommandTaxonomy(command);

  Sentry.setTag("pm.command", command);
  Sentry.setTag("pm.command_root", taxonomy.command_root);
  Sentry.setTag("pm.command_family", taxonomy.command_family);
  if (typeof metadata?.source_context === "string" && metadata.source_context.trim().length > 0) {
    Sentry.setTag("pm.source_context", metadata.source_context);
  }

  const safeArgs = args.map((arg) =>
    arg.startsWith("--") ? arg.split("=")[0] : arg,
  );

  Sentry.setContext("pm.command", {
    name: command,
    root: taxonomy.command_root,
    leaf: taxonomy.command_leaf,
    family: taxonomy.command_family,
    args: safeArgs,
    option_keys: Object.keys(options).sort(),
    source_context: metadata?.source_context,
    source_context_source: metadata?.source_context_source,
  });

  Sentry.addBreadcrumb({
    category: "pm.command",
    message: `pm ${command}`,
    level: "info",
    data: {
      args: safeArgs,
      command_root: taxonomy.command_root,
      command_family: taxonomy.command_family,
      source_context: metadata?.source_context,
    },
  });
}

/**
 * Implements sentry start command span for the public runtime surface of this module.
 */
export function sentryStartCommandSpan(command: string): void {
  const Sentry = getSentry();
  if (!Sentry) return;

  activeCommandSpan = Sentry.startInactiveSpan({
    op: "pm.command",
    name: `pm ${command}`,
    forceTransaction: true,
  });
}

/**
 * Implements sentry finish command span for the public runtime surface of this module.
 */
export function sentryFinishCommandSpan(
  ok: boolean,
  error?: string,
  metadata?: {
    error_code?: string;
    error_category?: TelemetryErrorCategory;
    exit_code?: number;
    command_resolution?: TelemetryCommandResolution;
    resolution_stage?: TelemetryResolutionStage;
  },
): void {
  if (!activeCommandSpan) return;
  const normalizedOk = ok ? "true" : "false";
  const normalizedExitCode = typeof metadata?.exit_code === "number" ? String(metadata.exit_code) : undefined;
  const Sentry = getSentry();
  if (Sentry) {
    Sentry.setTag("pm.ok", normalizedOk);
    Sentry.setTag("pm.command_ok", normalizedOk);
    if (typeof metadata?.exit_code === "number") {
      Sentry.setTag("pm.exit_code", String(metadata.exit_code));
      Sentry.setTag("pm.command_exit_code", String(metadata.exit_code));
    }
    if (typeof metadata?.error_code === "string" && metadata.error_code.trim().length > 0) {
      Sentry.setTag("pm.error_code", metadata.error_code);
    }
    if (typeof metadata?.error_category === "string" && metadata.error_category.trim().length > 0) {
      Sentry.setTag("pm.error_category", metadata.error_category);
    }
    if (typeof metadata?.command_resolution === "string" && metadata.command_resolution.trim().length > 0) {
      Sentry.setTag("pm.command_resolution", metadata.command_resolution);
    }
    if (typeof metadata?.resolution_stage === "string" && metadata.resolution_stage.trim().length > 0) {
      Sentry.setTag("pm.resolution_stage", metadata.resolution_stage);
    }
  }
  setSpanAttribute(activeCommandSpan, "pm.ok", normalizedOk);
  setSpanAttribute(activeCommandSpan, "pm.command_ok", normalizedOk);
  setSpanAttribute(activeCommandSpan, "pm.exit_code", normalizedExitCode);
  setSpanAttribute(activeCommandSpan, "pm.command_exit_code", normalizedExitCode);
  setSpanAttribute(activeCommandSpan, "pm.error_code", metadata?.error_code);
  setSpanAttribute(activeCommandSpan, "pm.error_category", metadata?.error_category);
  setSpanAttribute(activeCommandSpan, "pm.command_resolution", metadata?.command_resolution);
  setSpanAttribute(activeCommandSpan, "pm.resolution_stage", metadata?.resolution_stage);
  activeCommandSpan.setStatus(ok ? { code: 1 } : { code: 2, message: error ?? "command_failed" });
  activeCommandSpan.end();
  activeCommandSpan = undefined;
}

/**
 * Implements sentry capture cli error for the public runtime surface of this module.
 */
export function sentryCaptureCliError(error: unknown): void {
  if (!shouldCaptureCliError(error)) return;

  const Sentry = getSentry();
  if (!Sentry) return;

  if (error instanceof Error) {
    const extras: Record<string, unknown> = {};
    if ("exitCode" in error && typeof (error as { exitCode: unknown }).exitCode === "number") {
      extras.exit_code = (error as { exitCode: number }).exitCode;
    }
    if ("context" in error && typeof (error as { context: unknown }).context === "object") {
      extras.error_context = (error as { context: unknown }).context;
    }
    Sentry.captureException(error, { extra: extras });
  } else {
    Sentry.captureException(new Error(String(error)));
  }
}

/**
 * Implements sentry log cli usage error for the public runtime surface of this module.
 */
export function sentryLogCliUsageError(params: {
  command: string;
  error_code: string;
  error_category: TelemetryErrorCategory;
  exit_code: number;
  error_message: string;
  command_resolution?: TelemetryCommandResolution;
  resolution_stage?: TelemetryResolutionStage;
  source_context?: string;
}): void {
  const Sentry = getSentry();
  if (!Sentry) return;
  const resolvedCommandResolution =
    params.command_resolution ??
    deriveTelemetryCommandResolution({
      ok: false,
      errorCode: params.error_code,
      errorCategory: params.error_category,
    });
  const resolvedResolutionStage = params.resolution_stage ?? "unknown";

  const payload = {
    "pm.command": params.command,
    "pm.error_code": params.error_code,
    "pm.error_category": params.error_category,
    "pm.exit_code": params.exit_code,
    "pm.error_message": params.error_message,
    "pm.command_resolution": resolvedCommandResolution,
    "pm.resolution_stage": resolvedResolutionStage,
    "pm.source_context": params.source_context ?? "",
  };
  const loggerCandidate = (Sentry as unknown as { logger?: { warn?: (message: string, attributes?: Record<string, unknown>) => void } })
    .logger;
  if (loggerCandidate && typeof loggerCandidate.warn === "function") {
    loggerCandidate.warn("pm_cli_usage_error", payload);
    return;
  }

  Sentry.captureMessage(`pm_cli_usage_error:${params.error_code}`, {
    level: "warning",
    tags: {
      "pm.command": params.command,
      "pm.error_code": params.error_code,
      "pm.error_category": params.error_category,
      "pm.exit_code": String(params.exit_code),
      "pm.command_resolution": resolvedCommandResolution,
      "pm.resolution_stage": resolvedResolutionStage,
      "pm.source_context": params.source_context ?? "unknown",
    },
    extra: payload,
  });
}

/**
 * Implements should capture cli error for the public runtime surface of this module.
 */
export function shouldCaptureCliError(error: unknown): boolean {
  if (error instanceof PmCliError) {
    return false;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "exitCode" in error &&
    typeof (error as { exitCode?: unknown }).exitCode === "number"
  ) {
    const exitCode = Math.trunc((error as { exitCode: number }).exitCode);
    const expectedExitCodes: ReadonlySet<number> = new Set([
      EXIT_CODE.SUCCESS,
      EXIT_CODE.USAGE,
      EXIT_CODE.NOT_FOUND,
      EXIT_CODE.CONFLICT,
    ]);
    return !expectedExitCodes.has(exitCode);
  }
  return true;
}

/**
 * Implements sentry flush for the public runtime surface of this module.
 */
export async function sentryFlush(timeoutMs = 3000): Promise<void> {
  const Sentry = getSentry();
  if (!Sentry) return;

  try {
    await Sentry.flush(timeoutMs);
  } catch {
    // Sentry flush must never block CLI exit.
  }
}
