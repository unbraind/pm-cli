/**
 * @module sdk/graph/run
 *
 * Workspace-facing `pm graph` runner: one thin orchestrator that loads the
 * tracker once, resolves the fingerprint-keyed workspace assembly through the
 * shared graph cache, and dispatches bounded traversal, path, impact,
 * analytics, governance-audit, and remediation-planning queries through the
 * public graph toolkit. Every projection is counts-first, deterministic, and
 * carries explicit cost, truncation, and cache metadata so agents can budget
 * follow-up reads without re-scanning the workspace; identical repeated
 * queries in long-lived hosts are answered from the memoized snapshot.
 */
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { pathExists } from "../../core/fs/fs-utils.js";
import { isTerminalStatus } from "../../core/item/status.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { resolveRuntimeStatusRegistry } from "../../core/schema/runtime-schema.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import { listAllItemMetadataLight } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import {
  parseDirection,
  parseKinds,
  parseMaxDepth,
  parsePositiveInteger,
} from "../dependencies.js";
import {
  analyzeGraphImpact,
  analyzeKnowledgeGraph,
  analyzeRelationshipExecution,
} from "../relationship-analytics.js";
import type { RelationshipQueryMeta } from "../relationships.js";
import {
  computeRelationshipDominators,
  detectRelationshipCommunities,
  findRedundantRelationshipEdges,
} from "./analytics.js";
import {
  assembleWorkspaceRelationshipGraph,
  type WorkspaceRelationshipAssembly,
} from "./assembly.js";
import {
  computeWorkspaceGraphFingerprint,
  workspaceGraphCache,
  type GraphCacheMetadata,
} from "./cache.js";
import {
  auditWorkspaceRelationshipGraph,
  type RelationshipAuditReport,
} from "./governance.js";
import {
  planRelationshipRemediation,
  type RelationshipRemediationStep,
} from "./remediation.js";
import {
  enumerateRelationshipPaths,
  hierarchyAncestors,
  hierarchyDescendants,
  orderingPredecessors,
  orderingSuccessors,
} from "./traversal.js";

import {
  GRAPH_SUBCOMMAND_VALUES,
  type GraphSubcommand,
} from "../cli-contracts/enum-contracts.js";

export { GRAPH_SUBCOMMAND_VALUES, type GraphSubcommand };

/** Graph subcommands that require a root item id. */
const ROOTED_SUBCOMMANDS = new Set<GraphSubcommand>([
  "ancestors",
  "descendants",
  "predecessors",
  "successors",
  "paths",
  "impact",
  "dominators",
]);

/** Default bounded sample rows returned by analyze/audit projections. */
const DEFAULT_SAMPLE_LIMIT = 10;

/** Documents the graph command options payload exchanged by command, SDK, and package integrations. */
export interface GraphCommandOptions {
  /** Restricts traversal to registered relationship kinds (repeatable or comma-separated). */
  kind?: string | string[];
  /** Maximum traversal depth as a non-negative integer. */
  maxDepth?: string | number;
  /** Maximum returned rows per bounded collection. */
  limit?: string | number;
  /** Resume a traversal after this previously returned node id. */
  after?: string;
  /** Edge orientation for paths and impact queries (outgoing, incoming, or both). */
  direction?: string;
  /** Maximum enumerated paths for the paths subcommand. */
  maxPaths?: string | number;
  /** Maximum evidence sample entries per audit finding. */
  sample?: string | number;
  /** Item ids treated as explicitly valid isolates by the audit. */
  exemptIsolate?: string | string[];
  /** Return counts-first envelopes without row collections. */
  summary?: boolean;
}

/** Cost metadata attached to every graph query projection. */
export interface GraphQueryCost {
  /** Nodes expanded while answering the query. */
  visited_nodes: number;
  /** Edges inspected while answering the query. */
  inspected_edges: number;
}

