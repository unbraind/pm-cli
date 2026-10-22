/**
 * @module core/shared/errors
 *
 * Provides shared primitives and utilities for Errors.
 */
/** Shared request identity for each canonical retry evidence state. */
interface PmTokenBudgetRecoveryBase {
  /** Estimated tokens requested by the failed query. */
  requested_tokens: number;
  /** The emitted retry preserves selection and makes its encoding explicit. */
  basis: "canonical_retry";
}

/** Verified budget advice, narrowed by the evidence established for the preserved retry. */
export type PmTokenBudgetRecovery = PmTokenBudgetRecoveryBase & (
  | {
      /** Every smaller positive budget was checked before proving this minimum. */
      minimum_status: "exact";
      /** Verified working budget; runtime validation also requires equality with the minimum. */
      feasible_tokens: number;
      /** Proved global minimum for the canonical retry. */
      minimum_feasible_tokens: number;
      /** A successful verification has no unavailable cause. */
      reason?: undefined;
    }
  | {
      /** A working budget is verified, while a global minimum remains unproved. */
      minimum_status: "feasible_only";
      /** Verified working budget for the canonical retry. */
      feasible_tokens: number;
      /** No exact minimum is claimed for a partial search. */
      minimum_feasible_tokens: null;
      /** A successful verification has no unavailable cause. */
      reason?: undefined;
    }
  | {
      /** Bounded recovery could not establish a working budget. */
      minimum_status: "unavailable";
      /** No working budget was verified. */
      feasible_tokens: null;
      /** No minimum can be claimed without a working budget. */
      minimum_feasible_tokens: null;
      /** Why recovery could not establish a working budget within its work limits. */
      reason: "query_cost_limit" | "search_limit" | "output_constraints";
    }
);

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
  /** Bounded, verified token-budget guidance for an executable context retry. */
  token_budget?: PmTokenBudgetRecovery;
  /** Elapsed time in milliseconds for retry after. */
  retry_after_ms?: number;
  /** Milliseconds a refused lock acquisition waited before giving up. */
  waited_ms?: number;
  /** Lock generations observed to change hands while the refused acquisition waited. */
  owner_handoffs?: number;
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
  /** Admission completed before any mutation; omitted when writes may have occurred. */
  changed?: false;
  /** Value that configures or reports code for this contract. */
  code?: string;
  /** Original typed diagnostic retained when recovery also fails. */
  original_code?: string;
  /** Canonical existing item identity returned by a refused create operation. */
  id?: string;
  /** Actual persisted existing-item path returned by a refused create operation. */
  path?: string;
  /** Item whose document could not be decoded or parsed. */
  item_id?: string;
  /** Ordered mutation that failed semantic preview validation. */
  transaction_operation?: {
    /** Zero-based position in the resolved batch. */
    index: number;
    /** Mutation kind from the resolved batch. */
    op: string;
    /** Resolved target identity. */
    id: string;
  };
  /** Bounded storage coordinate for a refused preview entry; never an absolute path or link target. */
  preview_storage?: {
    /** Fixed storage category, available even when the entry name must be hidden. */
    storage_area: string;
    /** Safe tracker-relative path with portable slash separators, when available. */
    relative_entry?: string;
    /** Whether the coordinate was withheld because it was unsafe, absent, or overlong. */
    entry_redacted: boolean;
  };
  /** Verified retained deletion and the latest recoverable durable address. */
  tombstone?: {
    /** The retained stream proves the item is currently deleted. */
    deleted: true;
    /** Timestamp of the most recent recorded deletion. */
    deleted_at: string;
    /** Whether a retained materialized state has an unambiguous recovery address. */
    recoverable: boolean;
    /** Durable version before deletion, or null when compaction lost the mapping. */
    last_materialized_version: number | null;
  };
  /** Bounded policy violations explaining a refused mutation without item values. */
  policy_violations?: Array<{
    /** Stable declaration that refused the mutation. */
    policy_id: string;
    /** Requirement kind evaluated by the policy engine. */
    rule: string;
    /** Workspace-authored rationale, when declared. */
    description?: string;
    /** Required metadata paths absent from the proposed record. */
    missing_fields: string[];
  }>;
  /** Total violations before the diagnostic's three-policy ceiling. */
  policy_violation_count?: number;
  /** Exact filesystem path of the unreadable item document. */
  item_path?: string;
  /** Tracker-relative documents claiming the same item identity. */
  paths?: string[];
  /** Original document size before decoding or parsing. */
  byte_length?: number;
  /** Whether the original item document contained no bytes. */
  empty?: boolean;
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
  /** Active one-edge relationship constraint violated by a prospective mutation. */
  relationship_cardinality?: {
    /** Canonical registered relationship kind. */
    kind: string;
    /** Endpoint orientation whose multiplicity is constrained. */
    direction: "outgoing" | "incoming";
    /** Node whose one-edge constraint would be exceeded. */
    node_id: string;
    /** Distinct conflicting logical endpoints in deterministic order. */
    endpoint_ids: string[];
  };
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
  /** Lease a refused `lock_lost` commit held when it tried to commit. */
  lease?: {
    /** Principal recorded as the lease owner. */
    owner: string;
    /** When the lease's lock generation was published. */
    acquired_at: string;
    /** Stale-lock lifetime the lease was acquired under. */
    ttl_seconds: number;
    /** When the lease became reclaimable by TTL, or null for an unparseable start. */
    expires_at: string | null;
  };
  /** Lock generation observed at a refused `lock_lost` commit, or null when no lock exists. */
  current_owner?: {
    /** Principal recorded as the current lock owner. */
    owner: string;
    /** Process that published the current lock generation. */
    pid: number;
    /** When the current lock generation was published. */
    created_at: string;
    /** Stale-lock lifetime of the current lock generation. */
    ttl_seconds: number;
  } | null;
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
