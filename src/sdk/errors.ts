/**
 * @module sdk/errors
 *
 * Defines public SDK APIs and package-author helpers for Errors.
 */
import { EXIT_CODE } from "../core/shared/constants.js";
import {
  PmCliError,
  type PmCliErrorContext,
  type PmTokenBudgetRecovery,
} from "../core/shared/errors.js";
import { admitPmCliErrorDetails } from "../core/shared/error-details.js";
export type {
  PmCliErrorDetailValue,
  PmCliErrorDetails,
  PmTokenBudgetRecovery,
} from "../core/shared/errors.js";
export {
  PM_CLI_ERROR_DETAILS_LIMITS,
  isPmCliErrorDetails,
  projectPmCliErrorContextDetails,
  projectPmCliErrorContextDetailsSlot,
  projectPmCliErrorDetails,
  snapshotPmCliErrorContext,
  type PmCliErrorDetailsOmission,
  type PmCliErrorDetailsRejection,
} from "../core/shared/error-details.js";

/** Accept only positive integer token counts that JSON can preserve exactly. */
function isPositiveSafeTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Validate package-carried budget advice without trusting class identity or extra fields. */
export function isPmTokenBudgetRecovery(
  value: unknown,
): value is PmTokenBudgetRecovery {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const candidate = value as Partial<PmTokenBudgetRecovery>;
  if (
    !isPositiveSafeTokenCount(candidate.requested_tokens) ||
    candidate.basis !== "canonical_retry"
  )
    return false;
  switch (candidate.minimum_status) {
    case "exact":
      return (
        isPositiveSafeTokenCount(candidate.minimum_feasible_tokens) &&
        candidate.feasible_tokens === candidate.minimum_feasible_tokens &&
        candidate.reason === undefined
      );
    case "feasible_only":
      return (
        candidate.minimum_feasible_tokens === null &&
        isPositiveSafeTokenCount(candidate.feasible_tokens) &&
        candidate.reason === undefined
      );
    case "unavailable":
      return (
        candidate.minimum_feasible_tokens === null &&
        candidate.feasible_tokens === null &&
        ["query_cost_limit", "search_limit", "output_constraints"].includes(
          candidate.reason as string,
        )
      );
    default:
      return false;
  }
}

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
  /** Stable producer-owned error code, mirrored from context when available. */
  code?: string;
  /** Structured, secret-free metadata attached for diagnostics and error guidance. */
  context: PmCliErrorContext;
  /** Optional underlying error that triggered this one, preserved for cause chaining. */
  cause?: unknown;
}

/** A refused create operation whose canonical ID already names a persisted item. */
export interface PmItemAlreadyExistsError extends PmCliExpectedError {
  /** Stable discriminator independent of the diagnostic message. */
  code: "item_already_exists";
  /** Creation conflicts preserve the existing conflict exit-code contract. */
  exitCode: typeof EXIT_CODE.CONFLICT;
  /** Canonical identity and actual persisted path for a safe subsequent read. */
  context: PmCliErrorContext & {
    /** Producer-owned existing-item discriminator. */
    code: "item_already_exists";
    /** Normalized ID of the preserved existing item. */
    id: string;
    /** Actual document path of the preserved existing item. */
    path: string;
  };
}

/**
 * Detect an existing-item create conflict across separately bundled SDKs.
 * Requires the producer code, conflict exit code and usable existing-item
 * coordinates; ownership conflicts and message lookalikes do not qualify.
 */
export function isItemAlreadyExistsError(
  error: unknown,
): error is PmItemAlreadyExistsError {
  if (
    !isPmCliExpectedError(error) ||
    error.code !== "item_already_exists" ||
    error.exitCode !== EXIT_CODE.CONFLICT
  ) {
    return false;
  }
  const context = error.context;
  return (
    typeof context === "object" &&
    context !== null &&
    context.code === "item_already_exists" &&
    typeof context.id === "string" &&
    context.id.trim().length > 0 &&
    typeof context.path === "string" &&
    context.path.trim().length > 0
  );
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
 * Snapshot producer diagnostics at construction. A malformed shape is a
 * package-author defect, so it throws here (where a package test sees it)
 * instead of silently disappearing from the refusal at render time. The
 * message names only the reason: the producer-derived path, which can echo
 * producer keys, is a non-enumerable `path` property so crash reporting of
 * the fault never serializes it. Size is data-dependent, so oversized
 * diagnostics are replaced by a host-set `details_omitted` receipt.
 */
function admitExpectedErrorContext(
  context: PmCliErrorContext | undefined,
): PmCliErrorContext {
  // A JavaScript caller may pass null; it has always meant "no context".
  if (context === undefined || context === null) return {};
  if (!Object.hasOwn(context, "details")) return context;
  const descriptor = Object.getOwnPropertyDescriptor(context, "details")!;
  // An accessor is refused without being run, like any other non-JSON value.
  if (!("value" in descriptor)) throw detailsShapeTypeError("unsupported_value", "details");
  if (descriptor.value === undefined) return context;
  const admission = admitPmCliErrorDetails(descriptor.value);
  if (admission.ok) return { ...context, details: admission.details };
  if (admission.omission.reason === "byte_limit") {
    // Record the outcome now, so later mutation of the producer's object cannot change the refusal.
    const { details: _oversized, ...rest } = context;
    return { ...rest, details_omitted: admission.omission };
  }
  throw detailsShapeTypeError(admission.omission.reason, admission.omission.path);
}

/** Package-author fault whose message carries no producer-derived text. */
function detailsShapeTypeError(reason: string, path: string | undefined): TypeError {
  const error = new TypeError(
    `createPmCliExpectedError options.context.details must be plain JSON (${reason})`,
  );
  Object.defineProperty(error, "path", { value: path, enumerable: false });
  return error;
}

/**
 * Create a package-safe expected CLI error.
 *
 * The CLI and Sentry filtering rely on the public error shape rather than a
 * shared class identity, so package authors can throw this from bundled,
 * linked, or separately installed extension code. Structured, producer-owned
 * facts belong in `context.details`: the host renders them in `--json`, text
 * and MCP refusals within `PM_CLI_ERROR_DETAILS_LIMITS` and never sends them
 * to telemetry or crash reporting.
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
    admitExpectedErrorContext(options.context),
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
  // A refusal declares its context; a bare name plus exit code is a fault that
  // must stay visible to crash reporting. Inspection itself can throw (a
  // revoked proxy fails Array.isArray); such a value is not a usable refusal.
  try {
    return (
      typeof candidate.exitCode === "number" &&
      Number.isFinite(candidate.exitCode) &&
      typeof candidate.context === "object" &&
      candidate.context !== null &&
      !Array.isArray(candidate.context)
    );
  } catch {
    return false;
  }
}
