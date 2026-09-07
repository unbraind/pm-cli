/**
 * @module sdk/graph/deadline-scheduling
 * Read-only elapsed-minute scheduling. Independent tasks may execute in parallel;
 * estimates are durations, not resource capacity or business-calendar promises.
 * A bounded Kahn pass isolates cycles and propagates unknown durations explicitly.
 */
import type { RelationshipGraph } from "../relationships.js";
import { orientOrderingEdge } from "./traversal.js";

/** Recorded inputs; absent estimates never imply zero duration. */
export interface DeadlineScheduleItem {
  /** Canonical graph identifier. */
  id: string;
  /** Recorded elapsed-minute duration. */
  estimated_minutes?: number;
  /** Authored ISO deadline interpreted as a finish constraint. */
  deadline?: string;
}

/** Deterministic analysis controls and hard work/output bounds. */
export interface DeadlineScheduleOptions {
  /** Explicit clock instant; defaults to the invocation time. */
  now?: string;
  /** Input nodes plus edges plus items ceiling; also caps total retained path identifiers. */
  maxWork?: number;
  /** Maximum rows, residual samples, findings, and identifiers per finding path. */
  limit?: number;
  /** Cooperative cancellation checked during graph passes. */
  signal?: AbortSignal;
}

/** One derived finish constraint and its estimated temporal slack. */
export interface DeadlineScheduleRow {
  /** Constrained item identifier. */
  id: string;
  /** Controlling authored deadline's item identifier. */
  deadline_id: string;
  /** Derived latest start; never written to the authored item. */
  latest_start: string;
  /** Latest start minus earliest possible start, or null for unknown prerequisites. */
  slack_minutes: number | null;
}

/** Explicit evidence that this item's schedule could not be established. */
export interface DeadlineScheduleResidual {
  /** Unscheduled or incompletely scheduled item. */
  id: string;
  /** Why no feasibility assertion is possible. */
  reason:
    | "unknown_estimate"
    | "unknown_predecessor_estimate"
    | "cycle_or_gated_by_cycle"
    | "invalid_deadline"
    | "date_range_exceeded";
}

/** One authored deadline that cannot accommodate its longest prerequisite chain. */
export interface DeadlineOvercommitment {
  /** Item carrying the authored deadline. */
  deadline_id: string;
  /** Authored finish constraint. */
  deadline: string;
  /** Positive duration by which earliest finish exceeds the deadline. */
  shortfall_minutes: number;
  /** Bounded suffix of the controlling prerequisite chain, in execution order. */
  path: string[];
  /** Whether the chain exceeds the path output bound. */
  path_truncated: boolean;
}

/** Bounded derived schedule, with completeness separate from output truncation. */
export interface DeadlineScheduleResult {
  /** Reproducible clock used for earliest starts. */
  as_of: string;
  /** Explicit provenance distinguishing computed constraints from authored dates. */
  basis: "derived_elapsed_minutes";
  /** Whether all inputs could be scheduled within the work bound. */
  complete: boolean;
  /** Whether output collections omit computed entries. */
  truncated: boolean;
  /** True when the work bound prevented the graph pass. */
  work_limit_exceeded: boolean;
  /** Number of derived rows before output bounding. */
  scheduled_count: number;
  /** Number of explicit residuals before output bounding. */
  residual_count: number;
  /** Number of infeasible authored deadlines before output bounding. */
  overcommitted_count: number;
  /** Derived latest starts in graph identifier order. */
  rows: DeadlineScheduleRow[];
  /** Bounded incomplete-input and cycle samples. */
  residuals: DeadlineScheduleResidual[];
  /** Bounded deadline shortfall evidence. */
  overcommitted: DeadlineOvercommitment[];
}

/** Mutable state used by the linear forward and backward passes. */
interface ScheduleState {
  /** Recorded input, absent for dangling endpoints. */
  item?: DeadlineScheduleItem;
  /** Valid duration, absent when unknown or malformed. */
  duration?: number;
  /** Remaining predecessor count for Kahn traversal. */
  pending: number;
  /** Unique successors in execution orientation. */
  successors: Set<string>;
  /** Earliest elapsed start; null propagates unknown prerequisite durations. */
  earliest: number | null;
  /** Canonical predecessor defining the longest known execution path. */
  predecessor?: string;
  /** Authored finish in elapsed minutes from the invocation clock. */
  deadline?: number;
  /** Tightest derived latest finish bound. */
  latest?: number;
  /** Item whose authored deadline controls the derived finish. */
  anchor?: string;
}