/** Result envelope for the transitive traversal subcommands. */
export interface GraphTraversalResult {
  /** Executed graph subcommand. */
  subcommand: "ancestors" | "descendants" | "predecessors" | "successors";
  /** Canonical root item id. */
  root: string;
  /** Total emitted node ids before summary suppression. */
  count: number;
  /** Whether configured bounds omitted reachable work. */
  truncated: boolean;
  /** Cursor resuming emission after the last returned node. */
  next_cursor?: string;
  /** Query cost metadata. */
  cost: GraphQueryCost;
  /** Emitted node ids in deterministic breadth-first order; absent with summary. */
  ids?: string[];
  /** Cache observability for this invocation. */
  cache?: GraphCacheMetadata;
}

/** One enumerated path projected with relationship kinds instead of raw edges. */
export interface GraphPathRow {
  /** Ordered node ids from source to target inclusive. */
  nodes: string[];
  /** Relationship kind of each traversed edge, in path order. */
  kinds: string[];
  /** Number of edges in the path. */
  length: number;
}

/** Result envelope for the paths subcommand. */
export interface GraphPathsResult {
  /** Executed graph subcommand. */
  subcommand: "paths";
  /** Canonical source item id. */
  root: string;
  /** Canonical target item id. */
  target: string;
  /** Traversal orientation used for the enumeration. */
  direction: string;
  /** Total enumerated paths before summary suppression. */
  count: number;
  /** Whether depth, path-count, or safety bounds stopped the search early. */
  truncated: boolean;
  /** Query cost metadata. */
  cost: GraphQueryCost;
  /** Enumerated paths, shortest first; absent with summary. */
  paths?: GraphPathRow[];
  /** Cache observability for this invocation. */
  cache?: GraphCacheMetadata;
}

/** One affected item row in an impact projection. */
export interface GraphImpactRow {
  /** Affected item id. */
  id: string;
  /** Shortest relationship distance from the root. */
  distance: number;
  /** Exact node path explaining why the item is affected. */
  path: string[];
}

/** Result envelope for the impact subcommand. */
export interface GraphImpactResult {
  /** Executed graph subcommand. */
  subcommand: "impact";
  /** Canonical impact-origin item id. */
  root: string;
  /** Traversal orientation used for the blast-radius walk. */
  direction: string;
  /** Total affected items before summary suppression. */
  count: number;
  /** Whether configured bounds omitted reachable work. */
  truncated: boolean;
  /** Query cost metadata. */
  cost: GraphQueryCost;
  /** Affected item rows ordered by discovery; absent with summary. */
  affected?: GraphImpactRow[];
  /** Cache observability for this invocation. */
  cache?: GraphCacheMetadata;
}

/** Bounded execution-graph projection inside an analyze result. */
export interface GraphExecutionSummary {
  /** Whether the order-bearing graph is acyclic. */
  acyclic: boolean;
  /** Nodes participating in the topological order. */
  ordered_node_count: number;
  /** Number of parallelizable topological layers. */
  layer_count: number;
  /** Total items with no open prerequisites. */
  frontier_count: number;
  /** Bounded prerequisite-free sample; absent with summary. */
  frontier?: string[];
  /** Edge count of the longest execution path. */
  critical_path_length: number;
  /** Longest deterministic execution path; absent with summary. */
  critical_path?: string[];
  /** Total genuine ordering cycles. */
  cycle_count: number;
  /** Bounded ordering-cycle sample; absent with summary. */
  cycles?: string[][];
}

/** Bounded knowledge-graph projection inside an analyze result. */
export interface GraphKnowledgeSummary {
  /** Total weakly connected components. */
  component_count: number;
  /** Node count of the largest component. */
  largest_component_size: number;
  /** Total nodes without any relationship edges. */
  orphan_count: number;
  /** Bounded orphan sample; absent with summary. */
  orphans?: string[];
  /** Bounded maximum-degree hubs; absent with summary. */
  hubs?: { id: string; degree: number }[];
}

/** Result envelope for the analyze subcommand. */
export interface GraphAnalyzeResult {
  /** Executed graph subcommand. */
  subcommand: "analyze";
  /** Total indexed graph nodes. */
  node_count: number;
  /** Total deduplicated graph edges. */
  edge_count: number;
  /** Bound applied to every sample collection. */
  sample_limit: number;
  /** Execution-order analytics over registered ordering kinds. */
  execution: GraphExecutionSummary;
  /** Structural analytics over every stored edge. */
  knowledge: GraphKnowledgeSummary;
  /** Cache observability for this invocation. */
  cache?: GraphCacheMetadata;
}

