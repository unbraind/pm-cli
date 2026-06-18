/**
 * @module sdk/errors
 *
 * Defines public SDK APIs and package-author helpers for Errors.
 */
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError, type PmCliErrorContext } from "../core/shared/errors.js";

export const PM_CLI_EXPECTED_ERROR_NAME = "PmCliError";

/**
 * Documents the pm cli expected error payload exchanged by command, SDK, and package integrations.
 */
export interface PmCliExpectedError extends Error {
  name: typeof PM_CLI_EXPECTED_ERROR_NAME;
  exitCode: number;
  context: PmCliErrorContext;
  cause?: unknown;
}

/**
 * Documents the create pm cli expected error options payload exchanged by command, SDK, and package integrations.
 */
export interface CreatePmCliExpectedErrorOptions {
  exitCode?: number;
  context?: PmCliErrorContext;
  cause?: unknown;
}

function normalizeExpectedErrorExitCode(value: number): number {
  if (!Number.isFinite(value)) {
    throw new TypeError("createPmCliExpectedError options.exitCode must be a finite number");
  }
  const normalized = Math.trunc(value);
  if (normalized <= EXIT_CODE.SUCCESS) {
    throw new TypeError("createPmCliExpectedError options.exitCode must be a positive exit code");
  }
  return normalized;
}

/**
 * Create a package-safe expected CLI error.
 *
 * The CLI and Sentry filtering rely on the public error shape rather than a
 * shared class identity, so package authors can throw this from bundled,
 * linked, or separately installed extension code.
 */
export function createPmCliExpectedError(
  message: string,
  options: CreatePmCliExpectedErrorOptions = {},
): PmCliExpectedError {
  if (typeof message !== "string" || message.trim().length === 0) {
    throw new TypeError("createPmCliExpectedError message must be a non-empty string");
  }
  const error = new PmCliError(
    message,
    normalizeExpectedErrorExitCode(options.exitCode ?? EXIT_CODE.USAGE),
    options.context ?? {},
  ) as PmCliExpectedError;
  if ("cause" in options) {
    Object.defineProperty(error, "cause", {
      value: options.cause,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return error;
}

/**
 * Implements check whether pm cli expected error for the public runtime surface of this module.
 */
export function isPmCliExpectedError(error: unknown): error is PmCliExpectedError {
  if (!(error instanceof Error) || error.name !== PM_CLI_EXPECTED_ERROR_NAME) {
    return false;
  }
  const candidate = error as Partial<PmCliExpectedError>;
  return typeof candidate.exitCode === "number" && Number.isFinite(candidate.exitCode);
}
