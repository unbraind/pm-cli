/**
 * @module sdk/graph/governance
 *
 * Policy-aware relationship-graph quality audit shared by validation, health,
 * and package governance surfaces. The audit inspects one assembled workspace
 * graph and reports machine-readable findings — integrity gaps, ordering
 * cycles, duplicated edge spellings, stale lifecycle blocks, and coverage
 * outliers — without inventing edges or assuming that sparse connectivity is
 * defective. Findings gate severity on lifecycle: contradictions confined to
 * terminal items downgrade to informational `legacy_*` codes because repairing
 * them would mutate closed history. Every finding names the violated policy,
 * carries a deterministic bounded sample, and proposes a safe next action so
 * agents can plan remediation without re-deriving context.
 */
import type { RelationshipEdge } from "../relationships.js";
import {
  isTransitiveKind,
  orientTransitiveEdge,
  transitiveFamilyKey,
} from "./analytics.js";
import type { WorkspaceRelationshipAssembly } from "./assembly.js";

/** Severity ladder shared by every relationship audit finding. */
export type RelationshipAuditSeverity = "error" | "warning" | "info";

/** Machine-readable identifier for one relationship audit finding family. */
export type RelationshipAuditFindingCode =
  | "missing_reference_active"
  | "missing_reference_terminal"
  | "legacy_no_blocker_sentinel"
  | "ordering_cycle"
  | "legacy_ordering_cycle"
  | "duplicate_edge"
  | "legacy_duplicate_edge"
  | "duplicate_dependency_row"
  | "legacy_duplicate_dependency_row"
  | "stale_lifecycle_block"
  | "isolated_active_node"
  | "sparse_active_node";

/** One policy-aware relationship audit finding with bounded evidence. */
export interface RelationshipAuditFinding {
  /** Machine-readable finding family identifier. */
  code: RelationshipAuditFindingCode;
  /** Severity of the violated policy. */
  severity: RelationshipAuditSeverity;
  /** Policy statement this finding violates. */
  policy: string;
  /** Human-readable summary including the affected count. */
  message: string;
  /** Total number of affected subjects, independent of sample bounding. */
  count: number;
  /** Deterministic bounded sample of affected subjects. */
  sample: string[];
  /** Whether {@link sample} was truncated by the configured sample bound. */
  sample_truncated: boolean;
  /** Safe machine-actionable next step; audits never invent or auto-apply edges. */
  remediation: string;
}

/** Per-item-type connectivity coverage inside a coverage profile. */
export interface RelationshipCoverageTypeProfile {
  /** Active nodes declaring this item type. */
  active: number;
  /** Active nodes of this type with no incident edges. */
  isolated: number;
  /** Active nodes of this type with at most one incident edge, isolates included. */
  degree_leq_one: number;
}

/** Aggregate structural coverage metrics for one assembled workspace graph. */
export interface RelationshipCoverageProfile {
  /** Total indexed nodes including materialized missing placeholders. */
  nodes: number;
  /** Total deduplicated indexed edges. */
  edges: number;
  /** Deterministic per-kind edge counts. */
  edges_by_kind: Record<string, number>;
  /** Nodes whose lifecycle status is active (non-terminal, non-missing). */
  active_nodes: number;
  /** Materialized placeholder nodes for referenced-but-absent items. */
  missing_nodes: number;
  /** Active nodes with no incident edges at all. */
  isolated_active_nodes: number;
  /** Active nodes with at most one incident edge, isolates included. */
  degree_leq_one_active_nodes: number;
  /** Deterministic per-type connectivity coverage; untyped nodes bucket under `(untyped)`. */
  coverage_by_type: Record<string, RelationshipCoverageTypeProfile>;
}

/** Tuning and policy inputs accepted by the relationship audit. */
export interface RelationshipAuditOptions {
  /** Terminal-lifecycle predicate; defaults to the built-in closed/canceled statuses. */
  isTerminal?: (status: string) => boolean;
  /** Blocked-lifecycle predicate for stale-block detection; defaults to `status === "blocked"`. */
  isBlocked?: (status: string) => boolean;
  /** Node identifiers that are explicitly valid isolates (roots, archives, scratch work). */
  exemptIsolates?: readonly string[];
  /** Item types whose active nodes are policy-valid isolates or sparse nodes (case-insensitive); they stay in the coverage profile but raise no coverage finding. */
  isolateExemptTypes?: readonly string[];
  /** Maximum sample entries retained per finding; defaults to 25. */
  maxSampleSize?: number;
  /** Abort signal checked between finding families. */
  signal?: AbortSignal;
}

