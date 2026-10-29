/**
 * @module sdk/error-runtime
 *
 * Provides presentation-independent normalization for values thrown through CLI and SDK runtimes.
 */
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError, type PmCliErrorContext } from "../core/shared/errors.js";
import type { CommandHandlerResult } from "../core/extensions/extension-types.js";

/** An unexpected handler fault with the host's structured diagnostics and original cause. */
export class ExtensionCommandError extends PmCliError {
  /** Retain the original fault without exposing it in serialized result metadata. */
  constructor(message: string, context: PmCliErrorContext, cause: unknown) {
    super(message, EXIT_CODE.GENERIC_FAILURE, context);
    this.name = "ExtensionCommandError";
    Object.defineProperty(this, "cause", { value: cause, configurable: true, writable: true });
  }
}

/** Wrap one unexpected handler failure consistently for CLI and custom SDK hosts. */
export function createExtensionCommandError(
  command: string,
  result: Pick<CommandHandlerResult, "warnings" | "errorMessage" | "errorCode" | "remediation" | "cause">,
): ExtensionCommandError {
  const warning = result.warnings[0] ?? "extension_command_handler_failed";
  const message = result.errorMessage?.trim();
  return new ExtensionCommandError(
    `Command "${command}" failed in extension handler (${warning}).${message ? ` ${message}` : ""}`,
    { code: result.errorCode ?? "command_failed", nextSteps: result.remediation ? [result.remediation] : undefined },
    result.cause,
  );
}

/** Returns a stable message for errors and unknown thrown values. */
export function describeUnknownError(error: unknown): string {
  if (error instanceof PmCliError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Unknown failure";
}

/** Reads a finite numeric exit code from an arbitrary thrown value. */
export function readThrownExitCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("exitCode" in error)) {
    return undefined;
  }
  const exitCode = (error as { exitCode?: unknown }).exitCode;
  return typeof exitCode === "number" && Number.isFinite(exitCode)
    ? exitCode
    : undefined;
}

/** Normalizes thrown exit codes to a positive integer failure status. */
export function normalizeThrownExitCode(exitCode: number): number {
  const normalized = Math.trunc(exitCode);
  return normalized > EXIT_CODE.SUCCESS
    ? normalized
    : EXIT_CODE.GENERIC_FAILURE;
}

/** Identifies errors emitted by Commander without importing its private classes. */
export function isCommanderError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    (error as { code: string }).code.startsWith("commander.")
  );
}

/** Converts non-Error thrown values into errors suitable for Sentry capture. */
export function wrapThrownErrorForSentry(
  error: unknown,
  message: string,
): Error {
  if (error instanceof Error) {
    return error;
  }
  const wrapped = new Error(message) as Error & { exitCode?: number };
  const exitCode = readThrownExitCode(error);
  /* c8 ignore next */
  if (exitCode !== undefined) {
    wrapped.exitCode = normalizeThrownExitCode(exitCode);
  }
  return wrapped;
}
