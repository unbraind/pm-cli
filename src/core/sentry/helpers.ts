import { getSentry } from "./instrument.js";
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

export async function sentryFlush(): Promise<void> {
  const Sentry = getSentry();
  if (!Sentry) return;

  try {
    await Sentry.flush(3000);
  } catch {
    // Sentry flush must never block CLI exit.
  }
}