/** Complete deterministic result of one relationship-graph audit. */
export interface RelationshipAuditReport {
  /** Findings ordered by severity, then code, then first sample subject. */
  findings: RelationshipAuditFinding[];
  /** Structural coverage metrics computed during the audit. */
  profile: RelationshipCoverageProfile;
}

/** Default bounded sample size applied to every finding family. */
const DEFAULT_MAX_SAMPLE_SIZE = 25;

/** Rank used to order findings by decreasing severity. */
const SEVERITY_RANK: Record<RelationshipAuditSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

/** Internal per-node lifecycle classification resolved once per audit. */
interface AuditNodeState {
  /** Original-case node identifier. */
  id: string;
  /** Raw lifecycle status string from assembly details. */
  status: string;
  /** Whether the node is a materialized missing placeholder. */
  missing: boolean;
  /** Whether the node's lifecycle status is terminal. */
  terminal: boolean;
  /** Declared item type, when the assembly carried one. */
  type?: string;
}

/** Mutable state shared by iterative Tarjan frames. */
interface TarjanState {
  /** Discovery index assigned to each visited node. */
  indexes: Map<string, number>;
  /** Lowest reachable discovery index per visited node. */
  lowLinks: Map<string, number>;
  /** Nodes that still belong to an unfinished component. */
  onStack: Set<string>;
  /** Component-membership stack. */
  stack: string[];
  /** Completed cyclic components. */
  components: string[][];
  /** Discovery index assigned to the next unseen node. */
  nextIndex: number;
}

/** One explicit depth-first frame used by iterative Tarjan traversal. */
interface TarjanFrame {
  /** Node currently being expanded. */
  node: string;
  /** Index of the next successor to inspect. */
  neighborIndex: number;
}

/** Build one finding with deterministic bounded sampling over sorted subjects. */
function buildFinding(
  code: RelationshipAuditFindingCode,
  severity: RelationshipAuditSeverity,
  policy: string,
  describe: (count: number) => string,
  subjects: readonly string[],
  maxSampleSize: number,
  remediation: string,
): RelationshipAuditFinding {
  const sorted = [...subjects].sort((left, right) => left.localeCompare(right));
  return {
    code,
    severity,
    policy,
    message: describe(sorted.length),
    count: sorted.length,
    sample: sorted.slice(0, maxSampleSize),
    sample_truncated: sorted.length > maxSampleSize,
    remediation,
  };
}
/** Resolve the ordering-only successor adjacency for cycle analysis. */
function buildOrderingAdjacency(
  assembly: WorkspaceRelationshipAssembly,
): Map<string, string[]> {
  const registry = assembly.graph.registry();
  const successors = new Map<string, string[]>();
  for (const edge of assembly.graph.edges()) {
    const definition = registry.require(edge.kind);
    if (!definition.ordering) continue;
    // Orient every ordering edge predecessor -> successor so inverse spellings
    // (blocked_by/blocks) land in one canonical execution-order digraph.
    const [predecessor, successor] =
      (definition.precedence ?? "source_before_target") ===
      "target_before_source"
        ? [edge.target, edge.source]
        : [edge.source, edge.target];
    const adjacent = successors.get(predecessor);
    if (adjacent) adjacent.push(successor);
    else successors.set(predecessor, [successor]);
  }
  for (const adjacent of successors.values())
    adjacent.sort((left, right) => left.localeCompare(right));
  return successors;
}

/** Register one newly discovered Tarjan node. */
function registerTarjanNode(node: string, state: TarjanState): void {
  state.indexes.set(node, state.nextIndex);
  state.lowLinks.set(node, state.nextIndex);
  state.nextIndex += 1;
  state.stack.push(node);
  state.onStack.add(node);
}

