/**
 * @module core/shared/errors
 *
 * Provides shared primitives and utilities for Errors.
 */
/**
 * Carries structured recovery guidance attached to expected pm CLI errors.
 */
export interface PmCliErrorRecoveryPayload {
  recovery_mode?: "compact";
  attempted_command?: string;
  normalized_args?: string[];
  provided_fields?: string[];
  missing?: string[];
  missing_required_fields?: string[];
  suggested_flags?: string[];
  suggested_retry?: string;
  retry_after_ms?: number;
  fallback_candidates?: Array<{
    source: string;
    command: string;
    reason: string;
  }>;
  next_best_command?: string;
}

/**
 * Documents the pm cli error context payload exchanged by command, SDK, and package integrations.
 */
export interface PmCliErrorContext {
  code?: string;
  type?: string;
  required?: string;
  why?: string;
  examples?: string[];
  nextSteps?: string[];
  recovery?: PmCliErrorRecoveryPayload;
}

/**
 * Implements the exported pm cli error runtime abstraction for core/shared/errors.ts.
 */
export class PmCliError extends Error {
  public readonly exitCode: number;
  public readonly context: PmCliErrorContext;

  constructor(message: string, exitCode: number, context: PmCliErrorContext = {}) {
    super(message);
    this.name = "PmCliError";
    this.exitCode = exitCode;
    this.context = context;
  }
}
