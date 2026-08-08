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
  const attributeTarget = span as unknown as {
    setAttribute?: (
      attrKey: string,
      attrValue: string | number | boolean,
    ) => void;
  };
  if (typeof attributeTarget.setAttribute === "function") {
    attributeTarget.setAttribute(key, value);
  }
}

function setSentryTagIfPresent(
  Sentry: NonNullable<ReturnType<typeof getSentry>>,
  key: string,
  value: string | undefined,
): void {
  if (typeof value === "string" && value.trim().length > 0) {
    Sentry.setTag(key, value);
  }
}

function setSentryCommandFinishTags(
  Sentry: NonNullable<ReturnType<typeof getSentry>>,
  normalizedOk: string,
  metadata: Parameters<typeof sentryFinishCommandSpan>[2],
): void {
  Sentry.setTag("pm.ok", normalizedOk);
  Sentry.setTag("pm.command_ok", normalizedOk);
  if (typeof metadata?.exit_code === "number") {
    Sentry.setTag("pm.exit_code", String(metadata.exit_code));
    Sentry.setTag("pm.command_exit_code", String(metadata.exit_code));
  }
  setSentryTagIfPresent(Sentry, "pm.error_code", metadata?.error_code);
  setSentryTagIfPresent(Sentry, "pm.error_category", metadata?.error_category);
  setSentryTagIfPresent(
    Sentry,
    "pm.command_resolution",
    metadata?.command_resolution,
  );
  setSentryTagIfPresent(
    Sentry,
    "pm.resolution_stage",
    metadata?.resolution_stage,
  );
}

function setCommandSpanFinishAttributes(
  span: Span,
  normalizedOk: string,
  normalizedExitCode: string | undefined,
  metadata: Parameters<typeof sentryFinishCommandSpan>[2],
): void {
  setSpanAttribute(span, "pm.ok", normalizedOk);
  setSpanAttribute(span, "pm.command_ok", normalizedOk);
  setSpanAttribute(span, "pm.exit_code", normalizedExitCode);
  setSpanAttribute(span, "pm.command_exit_code", normalizedExitCode);
  setSpanAttribute(span, "pm.error_code", metadata?.error_code);
  setSpanAttribute(span, "pm.error_category", metadata?.error_category);
  setSpanAttribute(span, "pm.command_resolution", metadata?.command_resolution);
  setSpanAttribute(span, "pm.resolution_stage", metadata?.resolution_stage);
}

/** Implements sentry set command context for the public runtime surface of this module. */
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
  if (
    typeof metadata?.source_context === "string" &&
    metadata.source_context.trim().length > 0
  ) {
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

/** Implements sentry start command span for the public runtime surface of this module. */
export function sentryStartCommandSpan(command: string): void {
  const Sentry = getSentry();
  if (!Sentry) return;

  activeCommandSpan = Sentry.startInactiveSpan({
    op: "pm.command",
    name: `pm ${command}`,
    forceTransaction: true,
  });
}

/** Implements sentry finish command span for the public runtime surface of this module. */
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
  const normalizedExitCode =
    typeof metadata?.exit_code === "number"
      ? String(metadata.exit_code)
      : undefined;
  const Sentry = getSentry();
  if (Sentry) {
    setSentryCommandFinishTags(Sentry, normalizedOk, metadata);
  }
  setCommandSpanFinishAttributes(
    activeCommandSpan,
    normalizedOk,
    normalizedExitCode,
    metadata,
  );
  activeCommandSpan.setStatus(
    ok ? { code: 1 } : { code: 2, message: error ?? "command_failed" },
  );
  activeCommandSpan.end();
  activeCommandSpan = undefined;
}

/**
 * Tag value recorded when a captured error declares no canonical pm error code.
 *
 * The release reliability gate classifies Sentry issues from the `pm.error_code`
 * and `pm.exit_code` tags and fails closed when either is absent. Emitting this
 * sentinel keeps the producer side of that contract total: an undeclared runtime
 * fault is still classifiable (and still blocks, because it resolves to no
 * catalog contract) instead of being unjudgeable for lack of a tag.
 */