/** Result envelope for the audit subcommand. */
export interface GraphAuditResult {
  /** Executed graph subcommand. */
  subcommand: "audit";
  /** Total audit findings. */
  finding_count: number;
  /** Finding counts keyed by severity. */
  findings_by_severity: Record<string, number>;
  /** Finding counts keyed by finding code. */
  findings_by_code: Record<string, number>;
  /** Affected-subject counts keyed by severity. */
  affected_subjects_by_severity: Record<string, number>;
  /** Affected-subject counts keyed by finding code. */
  affected_subjects_by_code: Record<string, number>;
  /** Structural coverage metrics computed during the audit. */
  profile: RelationshipAuditReport["profile"];
  /** Ordered findings with bounded evidence samples; absent with summary. */
  findings?: RelationshipAuditReport["findings"];
  /** Cache observability for this invocation. */
  cache?: GraphCacheMetadata;
}

/** One bounded community row projected by the communities subcommand. */
export interface GraphCommunityRow {
  /** Lexicographically smallest member id, naming the community. */
  representative: string;
  /** Total member count before sampling. */
  size: number;
  /** Bounded sorted member sample. */
  members: string[];
}

/** Result envelope for the communities subcommand. */
export interface GraphCommunitiesResult {
  /** Executed graph subcommand. */
  subcommand: "communities";
  /** Total detected communities meeting the size floor. */
  community_count: number;
  /** Member count of the largest community. */
  largest_community_size: number;
  /** Label-propagation sweeps executed. */
  iterations: number;
  /** Whether labels stabilized before the iteration bound. */
  converged: boolean;
  /** Whether the iteration bound stopped propagation early or the sample bound omitted rows. */
  truncated: boolean;
  /** Query cost metadata. */
  cost: GraphQueryCost;
  /** Bounded community rows, largest first; absent with summary. */
  communities?: GraphCommunityRow[];
  /** Cache observability for this invocation. */
  cache?: GraphCacheMetadata;
}

/** One redundant stored edge projected with its witness path. */
export interface GraphRedundancyRow {
  /** Stored edge source id. */
  source: string;
  /** Stored edge target id. */
  target: string;
  /** Stored relationship kind. */
  kind: string;
  /** Semantic-orientation node path proving the edge is implied. */
  witness: string[];
}

/** Result envelope for the redundancy subcommand. */
export interface GraphRedundancyResult {
  /** Executed graph subcommand. */
  subcommand: "redundancy";
  /** Total redundant edges found within configured bounds. */
  redundant_count: number;
  /** Whether the row limit omitted further redundant edges. */
  truncated: boolean;
  /** Query cost metadata. */
  cost: GraphQueryCost;
  /** Redundant edge rows in deterministic scan order; absent with summary. */
  redundant?: GraphRedundancyRow[];
  /** Cache observability for this invocation. */
  cache?: GraphCacheMetadata;
}

/** One structural bottleneck row projected by the dominators subcommand. */
export interface GraphDominatorRow {
  /** Bottleneck node id. */
  id: string;
  /** Immediate dominator appearing on every root-to-node path. */
  idom: string;
  /** Reachable nodes strictly gated by this node. */
  dominated_count: number;
}

/** Result envelope for the dominators subcommand. */
export interface GraphDominatorsResult {
  /** Executed graph subcommand. */
  subcommand: "dominators";
  /** Canonical analyzed root id. */
  root: string;
  /** Traversal orientation used for reachability. */
  direction: string;
  /** Reachable node count including the root. */
  reachable_count: number;
  /** Total nodes gating at least one other reachable node. */
  bottleneck_count: number;
  /** Whether the depth bound cut reachability or the row limit omitted bottleneck rows. */
  truncated: boolean;
  /** Query cost metadata. */
  cost: GraphQueryCost;
  /** Bounded bottleneck rows, most-gating first; absent with summary. */
  bottlenecks?: GraphDominatorRow[];
  /** Cache observability for this invocation. */
  cache?: GraphCacheMetadata;
}