/** Visit one pending successor, returning whether the frame had work left. */
function visitNextTarjanNeighbor(
  frame: TarjanFrame,
  frames: TarjanFrame[],
  successors: Map<string, string[]>,
  state: TarjanState,
): boolean {
  const neighbors = successors.get(frame.node) ?? [];
  if (frame.neighborIndex >= neighbors.length) return false;
  const neighbor = neighbors[frame.neighborIndex]!;
  frame.neighborIndex += 1;
  if (!state.indexes.has(neighbor)) {
    registerTarjanNode(neighbor, state);
    frames.push({ node: neighbor, neighborIndex: 0 });
  } else if (state.onStack.has(neighbor)) {
    state.lowLinks.set(
      frame.node,
      Math.min(state.lowLinks.get(frame.node)!, state.indexes.get(neighbor)!),
    );
  }
  return true;
}

/** Complete one Tarjan frame and emit its component when it is a root. */
function completeTarjanFrame(
  frame: TarjanFrame,
  frames: TarjanFrame[],
  successors: Map<string, string[]>,
  state: TarjanState,
): void {
  frames.pop();
  const parent = frames.at(-1);
  if (parent)
    state.lowLinks.set(
      parent.node,
      Math.min(
        state.lowLinks.get(parent.node)!,
        state.lowLinks.get(frame.node)!,
      ),
    );
  if (state.lowLinks.get(frame.node) !== state.indexes.get(frame.node)) return;
  const component: string[] = [];
  while (true) {
    const member = state.stack.pop()!;
    state.onStack.delete(member);
    component.push(member);
    if (member === frame.node) break;
  }
  if (
    component.length > 1 ||
    (component.length === 1 &&
      successors.get(component[0]!)?.includes(component[0]!))
  )
    state.components.push(
      component.sort((left, right) => left.localeCompare(right)),
    );
}

/**
 * Enumerate strongly connected components with more than one member (or a
 * self-loop) over an ordering-only successor digraph using an iterative Tarjan
 * traversal. Only order-bearing kinds should participate: associative kinds
 * such as `related` cannot create execution-order contradictions and stay out
 * of cycle analysis by policy. Exported so incremental consumers (mutation
 * advisories) share one cycle semantics with the workspace audit.
 */
export function collectOrderingCycles(
  successors: Map<string, string[]>,
): string[][] {
  const state: TarjanState = {
    indexes: new Map(),
    lowLinks: new Map(),
    onStack: new Set(),
    stack: [],
    components: [],
    nextIndex: 0,
  };
  const roots = [...successors.keys()].sort((left, right) =>
    left.localeCompare(right),
  );
  for (const root of roots) {
    if (state.indexes.has(root)) continue;
    // Explicit frame stack keeps the traversal safe on deep dependency chains.
    const frames: TarjanFrame[] = [{ node: root, neighborIndex: 0 }];
    registerTarjanNode(root, state);
    while (frames.length > 0) {
      const frame = frames.at(-1)!;
      if (visitNextTarjanNeighbor(frame, frames, successors, state)) continue;
      completeTarjanFrame(frame, frames, successors, state);
    }
  }
  return state.components.sort((left, right) =>
    left[0]!.localeCompare(right[0]!),
  );
}

/** Format one dangling reference as a compact deterministic evidence string. */
function formatDanglingReference(reference: {
  holder_id: string;
  target_id: string;
  kind: string;
}): string {
  return `${reference.holder_id} -> ${reference.target_id} (${reference.kind})`;
}

/** Append one finding only when its subject collection is non-empty. */
function appendFinding(
  findings: RelationshipAuditFinding[],
  subjects: readonly string[],
  maxSampleSize: number,
  code: RelationshipAuditFindingCode,
  severity: RelationshipAuditSeverity,
  policy: string,
  describe: (count: number) => string,
  remediation: string,
): void {
  if (subjects.length === 0) return;
  findings.push(
    buildFinding(
      code,
      severity,
      policy,
      describe,
      subjects,
      maxSampleSize,
      remediation,
    ),
  );
}

