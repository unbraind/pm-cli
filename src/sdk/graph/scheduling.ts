/**
 * @module sdk/graph/scheduling
 *
 * Critical Path Method (CPM) scheduling over the order-bearing relationship
 * DAG. The forward pass — topological order, earliest-start distances, the
 * longest deterministic path, and genuine-cycle isolation — is reused from the
 * exact execution analysis; this module adds the backward pass that derives
 * each task's latest start, latest finish, and total float (slack), then
 * classifies zero-slack tasks as critical. Durations are unit-weighted so the
 * schedule is deterministic and metadata-independent: slack counts how many
 * whole prerequisite hops a task can drift without extending the makespan.
 * Nodes with no order-bearing edge do not participate in the execution DAG and
 * are omitted; genuine ordering cycles are reported separately and never
 * scheduled.
 */
import {
  analyzeRelationshipExecution,
  type RelationshipExecutionAnalysis,
} from "../relationship-analytics.js";
import { RelationshipGraph } from "../relationships.js";
import { orderingPredecessorEndpoint } from "./traversal.js";

/** One scheduled task row with its earliest/latest window and total float. */
export interface RelationshipScheduleRow {
  /** Scheduled task id. */
  id: string;
  /** Longest prerequisite distance from any source (earliest start). */
  earliestStart: number;
  /** Earliest start plus the unit task duration. */
  earliestFinish: number;
  /** Latest start that still preserves the makespan. */
  latestStart: number;
  /** Latest finish that still preserves the makespan. */
  latestFinish: number;
  /** Total float: latest start minus earliest start. */
  slack: number;
  /** Whether the task has zero slack and lies on a critical path. */
  critical: boolean;
}

/** Bounded schedule-analysis controls. */
export interface GraphScheduleOptions {
  /** Abort signal checked once at entry, before the forward pass. */
  signal?: AbortSignal;
}

/** Deterministic critical-path schedule of the order-bearing subgraph. */
export interface RelationshipScheduleAnalysis {
  /** Whether the result is exact rather than sampled or approximate. */
  exact: true;
  /** Whether the order-bearing graph is acyclic. */
  acyclic: boolean;
  /** Total makespan in unit task durations; zero when nothing is scheduled. */
  makespan: number;
  /** Number of tasks participating in the order-bearing DAG. */
  scheduledCount: number;
  /** Longest deterministic execution path — a canonical zero-slack chain. */
  criticalPath: string[];
  /** Edge count of the critical path. */
  criticalPathLength: number;
  /** Genuine ordering cycles, excluded from scheduling. */
  cycles: string[][];
  /** Scheduled rows sorted by ascending slack, then earliest start, then id. */
  rows: RelationshipScheduleRow[];
  /** Semantic provenance for the analysis. */
  provenance: {
    algorithm: "critical-path-method";
    edgeFamily: "ordering";
    weighting: "unit";
  };
}

/** Forward order-bearing adjacency restricted to tasks that carry an ordering edge. */
interface OrderingParticipation {
  /** Predecessor-to-successor adjacency in execution orientation. */
  forward: Map<string, Set<string>>;
  /** Ids that appear as an endpoint of at least one ordering edge. */
  participants: Set<string>;
}

/**
 * Collect the execution-oriented forward adjacency and the set of tasks that
 * carry any order-bearing edge. Each ordering edge is oriented through the
 * registry's declared precedence so inverse spellings agree, and self-loops
 * (which the execution cycle analysis reports) never enter the adjacency.
 */
function collectOrderingParticipation(
  graph: RelationshipGraph,
): OrderingParticipation {
  const registry = graph.registry();
  const forward = new Map<string, Set<string>>();
  const participants = new Set<string>();
  for (const edge of graph.edges()) {
    const definition = registry.require(edge.kind);
    if (!definition.ordering) continue;
    const predecessor = orderingPredecessorEndpoint(edge, definition);
    const successor = predecessor === edge.source ? edge.target : edge.source;
    participants.add(predecessor);
    participants.add(successor);
    if (predecessor === successor) continue;
    const targets = forward.get(predecessor);
    if (targets === undefined) forward.set(predecessor, new Set([successor]));
    else targets.add(successor);
  }
  return { forward, participants };
}

