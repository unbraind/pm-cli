import { getSentry } from "./instrument.js";
import { PmCliError } from "../shared/errors.js";
import type { TelemetryErrorCategory } from "../shared/constants.js";
import {
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

export function sentryStartCommandSpan(command: string): void {
  const Sentry = getSentry();
  if (!Sentry) return;

  activeCommandSpan = Sentry.startInactiveSpan({
    op: "pm.command",
    name: `pm ${command}`,
    forceTransaction: true,
  });
}

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
  setSpanAttribute(activeCommandSpan, "pm.ok", ok);
  setSpanAttribute(activeCommandSpan, "pm.exit_code", metadata?.exit_code);
  setSpanAttribute(activeCommandSpan, "pm.error_code", metadata?.error_code);
  setSpanAttribute(activeCommandSpan, "pm.error_category", metadata?.error_category);
  setSpanAttribute(activeCommandSpan, "pm.command_resolution", metadata?.command_resolution);
  setSpanAttribute(activeCommandSpan, "pm.resolution_stage", metadata?.resolution_stage);
  activeCommandSpan.setStatus(ok ? { code: 1 } : { code: 2, message: error ?? "command_failed" });
  activeCommandSpan.end();
  activeCommandSpan = undefined;
}

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

  const payload = {
    "pm.command": params.command,
    "pm.error_code": params.error_code,
    "pm.error_category": params.error_category,
    "pm.exit_code": params.exit_code,
    "pm.error_message": params.error_message,
    "pm.command_resolution": params.command_resolution ?? "",
    "pm.resolution_stage": params.resolution_stage ?? "",
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
      "pm.command_resolution": params.command_resolution ?? "unknown_failed",
      "pm.resolution_stage": params.resolution_stage ?? "unknown",
      "pm.source_context": params.source_context ?? "unknown",
    },
    extra: payload,
  });
}

export function shouldCaptureCliError(error: unknown): boolean {
  return !(error instanceof PmCliError);
}

export async function sentryFlush(): Promise<void> {
  const Sentry = getSentry();
  if (!Sentry) return;

  try {
    await Sentry.flush(3000);
  } catch {
    // Sentry flush must never block CLI exit.
  }
}
