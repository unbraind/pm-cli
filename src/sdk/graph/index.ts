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
  computeRelationshipDominators,
  detectRelationshipCommunities,
  findRedundantRelationshipEdges,
  type GraphCommunityOptions,
  type GraphDominatorOptions,
  type GraphRedundancyOptions,
  type RedundantRelationshipEdge,
  type RelationshipCommunity,
  type RelationshipCommunityAnalysis,
  type RelationshipDominatorAnalysis,
  type RelationshipDominatorRow,
} from "./analytics.js";
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
  collectDuplicateRelationshipEdgeGroups,
  formatDuplicateEdgeGroup,
  type DuplicateRelationshipEdgeGroup,
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
export {
  computeWorkspaceGraphFingerprint,
  resetWorkspaceGraphCache,
  workspaceGraphCache,
  WorkspaceGraphCache,
  type GraphCacheMetadata,
  type WorkspaceGraphCacheLookup,
} from "./cache.js";
export {
  planRelationshipRemediation,
  type RelationshipRemediationCode,
  type RelationshipRemediationConfidence,
  type RelationshipRemediationOperation,
  type RelationshipRemediationPlan,
  type RelationshipRemediationPlanOptions,
  type RelationshipRemediationStep,
} from "./remediation.js";
export { collectNewOrderingCycleWarnings } from "./mutation-advisory.js";
export {
  GRAPH_SUBCOMMAND_VALUES,
  parseGraphSubcommand,
  runGraph,
  type GraphAnalyzeResult,
  type GraphAuditResult,
  type GraphCommandOptions,
  type GraphCommunitiesResult,
  type GraphCommunityRow,
  type GraphDominatorRow,
  type GraphDominatorsResult,
  type GraphExecutionSummary,
  type GraphImpactResult,
  type GraphImpactRow,
  type GraphKnowledgeSummary,
  type GraphPathRow,
  type GraphPathsResult,
  type GraphPlanResult,
  type GraphQueryCost,
  type GraphRedundancyResult,
  type GraphRedundancyRow,
  type GraphResult,
  type GraphSubcommand,
  type GraphTraversalResult,
} from "./run.js";