/** Resolve a task's latest finish from its acyclic successors, or the makespan when it has none. */
function latestFinishFor(
  successors: Set<string> | undefined,
  acyclic: Set<string>,
  latestStart: Map<string, number>,
  makespan: number,
): number {
  if (successors === undefined) return makespan;
  let bound = makespan;
  for (const successor of successors) {
    if (!acyclic.has(successor)) continue;
    bound = Math.min(bound, latestStart.get(successor)!);
  }
  return bound;
}

/** Build one scheduled row from the forward earliest-start depth and backward latest-start. */
function scheduleRow(
  id: string,
  earliestStart: number,
  latestStart: number,
): RelationshipScheduleRow {
  const slack = latestStart - earliestStart;
  return {
    id,
    earliestStart,
    earliestFinish: earliestStart + 1,
    latestStart,
    latestFinish: latestStart + 1,
    slack,
    critical: slack === 0,
  };
}

/** Run the backward CPM pass over the acyclic participants in reverse topological order. */
function computeScheduleRows(
  topoParticipants: readonly string[],
  participation: OrderingParticipation,
  depth: Record<string, number>,
  acyclic: Set<string>,
  makespan: number,
): RelationshipScheduleRow[] {
  const latestStart = new Map<string, number>();
  for (let index = topoParticipants.length - 1; index >= 0; index -= 1) {
    const id = topoParticipants[index]!;
    const finish = latestFinishFor(
      participation.forward.get(id),
      acyclic,
      latestStart,
      makespan,
    );
    latestStart.set(id, finish - 1);
  }
  return topoParticipants
    .map((id) => scheduleRow(id, depth[id]!, latestStart.get(id)!))
    .sort(
      (left, right) =>
        left.slack - right.slack ||
        left.earliestStart - right.earliestStart ||
        left.id.localeCompare(right.id),
    );
}

/**
 * Compute the deterministic critical-path schedule of the order-bearing
 * subgraph. Earliest-start distances and the critical path come from the exact
 * execution analysis; the backward pass then assigns each task the latest start
 * that preserves the makespan and reports total float as `slack`. Zero-slack
 * tasks are `critical`. Tasks with no order-bearing edge are omitted, and
 * genuine ordering cycles are reported separately in `cycles` rather than
 * scheduled.
 */
export function analyzeRelationshipSchedule(
  graph: RelationshipGraph,
  options: GraphScheduleOptions = {},
): RelationshipScheduleAnalysis {
  options.signal?.throwIfAborted();
  const execution: RelationshipExecutionAnalysis = analyzeRelationshipExecution(
    graph,
    { registry: graph.registry() },
  );
  const participation = collectOrderingParticipation(graph);
  const acyclic = new Set(execution.order);
  const topoParticipants = execution.order.filter((id) =>
    participation.participants.has(id),
  );
  const makespan = topoParticipants.reduce(
    (peak, id) => Math.max(peak, execution.depth[id]! + 1),
    0,
  );
  const rows = computeScheduleRows(
    topoParticipants,
    participation,
    execution.depth,
    acyclic,
    makespan,
  );
  const scheduled = rows.length > 0;
  return {
    exact: true,
    acyclic: execution.acyclic,
    makespan,
    scheduledCount: rows.length,
    // A single-node execution "path" over a workspace with no order-bearing
    // edge is not a real critical path, so report it only when work is scheduled.
    criticalPath: scheduled ? execution.criticalPath : [],
    criticalPathLength: scheduled ? execution.criticalPathLength : 0,
    cycles: execution.cycles,
    rows,
    provenance: {
      algorithm: "critical-path-method",
      edgeFamily: "ordering",
      weighting: "unit",
    },
  };
}
