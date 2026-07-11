/**
 * @module sdk/errors
 *
 * Defines public SDK APIs and package-author helpers for Errors.
 */
import { EXIT_CODE } from "../core/shared/constants.js";
import { PmCliError, type PmCliErrorContext } from "../core/shared/errors.js";

/**
 * The `Error.name` value carried by every {@link PmCliExpectedError}. The CLI's
 * top-level handler and the Sentry crash filter recognise expected errors by
 * matching this exact string rather than by `instanceof`, so an error thrown
 * from a separately bundled or linked extension is still treated as expected.
 */
export const PM_CLI_EXPECTED_ERROR_NAME = "PmCliError";

/**
 * The public, class-free shape of an "expected" pm CLI error: a user- or
 * environment-caused failure that should exit with a specific code and be
 * excluded from crash reporting. Package authors detect it structurally with
 * {@link isPmCliExpectedError} instead of importing the internal `PmCliError`
 * class, which keeps the contract stable across bundling boundaries.
 */
export interface PmCliExpectedError extends Error {
  /** Discriminant tag; always {@link PM_CLI_EXPECTED_ERROR_NAME}. */
  name: typeof PM_CLI_EXPECTED_ERROR_NAME;
  /** Positive process exit code the CLI should terminate with for this failure. */
  exitCode: number;
  /** Structured, secret-free metadata attached for diagnostics and error guidance. */
  context: PmCliErrorContext;
  /** Optional underlying error that triggered this one, preserved for cause chaining. */
  cause?: unknown;
}

/**
 * Options accepted by {@link createPmCliExpectedError}. Every field is optional;
 * omitted values default to the CLI usage exit code, an empty context, and no
 * `cause`.
 */
export interface CreatePmCliExpectedErrorOptions {
  /** Positive exit code to assign; defaults to the usage-error code. Non-finite or non-positive values throw. */
  exitCode?: number;
  /** Structured, secret-free diagnostic metadata to attach to the error. */
  context?: PmCliErrorContext;
  /** Underlying error to retain as a non-enumerable `cause` when provided. */
  cause?: unknown;
}

function normalizeExpectedErrorExitCode(value: number): number {
  if (!Number.isFinite(value)) {
    throw new TypeError(
      "createPmCliExpectedError options.exitCode must be a finite number",
    );
  }
  const normalized = Math.trunc(value);
  if (normalized <= EXIT_CODE.SUCCESS) {
    throw new TypeError(
      "createPmCliExpectedError options.exitCode must be a positive exit code",
    );
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
    throw new TypeError(
      "createPmCliExpectedError message must be a non-empty string",
    );
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

/** Implements check whether pm cli expected error for the public runtime surface of this module. */
export function isPmCliExpectedError(
  error: unknown,
): error is PmCliExpectedError {
  if (!(error instanceof Error) || error.name !== PM_CLI_EXPECTED_ERROR_NAME) {
    return false;
  }
  const candidate = error as Partial<PmCliExpectedError>;
  return (
    typeof candidate.exitCode === "number" &&
    Number.isFinite(candidate.exitCode)
  );
}
