/**
 * @module sdk/graph/governance-contracts
 *
 * Shared, runtime-visible relationship-audit finding identifiers used by the
 * live audit and backward-compatible durable baseline decoder. Keeping the
 * tuple authoritative prevents the public type and persisted zero census from
 * drifting when a finding family is added.
 */

/** Stable machine-readable relationship audit finding families. */
export const RELATIONSHIP_AUDIT_FINDING_CODES = [
  "missing_reference_active",
  "missing_reference_terminal",
  "legacy_no_blocker_sentinel",
  "ordering_cycle",
  "legacy_ordering_cycle",
  "ordering_storage_contradiction",
  "legacy_ordering_storage_contradiction",
  "hierarchy_cycle",
  "legacy_hierarchy_cycle",
  "hierarchy_cardinality_violation",
  "legacy_hierarchy_cardinality_violation",
  "hierarchy_direction_violation",
  "legacy_hierarchy_direction_violation",
  "duplicate_edge",
  "legacy_duplicate_edge",
  "duplicate_dependency_row",
  "legacy_duplicate_dependency_row",
  "stale_lifecycle_block",
  "isolated_active_node",
  "sparse_active_node",
] as const;

/** Machine-readable identifier for one relationship audit finding family. */
export type RelationshipAuditFindingCode =
  (typeof RELATIONSHIP_AUDIT_FINDING_CODES)[number];