export const UNCLASSIFIED_CAPTURED_ERROR_CODE = "unclassified_runtime_error";

/**
 * Reads the declared error contract carried by a thrown value, if any.
 *
 * There is deliberately no `PmCliError` special case: `shouldCaptureCliError`
 * rejects every `PmCliError` before capture, so such a branch would be
 * unreachable — and a `PmCliError` carries a public `code` and a numeric
 * `exitCode`, so the general path below would classify it identically anyway.
 */
function readCapturedErrorContract(error: unknown): {
  error_code: string;
  exit_code: number;
} {
  const candidate =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown; exitCode?: unknown })
      : undefined;
  const hasDeclaredExitCode = typeof candidate?.exitCode === "number";
  const exitCode = hasDeclaredExitCode
    ? Math.trunc(candidate?.exitCode as number)
    : EXIT_CODE.GENERIC_FAILURE;
  // A declared pm code always travels with a numeric exit code. Requiring both
  // halves keeps a Node errno error (string `code`, no `exitCode`) from being
  // reported as though it were a catalog contract.
  const hasDeclaredErrorCode =
    typeof candidate?.code === "string" &&
    candidate.code.length > 0 &&
    hasDeclaredExitCode;
  return {
    error_code: hasDeclaredErrorCode
      ? (candidate?.code as string)
      : UNCLASSIFIED_CAPTURED_ERROR_CODE,
    exit_code: exitCode,
  };
}

/**
 * Builds the contract tags every captured event carries.
 *
 * These are attached to the event itself rather than to the ambient scope
 * because the scope writer (`sentryFinishCommandSpan`) returns early when no
 * command span is active, and the unknown-error path captures before that
 * writer runs.
 */
function buildCapturedErrorTags(error: unknown): Record<string, string> {
  const contract = readCapturedErrorContract(error);
  return {
    "pm.error_code": contract.error_code,
    "pm.exit_code": String(contract.exit_code),
  };
}

/** Implements sentry capture cli error for the public runtime surface of this module. */
export function sentryCaptureCliError(error: unknown): void {
  if (!shouldCaptureCliError(error)) return;

  const Sentry = getSentry();
  if (!Sentry) return;

  const tags = buildCapturedErrorTags(error);
  if (error instanceof Error) {
    const extras: Record<string, unknown> = {};
    if (
      "exitCode" in error &&
      typeof (error as { exitCode: unknown }).exitCode === "number"
    ) {
      extras.exit_code = (error as { exitCode: number }).exitCode;
    }
    if (
      "context" in error &&
      typeof (error as { context: unknown }).context === "object"
    ) {
      extras.error_context = (error as { context: unknown }).context;
    }
    Sentry.captureException(error, { extra: extras, tags });
  } else {
    Sentry.captureException(new Error(String(error)), { tags });
  }
}

/** Implements sentry log cli usage error for the public runtime surface of this module. */
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
  const loggerCandidate = (
    Sentry as unknown as {
      logger?: {
        warn?: (message: string, attributes?: Record<string, unknown>) => void;
      };
    }
  ).logger;
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

/** Implements should capture cli error for the public runtime surface of this module. */
export function shouldCaptureCliError(error: unknown): boolean {
  if (error instanceof PmCliError) {
    return false;
  }
  if (
    error instanceof Error &&
    error.name === "AbortError" &&
    /(?:ctrl\+c|sigint|user[- ]initiated)/i.test(error.message)
  ) {
    return false;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "exitCode" in error &&
    typeof (error as { exitCode?: unknown }).exitCode === "number"
  ) {
    if (error instanceof Error && error.name === "CommandError") {
      return false;
    }
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

/** Implements sentry flush for the public runtime surface of this module. */
export async function sentryFlush(timeoutMs = 3000): Promise<void> {
  const Sentry = getSentry();
  if (!Sentry) return;

  try {
    await Sentry.flush(timeoutMs);
  } catch {
    // Sentry flush must never block CLI exit.
  }
}