/** Collect dangling-reference and retired-sentinel governance findings. */
function collectIntegrityFindings(
  assembly: WorkspaceRelationshipAssembly,
  isTerminal: (status: string) => boolean,
  maxSampleSize: number,
): RelationshipAuditFinding[] {
  const findings: RelationshipAuditFinding[] = [];
  const references = [
    ...assembly.dangling.active,
    ...assembly.dangling.legacy_terminal,
  ].filter((reference) => !reference.no_active_blocker_sentinel);
  appendFinding(
    findings,
    references
      .filter((reference) => !isTerminal(reference.holder_status))
      .map(formatDanglingReference),
    maxSampleSize,
    "missing_reference_active",
    "error",
    "Active items must not reference absent targets; missing prerequisites distort scheduling.",
    (count) => `${count} active dangling reference(s) to absent items`,
    "Restore or re-create the referenced item, or remove/retype the reference on the holder.",
  );
  appendFinding(
    findings,
    references
      .filter((reference) => isTerminal(reference.holder_status))
      .map(formatDanglingReference),
    maxSampleSize,
    "missing_reference_terminal",
    "info",
    "Terminal items may retain historical references, but absent targets remain unexplainable context.",
    (count) => `${count} terminal dangling reference(s) to absent items`,
    "Leave as history debt or clean up in a dedicated changelog-safe closed-item batch.",
  );
  appendFinding(
    findings,
    assembly.dangling.no_active_blocker_sentinels.map(formatDanglingReference),
    maxSampleSize,
    "legacy_no_blocker_sentinel",
    "info",
    "The pre-structured-dependency no-active-blocker sentinel is retired; real edges carry blocker state.",
    (count) => `${count} legacy no-active-blocker sentinel reference(s)`,
    "Delete the sentinel reference; blocker state is derived from blocked_by edges.",
  );
  return findings;
}

/** Decide whether one audited node still participates in active scheduling. */
function isActiveAuditMember(
  member: string,
  nodeStates: Map<string, AuditNodeState>,
): boolean {
  const state = nodeStates.get(member);
  // A trimmed or custom assembly may omit a member's details. Treat that
  // unknown lifecycle conservatively as active so contradictions are never
  // silently downgraded to legacy history debt.
  if (!state) return true;
  return !state.terminal;
}

/** Collect ordering-cycle and lifecycle-block governance findings. */
function collectOrderingFindings(
  assembly: WorkspaceRelationshipAssembly,
  nodeStates: Map<string, AuditNodeState>,
  isBlocked: (status: string) => boolean,
  maxSampleSize: number,
): RelationshipAuditFinding[] {
  const findings: RelationshipAuditFinding[] = [];
  const orderingAdjacency = buildOrderingAdjacency(assembly);
  for (const cycle of collectOrderingCycles(orderingAdjacency)) {
    // A cycle whose members are all terminal is a historical contradiction:
    // it cannot make live work unschedulable, and "repairing" it would touch
    // closed items (changelog drag), so it downgrades to informational debt.
    const active = cycle.some((member) =>
      isActiveAuditMember(member, nodeStates),
    );
    findings.push(
      active
        ? buildFinding(
            "ordering_cycle",
            "error",
            "Order-bearing relationship kinds must stay acyclic; a cycle makes every member unschedulable.",
            (count) => `execution-order cycle across ${count} item(s)`,
            cycle,
            maxSampleSize,
            "Remove or retype one ordering edge inside the cycle, or split the work so precedence is linear.",
          )
        : buildFinding(
            "legacy_ordering_cycle",
            "info",
            "Ordering cycles between exclusively terminal items are historical contradictions with no scheduling effect.",
            (count) =>
              `terminal-only execution-order cycle across ${count} item(s)`,
            cycle,
            maxSampleSize,
            "Leave as history debt, or clean up in a dedicated changelog-safe closed-item batch; never repair closed items ad hoc.",
          ),
    );
  }
  const predecessorsByNode = new Map<string, string[]>();
  for (const [predecessor, adjacent] of orderingAdjacency)
    for (const successor of adjacent) {
      const predecessors = predecessorsByNode.get(successor);
      if (predecessors) predecessors.push(predecessor);
      else predecessorsByNode.set(successor, [predecessor]);
    }
  const staleLifecycleBlocks = [...nodeStates.values()]
    .filter(
      (state) =>
        !state.missing &&
        !state.terminal &&
        isBlocked(state.status) &&
        !(predecessorsByNode.get(state.id) ?? []).some((predecessor) => {
          const predecessorState = nodeStates.get(predecessor);
          // A trimmed/custom assembly may omit predecessor details. Treat that
          // unknown state conservatively as potentially open instead of
          // falsely declaring the lifecycle block stale.
          return predecessorState === undefined || !predecessorState.terminal;
        }),
    )
    .map((state) => state.id);
  appendFinding(
    findings,
    staleLifecycleBlocks,
    maxSampleSize,
    "stale_lifecycle_block",
    "warning",
    "A blocked lifecycle status must be backed by at least one open ordering predecessor.",
    (count) => `${count} status-blocked item(s) with no open blocker edge`,
    "Re-open the missing prerequisite as an edge, or move the item back to an active status.",
  );
  return findings;
}

