/**
 * @module sdk/graph
 *
 * Public workspace graph toolkit: one-pass relationship assembly with
 * missing-reference governance, registry-semantics traversal (hierarchy,
 * execution order, bounded path enumeration), and the policy-aware
 * relationship audit. Everything here layers on the dependency-free kernel in
 * `sdk/relationships` and is safe for CLI, MCP, extension, and non-PM callers.
 */
export {
  assembleWorkspaceRelationshipGraph,
  collectDanglingDependencyReferences,
  collectMissingDependencyTargetIds,
  type DanglingDependencyReference,
  type DanglingDependencyReferenceSummary,
  type DependencyReferenceHolder,
  type DependencyReferenceSource,
  type WorkspaceRelationshipAssembly,
  type WorkspaceRelationshipItem,
  type WorkspaceRelationshipNodeDetails,
} from "./assembly.js";
export {
  auditWorkspaceRelationshipGraph,
  type RelationshipAuditFinding,
  type RelationshipAuditFindingCode,
  type RelationshipAuditOptions,
  type RelationshipAuditReport,
  type RelationshipAuditSeverity,
  type RelationshipCoverageProfile,
} from "./governance.js";
export {
  enumerateRelationshipPaths,
  hierarchyAncestors,
  hierarchyDescendants,
  orderingPredecessors,
  orderingSuccessors,
  type GraphPathOptions,
  type GraphTraversalOptions,
  type RelationshipPath,
} from "./traversal.js";