/** Propagate finish constraints backward, retaining the most restrictive dated successor. */
function propagateLatest(
  order: readonly string[],
  states: Map<string, ScheduleState>,
  signal?: AbortSignal,
): void {
  for (let index = order.length - 1; index >= 0; index -= 1) {
    signal?.throwIfAborted();
    const state = states.get(order[index]!)!;
    for (const id of state.successors) {
      signal?.throwIfAborted();
      const successor = states.get(id)!;
      if (successor.latest === undefined || successor.duration === undefined)
        continue;
      const finish = successor.latest - successor.duration;
      if (state.latest === undefined || finish < state.latest) {
        state.latest = finish;
        state.anchor = successor.anchor;
      }
    }
  }
}

/** Recover one controlling chain iteratively, bounding emitted identifiers. */
function deadlinePath(
  id: string,
  states: Map<string, ScheduleState>,
  limit: number,
  signal?: AbortSignal,
): { path: string[]; path_truncated: boolean } {
  const reverse: string[] = [];
  let current: string | undefined = id;
  while (current !== undefined && reverse.length < limit) {
    signal?.throwIfAborted();
    reverse.push(current);
    current = states.get(current)!.predecessor;
  }
  reverse.reverse();
  return { path: reverse, path_truncated: current !== undefined };
}

/** Initialize explicit duration and authored-date state for each graph endpoint. */
function initializeStates(
  nodes: readonly string[],
  items: readonly DeadlineScheduleItem[],
  now: number,
  residual: (id: string, reason: DeadlineScheduleResidual["reason"]) => void,
  signal?: AbortSignal,
): Map<string, ScheduleState> {
  const inputs = new Map(items.map((item) => [item.id, item]));
  const states = new Map<string, ScheduleState>();
  for (const id of nodes) {
    signal?.throwIfAborted();
    const item = inputs.get(id);
    const estimate = item?.estimated_minutes;
    const duration =
      typeof estimate === "number" && Number.isFinite(estimate) && estimate >= 0
        ? estimate
        : undefined;
    const state: ScheduleState = {
      item,
      duration,
      pending: 0,
      successors: new Set(),
      earliest: 0,
    };
    if (item?.deadline !== undefined) {
      const date = Date.parse(item.deadline);
      if (Number.isFinite(date)) {
        state.deadline = (date - now) / 60_000;
        state.latest = state.deadline;
        state.anchor = id;
      } else residual(id, "invalid_deadline");
    }
    states.set(id, state);
  }
  return states;
}

/** Index deduplicated execution constraints in registry-defined orientation. */
function indexScheduleEdges(
  graph: RelationshipGraph,
  states: Map<string, ScheduleState>,
  signal?: AbortSignal,
): void {
  for (const edge of graph.edges()) {
    signal?.throwIfAborted();
    const definition = graph.registry().require(edge.kind);
    if (!definition.ordering) continue;
    const { predecessor, successor } = orientOrderingEdge(edge, definition);
    const source = states.get(predecessor)!;
    if (source.successors.has(successor)) continue;
    source.successors.add(successor);
    states.get(successor)!.pending += 1;
  }
}

/** Compute earliest estimated starts while retaining unknown and cyclic residuals. */
function propagateEarliest(
  nodes: readonly string[],
  states: Map<string, ScheduleState>,
  signal?: AbortSignal,
): string[] {
  const order = nodes.filter((id) => states.get(id)!.pending === 0);
  for (let index = 0; index < order.length; index += 1) {
    signal?.throwIfAborted();
    const id = order[index]!;
    const state = states.get(id)!;
    const finish =
      state.earliest === null || state.duration === undefined
        ? null
        : state.earliest + state.duration;
    for (const next of state.successors) {
      signal?.throwIfAborted();
      const target = states.get(next)!;
      if (finish === null) target.earliest = null;
      else if (
        target.earliest !== null &&
        (finish > target.earliest ||
          (finish === target.earliest &&
            (target.predecessor === undefined || id < target.predecessor)))
      ) {
        target.earliest = finish;
        target.predecessor = id;
      }
      target.pending -= 1;
      if (target.pending === 0) order.push(next);
    }
  }
  return order;
}