/** One duplicate-edge group in semantic orientation with its stored spellings. */
export interface DuplicateRelationshipEdgeGroup {
  /** Semantic tail node shared by every stored spelling. */
  from: string;
  /** Semantic head node shared by every stored spelling. */
  to: string;
  /** Stored parallel edges sorted by kind. */
  edges: RelationshipEdge[];
}

/** Format one duplicate-edge group as a compact deterministic evidence string. */
export function formatDuplicateEdgeGroup(
  group: DuplicateRelationshipEdgeGroup,
): string {
  const kinds = group.edges
    .map((edge) => edge.kind)
    .sort((left, right) => left.localeCompare(right));
  return `${group.from} -> ${group.to} (${kinds.join(" + ")})`;
}

/**
 * Collect the groups of parallel same-family stored edges over the directed
 * ordering and hierarchy families. Each family joins a kind with its inverse
 * spelling in semantic orientation, so a reciprocal pair such as
 * `A blocked_by B` plus `B blocks A` collapses onto one oriented endpoint
 * pair. Only groups holding at least two stored spellings are returned, in
 * deterministic orientation order with per-group edges sorted by kind, source,
 * then target — the exact stored identities remediation planning targets.
 */
export function collectDuplicateRelationshipEdgeGroups(
  assembly: WorkspaceRelationshipAssembly,
): DuplicateRelationshipEdgeGroup[] {
  const registry = assembly.graph.registry();
  const groups = new Map<string, DuplicateRelationshipEdgeGroup>();
  for (const edge of assembly.graph.edges()) {
    const definition = registry.require(edge.kind);
    if (!isTransitiveKind(definition)) continue;
    const oriented = orientTransitiveEdge(edge, definition);
    if (oriented.from === oriented.to) continue;
    const key = `${transitiveFamilyKey(definition)}::${oriented.from}::${oriented.to}`;
    const group = groups.get(key);
    if (group) group.edges.push(edge);
    else groups.set(key, { ...oriented, edges: [edge] });
  }
  const duplicated = [...groups.values()].filter(
    (group) => group.edges.length >= 2,
  );
  // Within one oriented group every stored spelling has a distinct kind: a
  // same-kind restatement of the same oriented pair would carry identical
  // endpoints and is deduplicated by edge identity during graph construction.
  for (const group of duplicated)
    group.edges.sort((left, right) => left.kind.localeCompare(right.kind));
  return duplicated.sort(
    (left, right) =>
      left.from.localeCompare(right.from) || left.to.localeCompare(right.to),
  );
}

/**
 * Collect duplicate stored-edge findings from the oriented duplicate groups.
 * Transitive-reduction redundancy analysis deliberately skips the direct edge
 * under test, so these exact parallels are invisible there and this is the
 * only surface that reports them.
 */
function collectDuplicateEdgeFindings(
  assembly: WorkspaceRelationshipAssembly,
  nodeStates: Map<string, AuditNodeState>,
  maxSampleSize: number,
): RelationshipAuditFinding[] {
  const active: string[] = [];
  const legacy: string[] = [];
  for (const group of collectDuplicateRelationshipEdgeGroups(assembly)) {
    const subjects =
      isActiveAuditMember(group.from, nodeStates) ||
      isActiveAuditMember(group.to, nodeStates)
        ? active
        : legacy;
    subjects.push(formatDuplicateEdgeGroup(group));
  }
  const findings: RelationshipAuditFinding[] = [];
  appendFinding(
    findings,
    active,
    maxSampleSize,
    "duplicate_edge",
    "info",
    "One semantic relationship should be stored once; parallel same-family spellings (reciprocal inverse pairs included) add no information and skew degree metrics.",
    (count) => `${count} duplicated relationship(s) between active endpoints`,
    "Remove all but one stored spelling of the relationship; keep the canonical direction the holder declared first.",
  );
  appendFinding(
    findings,
    legacy,
    maxSampleSize,
    "legacy_duplicate_edge",
    "info",
    "Duplicated spellings between exclusively terminal items are historical noise with no scheduling effect.",
    (count) => `${count} duplicated relationship(s) between terminal endpoints`,
    "Leave as history debt or clean up in a dedicated changelog-safe closed-item batch.",
  );
  return findings;
}