/** Result envelope for the dry-run remediation planning subcommand. */
export interface GraphPlanResult {
  /** Executed graph subcommand. */
  subcommand: "plan";
  /** Total derived remediation proposals before row bounding. */
  step_count: number;
  /** Proposal counts keyed by operation family. */
  steps_by_op: Record<string, number>;
  /** Proposal counts keyed by policy code. */
  steps_by_code: Record<string, number>;
  /** Total governance-audit findings the plan was derived from. */
  finding_count: number;
  /** Whether sample, scan, or row bounds omitted derivable proposals. */
  truncated: boolean;
  /** Query cost metadata. */
  cost: GraphQueryCost;
  /** Bounded proposal rows in audit severity order; absent with summary. */
  steps?: RelationshipRemediationStep[];
  /** Cache observability for this invocation. */
  cache?: GraphCacheMetadata;
}

/** Union of every graph subcommand result envelope. */
export type GraphResult =
  | GraphTraversalResult
  | GraphPathsResult
  | GraphImpactResult
  | GraphAnalyzeResult
  | GraphAuditResult
  | GraphCommunitiesResult
  | GraphRedundancyResult
  | GraphDominatorsResult
  | GraphPlanResult;

/** Fully parsed graph invocation shared by the subcommand executors. */
interface GraphInvocation {
  /** Assembled workspace relationship graph and node details. */
  assembly: WorkspaceRelationshipAssembly;
  /** Canonical registered kind filters, when provided. */
  kinds?: string[];
  /** Parsed non-negative depth bound. */
  maxDepth?: number;
  /** Parsed positive row bound. */
  limit?: number;
  /** Traversal resume cursor. */
  after?: string;
  /** Validated traversal orientation. */
  direction: "outgoing" | "incoming" | "both";
  /** Parsed positive path-count bound. */
  maxPaths?: number;
  /** Parsed positive audit sample bound. */
  sample?: number;
  /** Normalized audit isolate exemptions. */
  exemptIsolates: string[];
  /** Whether row collections are suppressed. */
  summary: boolean;
}