/** Append a bounded dated row and shortfall evidence after residual classification. */
function collectDatedState(
  id: string,
  state: ScheduleState,
  states: Map<string, ScheduleState>,
  result: DeadlineScheduleResult,
  now: number,
  limit: number,
  pathBudget: { remaining: number },
  signal?: AbortSignal,
): void {
  const duration = state.duration!;
  if (state.latest !== undefined) {
    result.scheduled_count += 1;
    const latest = state.latest - duration;
    if (result.rows.length < limit)
      result.rows.push({
        id,
        deadline_id: state.anchor!,
        latest_start: new Date(now + latest * 60_000).toISOString(),
        slack_minutes: state.earliest === null ? null : latest - state.earliest,
      });
    else result.truncated = true;
  }
  if (
    state.deadline !== undefined &&
    state.earliest !== null &&
    state.earliest + duration > state.deadline
  ) {
    result.overcommitted_count += 1;
    if (result.overcommitted.length < limit) {
      const evidence = deadlinePath(
        id,
        states,
        Math.min(limit, pathBudget.remaining),
        signal,
      );
      pathBudget.remaining -= evidence.path.length;
      if (evidence.path_truncated) result.truncated = true;
      result.overcommitted.push({
        deadline_id: id,
        deadline: state.item!.deadline!,
        shortfall_minutes: state.earliest + duration - state.deadline,
        ...evidence,
      });
    } else result.truncated = true;
  }
}

/** Project dated rows and infeasible commitments with exact counts and bounded samples. */
function collectScheduleResult(
  nodes: readonly string[],
  states: Map<string, ScheduleState>,
  result: DeadlineScheduleResult,
  now: number,
  limit: number,
  maxPathEntries: number,
  residual: (id: string, reason: DeadlineScheduleResidual["reason"]) => void,
  signal?: AbortSignal,
): void {
  const pathBudget = { remaining: maxPathEntries };
  for (const id of nodes) {
    signal?.throwIfAborted();
    const state = states.get(id)!;
    if (state.pending > 0) {
      residual(id, "cycle_or_gated_by_cycle");
      continue;
    }
    if (state.duration === undefined) {
      residual(id, "unknown_estimate");
      continue;
    }
    if (
      state.latest !== undefined &&
      !Number.isFinite(
        new Date(now + (state.latest - state.duration) * 60_000).getTime(),
      )
    ) {
      residual(id, "date_range_exceeded");
      continue;
    }
    if (state.earliest === null) residual(id, "unknown_predecessor_estimate");
    collectDatedState(
      id,
      state,
      states,
      result,
      now,
      limit,
      pathBudget,
      signal,
    );
  }
}

/**
 * Derive estimated latest starts and deadline shortfalls without mutating inputs.
 * Work is O(V+E) plus at most maxWork total finding-path identifiers. Unknown predecessors
 * invalidate earliest finish; unknown successors cannot transfer dated bounds.
 * Date-only ISO values denote UTC midnight, consistently with Date.parse.
 */
export function deriveRelationshipDeadlines(
  graph: RelationshipGraph,
  items: readonly DeadlineScheduleItem[],
  options: DeadlineScheduleOptions = {},
): DeadlineScheduleResult {
  options.signal?.throwIfAborted();
  const now = Date.parse(options.now ?? new Date().toISOString());
  if (!Number.isFinite(now)) throw new TypeError("Invalid scheduling clock");
  const maxWork = options.maxWork ?? 100_000;
  const limit = options.limit ?? 10;
  for (const [name, value] of [
    ["maxWork", maxWork],
    ["limit", limit],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new TypeError(`Invalid scheduling ${name}`);
  }
  const result: DeadlineScheduleResult = {
    as_of: new Date(now).toISOString(),
    basis: "derived_elapsed_minutes",
    complete: true,
    truncated: false,
    work_limit_exceeded: false,
    scheduled_count: 0,
    residual_count: 0,
    overcommitted_count: 0,
    rows: [],
    residuals: [],
    overcommitted: [],
  };
  const nodes = graph.nodes();
  const edges = graph.edges();
  if (nodes.length + edges.length + items.length > maxWork) {
    return { ...result, complete: false, work_limit_exceeded: true };
  }
  const residual = (
    id: string,
    reason: DeadlineScheduleResidual["reason"],
  ): void => {
    result.complete = false;
    result.residual_count += 1;
    if (result.residuals.length < limit) result.residuals.push({ id, reason });
    else result.truncated = true;
  };
  const states = initializeStates(nodes, items, now, residual, options.signal);
  indexScheduleEdges(graph, states, options.signal);
  const order = propagateEarliest(nodes, states, options.signal);
  propagateLatest(order, states, options.signal);
  collectScheduleResult(
    nodes,
    states,
    result,
    now,
    limit,
    maxWork,
    residual,
    options.signal,
  );
  return result;
}