/**
 * Collect storage-integrity findings for raw dependency rows whose exact
 * identity is stored more than once on one holder. Graph edge-identity dedup
 * hides these from every assembled-graph surface (duplicate_edge only covers
 * cross-spelling parallels), so the audit reports them from the pre-assembly
 * scan carried on the assembly.
 */
function collectDuplicateRowFindings(
  assembly: WorkspaceRelationshipAssembly,
  maxSampleSize: number,
): RelationshipAuditFinding[] {
  const active: string[] = [];
  const legacy: string[] = [];
  for (const row of assembly.duplicateRows) {
    (row.legacy_terminal ? legacy : active).push(
      `${row.holder_id} -> ${row.target_id} (${row.kind} x${row.occurrences})`,
    );
  }
  const findings: RelationshipAuditFinding[] = [];
  appendFinding(
    findings,
    active,
    maxSampleSize,
    "duplicate_dependency_row",
    "warning",
    "One dependency row must be stored once per holder; identical repeated rows are a storage-layer defect invisible to the assembled graph.",
    (count) =>
      `${count} exactly duplicated stored dependency row(s) on active holder(s)`,
    "Remove the repeated rows so the dependency is stored exactly once; graph semantics are unchanged.",
  );
  appendFinding(
    findings,
    legacy,
    maxSampleSize,
    "legacy_duplicate_dependency_row",
    "info",
    "Identical repeated dependency rows on terminal holders are historical storage noise with no scheduling effect.",
    (count) =>
      `${count} exactly duplicated stored dependency row(s) on terminal holder(s)`,
    "Leave as history debt or clean up in a dedicated changelog-safe closed-item batch.",
  );
  return findings;
}

/** Compute structural coverage metrics and coverage-policy findings. */
/** Mutable coverage tallies accumulated across active graph nodes. */
interface CoverageTallies {
  /** Active node count. */
  active: number;
  /** Missing placeholder count. */
  missing: number;
  /** Isolated active node count. */
  isolated: number;
  /** Degree-at-most-one active node count, isolates included. */
  degreeLeqOne: number;
  /** Non-exempt isolate finding subjects. */
  isolates: string[];
  /** Non-exempt single-edge finding subjects. */
  sparse: string[];
  /** Per-type connectivity tallies. */
  byType: Map<string, RelationshipCoverageTypeProfile>;
}

/** Fold one active node's degree into the aggregate and per-type coverage tallies. */
function tallyActiveCoverageNode(
  tallies: CoverageTallies,
  state: AuditNodeState,
  degree: number,
  exemptIsolates: Set<string>,
  isolateExemptTypes: Set<string>,
): void {
  tallies.active += 1;
  const typeKey = state.type ?? "(untyped)";
  let typeProfile = tallies.byType.get(typeKey);
  if (!typeProfile) {
    typeProfile = { active: 0, isolated: 0, degree_leq_one: 0 };
    tallies.byType.set(typeKey, typeProfile);
  }
  typeProfile.active += 1;
  if (degree > 1) return;
  tallies.degreeLeqOne += 1;
  typeProfile.degree_leq_one += 1;
  if (degree === 0) {
    tallies.isolated += 1;
    typeProfile.isolated += 1;
  }
  if (
    exemptIsolates.has(state.id.toLowerCase()) ||
    isolateExemptTypes.has(typeKey.toLowerCase())
  )
    return;
  if (degree === 0) tallies.isolates.push(state.id);
  else tallies.sparse.push(state.id);
}

