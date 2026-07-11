/**
 * @module core/shared/errors
 *
 * Provides shared primitives and utilities for Errors.
 */
/** Carries structured recovery guidance attached to expected pm CLI errors. */
export interface PmCliErrorRecoveryPayload {
  /** Strategy used to control recovery behavior. */
  recovery_mode?: "compact";
  /** Value that configures or reports attempted command for this contract. */
  attempted_command?: string;
  /** Value that configures or reports normalized args for this contract. */
  normalized_args?: string[];
  /** Value that configures or reports provided fields for this contract. */
  provided_fields?: string[];
  /** Value that configures or reports missing for this contract. */
  missing?: string[];
  /** Value that configures or reports missing required fields for this contract. */
  missing_required_fields?: string[];
  /** Value that configures or reports suggested flags for this contract. */
  suggested_flags?: string[];
  /** Value that configures or reports suggested retry for this contract. */
  suggested_retry?: string;
  /** Elapsed time in milliseconds for retry after. */
  retry_after_ms?: number;
  /** Value that configures or reports fallback candidates for this contract. */
  fallback_candidates?: Array<{
    source: string;
    command: string;
    reason: string;
  }>;
  /** Value that configures or reports next best command for this contract. */
  next_best_command?: string;
}

/** Documents the pm cli error context payload exchanged by command, SDK, and package integrations. */
export interface PmCliErrorContext {
  /** Value that configures or reports code for this contract. */
  code?: string;
  /** Schema type that determines the shape and validation rules for this value. */
  type?: string;
  /** Value that configures or reports required for this contract. */
  required?: string;
  /** Value that configures or reports why for this contract. */
  why?: string;
  /** Value that configures or reports examples for this contract. */
  examples?: string[];
  /** Value that configures or reports next steps for this contract. */
  nextSteps?: string[];
  /** Value that configures or reports recovery for this contract. */
  recovery?: PmCliErrorRecoveryPayload;
}

/** Implements the exported pm cli error runtime abstraction for core/shared/errors.ts. */
export class PmCliError extends Error {
  /** Value that configures or reports exit code for this contract. */
  public readonly exitCode: number;
  /** Value that configures or reports context for this contract. */
  public readonly context: PmCliErrorContext;

  /** Value that configures or reports constructor for this contract. */
  constructor(
    message: string,
    exitCode: number,
    context: PmCliErrorContext = {},
  ) {
    super(message);
    this.name = "PmCliError";
    this.exitCode = exitCode;
    this.context = context;
  }
}
