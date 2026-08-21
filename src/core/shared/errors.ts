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
  /** Positional tokens paired with their parser roles for unambiguous recovery. */
  parsed_positionals?: Array<{ role: string; value: string }>;
  /** Value that configures or reports provided fields for this contract. */
  provided_fields?: string[];
  /** Value that configures or reports missing for this contract. */
  missing?: string[];
  /** Value that configures or reports missing required fields for this contract. */
  missing_required_fields?: string[];
  /** Value that configures or reports suggested flags for this contract. */
  suggested_flags?: string[];
  /** Complete allowed value set for a refused positional or enum token. */
  allowed_values?: string[];
  /** Ranked command paths that accept an option rejected on the attempted path. */
  candidate_commands?: string[];
  /** Complete number of accepting command paths before the recovery ceiling. */
  candidate_commands_total?: number;
  /** Whether additional accepting command paths were omitted from this payload. */
  candidate_commands_truncated?: boolean;
  /** Declared lexicon membership of an option rejected by the attempted path. */
  option_scope?: "declared_on_path" | "declared_elsewhere" | "declared_nowhere";
  /** Value that configures or reports suggested retry for this contract. */
  suggested_retry?: string;
  /** Tokenized retry arguments for direct execution without reparsing display text. */
  suggested_retry_args?: string[];
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
  /** Stable failure class within the operation-specific error code. */
  reason?: string;
  /** Metadata field responsible for a validation failure, when known. */
  field?: string;
  /** Assurance gate whose evaluation was refused, when known. */
  gate_id?: string;
  /** Assurance assertion whose evaluation was refused, when known. */
  assertion_id?: string;
  /** Assurance measurement whose source could not resolve, when known. */
  measurement_id?: string;
  /** Assurance measurement source kind involved in a refusal, when known. */
  source_kind?: string;
  /** Source item whose endpoint metadata violated a relationship contract. */
  source_id?: string;
  /** Source item creation time used to evaluate a temporal relationship contract. */
  source_created_at?: string;
  /** Target item whose endpoint metadata violated a relationship contract. */
  target_id?: string;
  /** Target item creation time used to evaluate a temporal relationship contract. */
  target_created_at?: string;
  /** Temporal relationship rule evaluated for the source and target. */
  temporal_order?: string;
  /** Validate or health check selected by an assurance source, when known. */
  check?: string;
  /** Serialization format involved in a parse failure. */
  format?: string;
  /** CLI flag whose supplied value violated a shared mutation grammar. */
  flag?: string;
  /** Supplied scalar value that violated a shared mutation grammar. */
  value?: string;
  /** Item format version involved in a compatibility failure. */
  format_version?: number;
  /** Schema type that determines the shape and validation rules for this value. */
  type?: string;
  /** Value that configures or reports required for this contract. */
  required?: string;
  /** Value that configures or reports why for this contract. */
  why?: string;
  /** Filesystem path selected by target resolution, when relevant. */
  resolved_path?: string;
  /** Filesystem path from which target resolution began, when relevant. */
  requested_path?: string;
  /** Safer explicit filesystem target suggested for recovery. */
  suggested_path?: string;
  /** Value that configures or reports examples for this contract. */
  examples?: string[];
  /** Value that configures or reports next steps for this contract. */
  nextSteps?: string[];
  /** Exact selectors that could not be matched by a lossless removal. */
  unmatched?: string[];
  /** Dependency selectors that matched no stored edge. */
  unmatched_selectors?: Array<{
    id: string;
    kind?: string;
    source_kind?: string;
    author?: string;
    created_at?: string;
  }>;
  /** Compact stored dependency identities available when a removal failed. */
  available_dependencies?: Array<{
    id: string;
    kind: string;
    source_kind?: string;
    author?: string;
    created_at?: string;
  }>;
  /** Exact verifier findings that caused an integrity-sensitive operation to refuse. */
  verification_errors?: string[];
  /** Local dependency targets that could not be resolved before mutation. */
  unresolved_targets?: string[];
  /** Available history bounds for a failed point-in-time read or restore target. */
  valid_range?: {
    /** Earliest available one-based version, or null for an empty stream. */
    first_version: number | null;
    /** Latest available one-based version, or null for an empty stream. */
    last_version: number | null;
    /** Earliest available history timestamp, or null for an empty stream. */
    first_timestamp: string | null;
    /** Latest available history timestamp, or null for an empty stream. */
    last_timestamp: string | null;
  };
  /** Value that configures or reports recovery for this contract. */
  recovery?: PmCliErrorRecoveryPayload;
}

/** Implements the exported pm cli error runtime abstraction for core/shared/errors.ts. */
export class PmCliError extends Error {
  /** Value that configures or reports exit code for this contract. */
  public readonly exitCode: number;
  /** Stable machine-readable code mirrored from context for direct SDK consumption. */
  public readonly code?: string;
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
    this.code = context.code;
  }
}