function collectCoverageReport(
  assembly: WorkspaceRelationshipAssembly,
  nodeStates: Map<string, AuditNodeState>,
  exemptIsolates: Set<string>,
  isolateExemptTypes: Set<string>,
  maxSampleSize: number,
  edgesByKind: Record<string, number>,
): RelationshipAuditReport {
  const tallies: CoverageTallies = {
    active: 0,
    missing: 0,
    isolated: 0,
    degreeLeqOne: 0,
    isolates: [],
    sparse: [],
    byType: new Map(),
  };
  for (const id of assembly.graph.nodes()) {
    const state = nodeStates.get(id);
    /* c8 ignore next -- every graph node originates from assembly details by construction */
    if (!state) continue;
    if (state.missing) {
      tallies.missing += 1;
      continue;
    }
    if (state.terminal) continue;
    tallyActiveCoverageNode(
      tallies,
      state,
      assembly.graph.incidentEdges(id).length,
      exemptIsolates,
      isolateExemptTypes,
    );
  }
  const { isolates, sparse } = tallies;
  const findings: RelationshipAuditFinding[] = [];
  appendFinding(
    findings,
    isolates,
    maxSampleSize,
    "isolated_active_node",
    "warning",
    "Active work should be reachable from the graph unless explicitly declared a valid isolate.",
    (count) => `${count} active item(s) with no relationships`,
    "Link the item to its parent, prerequisite, or origin — or register it as an exempt isolate.",
  );
  appendFinding(
    findings,
    sparse,
    maxSampleSize,
    "sparse_active_node",
    "info",
    "Active items with a single edge often miss an honest semantic partner; sparse is not automatically defective.",
    (count) => `${count} active item(s) with exactly one relationship`,
    "Investigate for an honest second edge (story->task, defect family, cross-epic complement); do not fabricate one.",
  );
  return {
    findings,
    profile: {
      nodes: assembly.graph.nodes().length,
      edges: assembly.graph.edges().length,
      edges_by_kind: Object.fromEntries(
        Object.entries(edgesByKind).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
      active_nodes: tallies.active,
      missing_nodes: tallies.missing,
      isolated_active_nodes: tallies.isolated,
      degree_leq_one_active_nodes: tallies.degreeLeqOne,
      coverage_by_type: Object.fromEntries(
        [...tallies.byType.entries()].sort(),
      ),
    },
  };
}

/**
 * Audit one assembled workspace relationship graph against the shared
 * governance policy and return deterministic machine-readable findings plus a
 * structural coverage profile.
 *
 * The audit is read-only and never proposes inventing an edge: integrity
 * findings report evidence for investigation, coverage findings honor explicit
 * isolate exemptions, and cycle findings enumerate the strongly connected
 * members so callers can decide which edge to retype, remove, or waive.
 */
export function auditWorkspaceRelationshipGraph(
  assembly: WorkspaceRelationshipAssembly,
  options: RelationshipAuditOptions = {},
): RelationshipAuditReport {
  const isTerminal =
    options.isTerminal ??
    ((status: string) => status === "closed" || status === "canceled");
  const isBlocked =
    options.isBlocked ?? ((status: string) => status === "blocked");
  const maxSampleSize = options.maxSampleSize ?? DEFAULT_MAX_SAMPLE_SIZE;
  if (!Number.isInteger(maxSampleSize) || maxSampleSize < 1)
    throw new TypeError(
      `Invalid audit sample bound: ${String(options.maxSampleSize)}`,
    );
  const exemptIsolates = new Set(
    (options.exemptIsolates ?? [])
      .filter((id): id is string => typeof id === "string")
      .map((id) => id.trim().toLowerCase()),
  );
  const isolateExemptTypes = new Set(
    (options.isolateExemptTypes ?? [])
      .filter((type): type is string => typeof type === "string")
      .map((type) => type.trim().toLowerCase()),
  );
  const nodeStates = new Map<string, AuditNodeState>(
    assembly.details.map((detail) => [
      detail.id,
      {
        id: detail.id,
        status: detail.status,
        missing: assembly.missingIdSet.has(detail.id.toLowerCase()),
        terminal: isTerminal(detail.status),
        ...(detail.type === undefined ? {} : { type: detail.type }),
      },
    ]),
  );
  options.signal?.throwIfAborted();

  const edgesByKind: Record<string, number> = {};
  for (const edge of assembly.graph.edges())
    edgesByKind[edge.kind] = (edgesByKind[edge.kind] ?? 0) + 1;
  const findings = collectIntegrityFindings(
    assembly,
    isTerminal,
    maxSampleSize,
  );
  options.signal?.throwIfAborted();
  findings.push(
    ...collectOrderingFindings(assembly, nodeStates, isBlocked, maxSampleSize),
  );
  options.signal?.throwIfAborted();
  findings.push(
    ...collectDuplicateEdgeFindings(assembly, nodeStates, maxSampleSize),
    ...collectDuplicateRowFindings(assembly, maxSampleSize),
  );
  options.signal?.throwIfAborted();
  const coverage = collectCoverageReport(
    assembly,
    nodeStates,
    exemptIsolates,
    isolateExemptTypes,
    maxSampleSize,
    edgesByKind,
  );
  findings.push(...coverage.findings);

  findings.sort(
    (left, right) =>
      SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] ||
      left.code.localeCompare(right.code) ||
      left.sample[0]!.localeCompare(right.sample[0]!),
  );
  return {
    findings,
    profile: coverage.profile,
  };
}