/** Normalize repeatable or comma-separated id options into a flat list. */
function normalizeIdList(raw: string | string[] | undefined): string[] {
  if (raw === undefined) return [];
  return (Array.isArray(raw) ? raw : [raw])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/** Validate the graph subcommand and its positional-id requirements. */
export function parseGraphSubcommand(
  raw: string,
  id: string | undefined,
  target: string | undefined,
): GraphSubcommand {
  const candidate = raw.trim().toLowerCase();
  if (!(GRAPH_SUBCOMMAND_VALUES as readonly string[]).includes(candidate)) {
    throw new PmCliError(
      `Invalid graph subcommand "${raw}". Use one of: ${GRAPH_SUBCOMMAND_VALUES.join(", ")}.`,
      EXIT_CODE.USAGE,
    );
  }
  const subcommand = candidate as GraphSubcommand;
  if (ROOTED_SUBCOMMANDS.has(subcommand) && !id?.trim()) {
    throw new PmCliError(
      `graph ${subcommand} requires an item id.`,
      EXIT_CODE.USAGE,
    );
  }
  if (subcommand === "paths" && !target?.trim()) {
    throw new PmCliError(
      "graph paths requires a source and a target item id.",
      EXIT_CODE.USAGE,
    );
  }
  return subcommand;
}

/**
 * Re-throw graph-kernel semantic option misuse (non-family kind, unknown
 * cursor, non-transitive redundancy kind) as a usage error carrying the
 * original explanation instead of an opaque crash.
 */
function rethrowGraphUsage(error: unknown): never {
  if (error instanceof TypeError)
    throw new PmCliError(error.message, EXIT_CODE.USAGE);
  throw error;
}

/** Convert traversal metadata into the shared cost/truncation projection. */
function projectQueryMeta(meta: RelationshipQueryMeta): {
  truncated: boolean;
  cost: GraphQueryCost;
} {
  return {
    truncated: meta.truncated,
    cost: {
      visited_nodes: meta.visitedNodes,
      inspected_edges: meta.inspectedEdges,
    },
  };
}

/** Resolve one item id case-insensitively against the assembled graph. */
function canonicalizeGraphId(
  assembly: WorkspaceRelationshipAssembly,
  raw: string,
): string {
  const wanted = raw.trim().toLowerCase();
  for (const detail of assembly.details) {
    if (
      detail.id.trim().toLowerCase() === wanted &&
      !assembly.missingIdSet.has(detail.id.toLowerCase())
    ) {
      return detail.id;
    }
  }
  throw new PmCliError(`Item ${raw} not found`, EXIT_CODE.NOT_FOUND);
}

/** Execute one transitive traversal subcommand over the assembled graph. */
function runGraphTraversal(
  subcommand: "ancestors" | "descendants" | "predecessors" | "successors",
  root: string,
  invocation: GraphInvocation,
): GraphTraversalResult {
  const walk = {
    ancestors: hierarchyAncestors,
    descendants: hierarchyDescendants,
    predecessors: orderingPredecessors,
    successors: orderingSuccessors,
  }[subcommand];
  let result;
  try {
    result = walk(invocation.assembly.graph, root, {
      ...(invocation.kinds === undefined ? {} : { kinds: invocation.kinds }),
      ...(invocation.maxDepth === undefined
        ? {}
        : { maxDepth: invocation.maxDepth }),
      ...(invocation.limit === undefined ? {} : { limit: invocation.limit }),
      ...(invocation.after === undefined ? {} : { after: invocation.after }),
    });
  } catch (error) {
    rethrowGraphUsage(error);
  }
  const meta = projectQueryMeta(result.meta);
  return {
    subcommand,
    root,
    count: result.value.length,
    ...meta,
    ...(result.meta.nextCursor === undefined
      ? {}
      : { next_cursor: result.meta.nextCursor }),
    ...(invocation.summary ? {} : { ids: result.value }),
  };
}

/** Execute the bounded simple-path enumeration subcommand. */
function runGraphPaths(
  root: string,
  target: string,
  invocation: GraphInvocation,
): GraphPathsResult {
  const result = enumerateRelationshipPaths(
    invocation.assembly.graph,
    root,
    target,
    {
      direction: invocation.direction,
      ...(invocation.kinds === undefined ? {} : { kinds: invocation.kinds }),
      ...(invocation.maxDepth === undefined
        ? {}
        : { maxDepth: invocation.maxDepth }),
      ...(invocation.maxPaths === undefined
        ? {}
        : { maxPaths: invocation.maxPaths }),
    },
  );
  return {
    subcommand: "paths",
    root,
    target,
    direction: invocation.direction,
    count: result.value.length,
    ...projectQueryMeta(result.meta),
    ...(invocation.summary
      ? {}
      : {
          paths: result.value.map((path) => ({
            nodes: path.nodes,
            kinds: path.edges.map((edge) => edge.kind),
            length: path.length,
          })),
        }),
  };
}

/** Execute the bounded blast-radius impact subcommand. */
function runGraphImpact(
  root: string,
  invocation: GraphInvocation,
): GraphImpactResult {
  const analysis = analyzeGraphImpact(invocation.assembly.graph, root, {
    direction: invocation.direction,
    ...(invocation.kinds === undefined ? {} : { kinds: invocation.kinds }),
    ...(invocation.maxDepth === undefined
      ? {}
      : { maxDepth: invocation.maxDepth }),
    ...(invocation.limit === undefined ? {} : { limit: invocation.limit }),
  });
  return {
    subcommand: "impact",
    root,
    direction: invocation.direction,
    count: analysis.affected.length,
    truncated: analysis.truncated,
    cost: {
      visited_nodes: analysis.cost.visitedNodes,
      inspected_edges: analysis.cost.inspectedEdges,
    },
    ...(invocation.summary ? {} : { affected: analysis.affected }),
  };
}

/** Execute the workspace-wide execution and knowledge analytics subcommand. */
function runGraphAnalyze(invocation: GraphInvocation): GraphAnalyzeResult {
  const graph = invocation.assembly.graph;
  const sampleLimit = invocation.limit ?? DEFAULT_SAMPLE_LIMIT;
  const execution = analyzeRelationshipExecution(graph, {
    registry: graph.registry(),
  });
  const knowledge = analyzeKnowledgeGraph(graph);
  return {
    subcommand: "analyze",
    node_count: graph.nodes().length,
    edge_count: graph.edges().length,
    sample_limit: sampleLimit,
    execution: {
      acyclic: execution.acyclic,
      ordered_node_count: execution.order.length,
      layer_count: execution.layers.length,
      frontier_count: execution.frontier.length,
      critical_path_length: execution.criticalPathLength,
      cycle_count: execution.cycles.length,
      ...(invocation.summary
        ? {}
        : {
            frontier: execution.frontier.slice(0, sampleLimit),
            critical_path: execution.criticalPath.slice(0, sampleLimit),
            cycles: execution.cycles.slice(0, sampleLimit),
          }),
    },
    knowledge: {
      component_count: knowledge.components.length,
      largest_component_size: knowledge.components[0]?.length ?? 0,
      orphan_count: knowledge.orphans.length,
      ...(invocation.summary
        ? {}
        : {
            orphans: knowledge.orphans.slice(0, sampleLimit),
            hubs: knowledge.hubs.slice(0, sampleLimit),
          }),
    },
  };
}

/** Execute the governance-audit subcommand over the assembled graph. */
function runGraphAudit(
  invocation: GraphInvocation,
  isTerminal: (status: string) => boolean,
): GraphAuditResult {
  const report = auditWorkspaceRelationshipGraph(invocation.assembly, {
    isTerminal,
    ...(invocation.sample === undefined
      ? {}
      : { maxSampleSize: invocation.sample }),
    ...(invocation.exemptIsolates.length === 0
      ? {}
      : { exemptIsolates: invocation.exemptIsolates }),
  });
  const bySeverity: Record<string, number> = {};
  const byCode: Record<string, number> = {};
  const affectedBySeverity: Record<string, number> = {};
  const affectedByCode: Record<string, number> = {};
  for (const finding of report.findings) {
    bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1;
    byCode[finding.code] = (byCode[finding.code] ?? 0) + 1;
    affectedBySeverity[finding.severity] =
      (affectedBySeverity[finding.severity] ?? 0) + finding.count;
    affectedByCode[finding.code] =
      (affectedByCode[finding.code] ?? 0) + finding.count;
  }
  return {
    subcommand: "audit",
    finding_count: report.findings.length,
    findings_by_severity: bySeverity,
    findings_by_code: byCode,
    affected_subjects_by_severity: affectedBySeverity,
    affected_subjects_by_code: affectedByCode,
    profile: report.profile,
    ...(invocation.summary ? {} : { findings: report.findings }),
  };
}

/** Execute the deterministic community-detection subcommand. */
function runGraphCommunities(
  invocation: GraphInvocation,
): GraphCommunitiesResult {
  const sampleLimit = invocation.limit ?? DEFAULT_SAMPLE_LIMIT;
  const result = detectRelationshipCommunities(invocation.assembly.graph, {
    ...(invocation.kinds === undefined ? {} : { kinds: invocation.kinds }),
  });
  const analysis = result.value;
  return {
    subcommand: "communities",
    community_count: analysis.communities.length,
    largest_community_size: analysis.communities[0]?.size ?? 0,
    iterations: analysis.iterations,
    converged: analysis.converged,
    truncated: !analysis.converged || analysis.communities.length > sampleLimit,
    cost: {
      visited_nodes: result.meta.visitedNodes,
      inspected_edges: result.meta.inspectedEdges,
    },
    ...(invocation.summary
      ? {}
      : {
          communities: analysis.communities
            .slice(0, sampleLimit)
            .map((community) => ({
              representative: community.representative,
              size: community.size,
              members: community.members.slice(0, sampleLimit),
            })),
        }),
  };
}

/** Execute the transitive-redundancy scan subcommand. */
function runGraphRedundancy(
  invocation: GraphInvocation,
): GraphRedundancyResult {
  let result;
  try {
    result = findRedundantRelationshipEdges(invocation.assembly.graph, {
      ...(invocation.kinds === undefined ? {} : { kinds: invocation.kinds }),
      ...(invocation.maxDepth === undefined
        ? {}
        : { maxDepth: invocation.maxDepth }),
      ...(invocation.limit === undefined ? {} : { limit: invocation.limit }),
    });
  } catch (error) {
    rethrowGraphUsage(error);
  }
  return {
    subcommand: "redundancy",
    redundant_count: result.value.length,
    ...projectQueryMeta(result.meta),
    ...(invocation.summary
      ? {}
      : {
          redundant: result.value.map((row) => ({
            source: row.edge.source,
            target: row.edge.target,
            kind: row.edge.kind,
            witness: row.witness,
          })),
        }),
  };
}

/** Execute the dominator/bottleneck analysis subcommand. */
function runGraphDominators(
  root: string,
  invocation: GraphInvocation,
): GraphDominatorsResult {
  const limit = invocation.limit ?? DEFAULT_SAMPLE_LIMIT;
  const result = computeRelationshipDominators(
    invocation.assembly.graph,
    root,
    {
      direction: invocation.direction,
      ...(invocation.kinds === undefined ? {} : { kinds: invocation.kinds }),
      ...(invocation.maxDepth === undefined
        ? {}
        : { maxDepth: invocation.maxDepth }),
    },
  );
  const bottlenecks = result.value.rows.filter((row) => row.dominatedCount > 0);
  return {
    subcommand: "dominators",
    root,
    direction: invocation.direction,
    reachable_count: result.value.reachableCount,
    bottleneck_count: bottlenecks.length,
    truncated: result.meta.truncated || bottlenecks.length > limit,
    cost: {
      visited_nodes: result.meta.visitedNodes,
      inspected_edges: result.meta.inspectedEdges,
    },
    ...(invocation.summary
      ? {}
      : {
          bottlenecks: bottlenecks.slice(0, limit).map((row) => ({
            id: row.id,
            idom: row.idom,
            dominated_count: row.dominatedCount,
          })),
        }),
  };
}

/** Execute the dry-run remediation planning subcommand. */
function runGraphPlan(
  invocation: GraphInvocation,
  isTerminal: (status: string) => boolean,
): GraphPlanResult {
  const limit = invocation.limit ?? DEFAULT_SAMPLE_LIMIT;
  const plan = planRelationshipRemediation(invocation.assembly, {
    isTerminal,
    redundancyLimit: limit,
    ...(invocation.sample === undefined
      ? {}
      : { maxSampleSize: invocation.sample }),
    ...(invocation.exemptIsolates.length === 0
      ? {}
      : { exemptIsolates: invocation.exemptIsolates }),
  });
  const byOp: Record<string, number> = {};
  const byCode: Record<string, number> = {};
  for (const step of plan.steps) {
    byOp[step.op] = (byOp[step.op] ?? 0) + 1;
    byCode[step.code] = (byCode[step.code] ?? 0) + 1;
  }
  return {
    subcommand: "plan",
    step_count: plan.steps.length,
    steps_by_op: byOp,
    steps_by_code: byCode,
    finding_count: plan.report.findings.length,
    truncated: plan.truncated || plan.steps.length > limit,
    cost: {
      visited_nodes: plan.cost.visitedNodes,
      inspected_edges: plan.cost.inspectedEdges,
    },
    ...(invocation.summary ? {} : { steps: plan.steps.slice(0, limit) }),
  };
}

/** Build the deterministic memoization key covering every query-shaping input. */
function buildGraphQueryKey(
  subcommand: GraphSubcommand,
  root: string | undefined,
  pathsTarget: string | undefined,
  invocation: GraphInvocation,
): string {
  return JSON.stringify({
    subcommand,
    root: root ?? null,
    target: pathsTarget ?? null,
    kinds: invocation.kinds ?? null,
    maxDepth: invocation.maxDepth ?? null,
    limit: invocation.limit ?? null,
    after: invocation.after ?? null,
    direction: invocation.direction,
    maxPaths: invocation.maxPaths ?? null,
    sample: invocation.sample ?? null,
    // The audit consumes exemptions as a case-insensitive set, so the key
    // must not distinguish logically identical spellings or orderings.
    exemptIsolates: [
      ...new Set(invocation.exemptIsolates.map((id) => id.toLowerCase())),
    ].sort(),
    summary: invocation.summary,
  });
}

/** Dispatch one parsed graph subcommand to its executor. */
function executeGraphSubcommand(
  subcommand: GraphSubcommand,
  root: string | undefined,
  pathsTarget: string | undefined,
  invocation: GraphInvocation,
  isTerminal: (status: string) => boolean,
): GraphResult {
  if (subcommand === "analyze") return runGraphAnalyze(invocation);
  if (subcommand === "audit") return runGraphAudit(invocation, isTerminal);
  if (subcommand === "plan") return runGraphPlan(invocation, isTerminal);
  if (subcommand === "communities") return runGraphCommunities(invocation);
  if (subcommand === "redundancy") return runGraphRedundancy(invocation);
  if (subcommand === "dominators") return runGraphDominators(root!, invocation);
  if (subcommand === "paths")
    return runGraphPaths(root!, pathsTarget!, invocation);
  if (subcommand === "impact") return runGraphImpact(root!, invocation);
  return runGraphTraversal(subcommand, root!, invocation);
}

/** Implements run graph for the public runtime surface of this module. */
export async function runGraph(
  subcommandRaw: string,
  id: string | undefined,
  target: string | undefined,
  options: GraphCommandOptions,
  global: GlobalOptions,
): Promise<GraphResult> {
  const subcommand = parseGraphSubcommand(subcommandRaw, id, target);
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(
      `Tracker is not initialized at ${pmRoot}. Run pm init first.`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(
    settings,
    getActiveExtensionRegistrations(),
  );
  const items = await listAllItemMetadataLight(
    pmRoot,
    settings.item_format,
    typeRegistry.type_to_folder,
    undefined,
    settings.schema,
  );
  const statusRegistry = resolveRuntimeStatusRegistry(settings.schema);
  const isTerminal = (status: string): boolean =>
    isTerminalStatus(status, statusRegistry);
  const kinds = parseKinds(options.kind);
  const lookup = workspaceGraphCache().lookup(
    pmRoot,
    computeWorkspaceGraphFingerprint(items, isTerminal),
    () => assembleWorkspaceRelationshipGraph(items, isTerminal),
  );
  const invocation: GraphInvocation = {
    assembly: lookup.assembly,
    ...(kinds === undefined ? {} : { kinds }),
    maxDepth: parseMaxDepth(options.maxDepth),
    limit: parsePositiveInteger(options.limit, "limit"),
    after: options.after?.trim() || undefined,
    direction: parseDirection(options.direction),
    maxPaths: parsePositiveInteger(options.maxPaths, "max-paths"),
    sample: parsePositiveInteger(options.sample, "sample"),
    exemptIsolates: normalizeIdList(options.exemptIsolate),
    summary: options.summary === true,
  };
  const root = ROOTED_SUBCOMMANDS.has(subcommand)
    ? canonicalizeGraphId(invocation.assembly, id!)
    : undefined;
  const pathsTarget =
    subcommand === "paths"
      ? canonicalizeGraphId(invocation.assembly, target!)
      : undefined;
  const memo = lookup.memoize(
    buildGraphQueryKey(subcommand, root, pathsTarget, invocation),
    () =>
      executeGraphSubcommand(
        subcommand,
        root,
        pathsTarget,
        invocation,
        isTerminal,
      ),
  );
  return {
    ...memo.value,
    cache: {
      fingerprint: lookup.fingerprint.slice(0, 12),
      assembly: lookup.assemblyReused ? "hit" : "miss",
      result: memo.reused ? "hit" : "miss",
    },
  };
}
