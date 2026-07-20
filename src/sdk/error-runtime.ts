/**
 * @module sdk/error-runtime
 *
 * Provides presentation-independent normalization for values thrown through CLI and SDK runtimes.
 */
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError } from "../core/shared/errors.js";

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
