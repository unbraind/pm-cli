import { getSentry } from "./instrument.js";
import { PmCliError } from "../shared/errors.js";
import type { TelemetryErrorCategory } from "../shared/constants.js";
import type { Span } from "@sentry/node";

let activeCommandSpan: Span | undefined;

export function sentrySetCommandContext(
  command: string,
  args: string[],
  options: Record<string, unknown>,
): void {
  const Sentry = getSentry();
  if (!Sentry) return;

  Sentry.setTag("pm.command", command);

  const safeArgs = args.map((arg) =>
    arg.startsWith("--") ? arg.split("=")[0] : arg,
  );

  Sentry.setContext("pm.command", {
    name: command,
    args: safeArgs,
    option_keys: Object.keys(options).sort(),
  });

  Sentry.addBreadcrumb({
    category: "pm.command",
    message: `pm ${command}`,
    level: "info",
    data: { args: safeArgs },
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

export function sentryFinishCommandSpan(ok: boolean, error?: string): void {
  if (!activeCommandSpan) return;
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
}): void {
  const Sentry = getSentry();
  if (!Sentry) return;

  const payload = {
    "pm.command": params.command,
    "pm.error_code": params.error_code,
    "pm.error_category": params.error_category,
    "pm.exit_code": params.exit_code,
    "pm.error_message": params.error_message,
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