/** One persisted point-in-time audit census used for temporal comparison. */
export interface RelationshipAuditSnapshot {
  /** ISO timestamp the snapshot was taken at. */
  saved_at: string;
  /** Workspace graph fingerprint of the audited item snapshot. */
  fingerprint: string;
  /** Affected-subject counts keyed by finding code at snapshot time. */
  affected_subjects_by_code: Record<string, number>;
  /** Structural coverage profile at snapshot time. */
  profile: RelationshipCoverageProfile;
}

/** Signed change between two audit snapshots; zero-change keys are dropped. */
export interface RelationshipAuditDelta {
  /** ISO timestamp of the baseline snapshot the delta is measured against. */
  baseline_saved_at: string;
  /** Whether both snapshots audited the identical workspace fingerprint. */
  same_snapshot: boolean;
  /** Signed affected-subject deltas keyed by finding code. */
  affected_subjects_by_code: Record<string, number>;
  /** Signed structural profile deltas. */
  profile: {
    /** Node-count change including missing placeholders. */
    nodes: number;
    /** Deduplicated edge-count change. */
    edges: number;
    /** Active-node-count change. */
    active_nodes: number;
    /** Missing-placeholder-count change. */
    missing_nodes: number;
    /** Isolated-active-node-count change. */
    isolated_active_nodes: number;
    /** Degree-at-most-one active-node-count change. */
    degree_leq_one_active_nodes: number;
    /** Signed per-kind edge-count deltas; unchanged kinds are dropped. */
    edges_by_kind: Record<string, number>;
  };
}

/** Subtract two count records, keeping only non-zero signed deltas in sorted key order. */
function diffCountRecords(
  baseline: Record<string, number>,
  current: Record<string, number>,
): Record<string, number> {
  const keys = [
    ...new Set([...Object.keys(baseline), ...Object.keys(current)]),
  ].sort();
  const deltas: Record<string, number> = {};
  for (const key of keys) {
    const delta = (current[key] ?? 0) - (baseline[key] ?? 0);
    if (delta !== 0) deltas[key] = delta;
  }
  return deltas;
}

/**
 * Compare two point-in-time audit snapshots and return the signed change in
 * findings and structural coverage. This is the temporal primitive behind
 * change-since-baseline audit reporting: agents track census drift across
 * sessions without re-deriving or storing full finding collections.
 */
export function diffRelationshipAuditSnapshots(
  baseline: RelationshipAuditSnapshot,
  current: RelationshipAuditSnapshot,
): RelationshipAuditDelta {
  return {
    baseline_saved_at: baseline.saved_at,
    same_snapshot: baseline.fingerprint === current.fingerprint,
    affected_subjects_by_code: diffCountRecords(
      baseline.affected_subjects_by_code,
      current.affected_subjects_by_code,
    ),
    profile: {
      nodes: current.profile.nodes - baseline.profile.nodes,
      edges: current.profile.edges - baseline.profile.edges,
      active_nodes:
        current.profile.active_nodes - baseline.profile.active_nodes,
      missing_nodes:
        current.profile.missing_nodes - baseline.profile.missing_nodes,
      isolated_active_nodes:
        current.profile.isolated_active_nodes -
        baseline.profile.isolated_active_nodes,
      degree_leq_one_active_nodes:
        current.profile.degree_leq_one_active_nodes -
        baseline.profile.degree_leq_one_active_nodes,
      edges_by_kind: diffCountRecords(
        baseline.profile.edges_by_kind,
        current.profile.edges_by_kind,
      ),
    },
  };
}
