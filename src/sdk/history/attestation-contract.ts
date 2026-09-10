/** @module sdk/history/attestation-contract
 * Portable, payload-free commitments to the exact bytes of history streams.
 */
import type { HistoryHashAlgorithm } from "../../core/history/digest.js";

/** Wire format, hashing rules and trust boundary for detached history proofs. */
export const PM_HISTORY_ATTESTATION_CONTRACT = {
  format: "pm-history-attestation",
  version: 1,
  stream_hash: "exact_file_bytes",
  rollup_hash: "stable_json_without_workspace_digest",
  ordering: "stream_id_code_unit_ascending",
  consistency: "per_stream_snapshot_with_change_detection",
  trust: "independently_retained_bundle",
} as const;

/** Last maintenance event, bounded independently of stream length. */
export interface HistoryAttestationMaintenance {
  /** Maintenance operation recorded in the stream. */
  op: string;
  /** Timestamp claimed by the recorded event; not trusted wall-clock proof. */
  ts: string;
  /** Record digest when the event carries whole-record integrity. */
  record_hash: string | null;
}

/** Constant-size commitment for one item, deleted-item or workspace stream. */
export interface HistoryAttestationStream {
  /** Filename stem; no path components are allowed. */
  id: string;
  /** Number of nonblank JSONL records. */
  entries: number;
  /** Exact byte length, including whitespace and line endings. */
  bytes: number;
  /** Digest of the complete file using the bundle's algorithm. */
  stream_digest: string;
  /** Latest item-state anchor, absent for an empty stream. */
  latest_after_hash: string | null;
  /** Latest whole-record digest, absent for legacy or empty streams. */
  latest_record_hash: string | null;
  /** Algorithm used by the latest entry, absent for empty streams. */
  latest_hash_algorithm: HistoryHashAlgorithm | null;
  /** Number of retained rewrite evidence records across the stream. */
  rewrite_count: number;
  /** SHA-256 commitment to the pruned prefix, when a compact checkpoint exists. */
  checkpoint_digest: string | null;
  /** Last maintenance operation visible in this snapshot. */
  last_maintenance: HistoryAttestationMaintenance | null;
}

/** Versioned detached proof; no item content, actors or filesystem roots are embedded. */
export interface HistoryAttestation {
  /** Identifies the public wire format. */
  format: typeof PM_HISTORY_ATTESTATION_CONTRACT.format;
  /** Format revision governing canonicalization and verification. */
  version: 1;
  /** Algorithm for stream byte commitments and the workspace rollup. */
  hash_algorithm: HistoryHashAlgorithm;
  /** Export timestamp bound by the rollup; an assertion, not an external timestamp. */
  generated_at: string;
  /** Sorted complete inventory of retained history streams. */
  streams: HistoryAttestationStream[];
  /** Digest of every other field using deterministic stable JSON. */
  workspace_digest: string;
}

/** Workspace selection without settings, extensions, locks or derived caches. */
export interface HistoryAttestationOptions {
  /** Explicit tracker root containing the history directory. */
  pmRoot?: string;
  /** Directory used for ordinary tracker discovery when pmRoot is omitted. */
  cwd?: string;
}

/** Optional reproducibility controls for proof export. */
export interface ExportAttestationOptions extends HistoryAttestationOptions {
  /** Defaults to SHA-256; independent of each stream's record algorithm. */
  hashAlgorithm?: HistoryHashAlgorithm;
  /** RFC 3339 timestamp for reproducible exports; defaults to current time. */
  generatedAt?: string;
}

/** Exact comparison against an independently retained proof. */
export interface HistoryAttestationVerification {
  /** True only when all attested streams verify and the complete inventory matches. */
  ok: boolean;
  /** Rollup from the validated input bundle. */
  workspace_digest: string;
  /** Number of current streams inspected, including added streams. */
  streams_checked: number;
  /** Streams whose bytes differ, even when their rewritten chains remain valid. */
  changed_streams: string[];
  /** Attested streams absent from the current inventory. */
  missing_streams: string[];
  /** Current streams absent from the attested inventory. */
  added_streams: string[];
  /** Streams that cannot be decoded, read or verified. */
  invalid_streams: string[];
  /** Digest transitions with bounded maintenance context; never silently accepted as unchanged. */
  transitions: Array<{
    /** Changed stream identity. */
    id: string;
    /** Previously attested exact-byte digest. */
    before_digest: string;
    /** Current exact-byte digest, or null if unreadable. */
    after_digest: string | null;
    /** Current maintenance marker, useful when reviewing an intentional rewrite. */
    last_maintenance: HistoryAttestationMaintenance | null;
  }>;
}
