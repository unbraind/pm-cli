/**
 * @module sdk/graph/traversal
 *
 * Registry-semantics graph traversal primitives layered over the bounded
 * relationship kernel: hierarchy walks (ancestors/descendants), execution-order
 * walks (predecessors/successors), and bounded simple-path enumeration. Every
 * query is deterministic, cancellable, resumable via an explicit cursor, and
 * reports exact cost and truncation metadata so agents can budget follow-up
 * calls without re-reading the workspace.
 */
import {
  RelationshipGraph,
  type RelationshipEdge,
  type RelationshipKindDefinition,
  type RelationshipNeighborEdge,
  type RelationshipQueryOptions,
  type RelationshipQueryResult,
} from "../relationships.js";

/**
 * Shared bounded-traversal controls extended with deterministic resumption.
 * Semantic hierarchy and ordering orientation comes from the relationship-kind
 * registry, so callers cannot supply the generic graph `direction` option.
 */
export interface GraphTraversalOptions extends Omit<
  RelationshipQueryOptions,
  "direction"
> {
  /**
   * Resume emission after this previously returned node identifier. The
   * traversal re-walks the same deterministic sequence and starts emitting
   * after the cursor node; an identifier the sequence never reaches fails fast
   * instead of silently returning an empty page.
   */
  after?: string;
}

/** One enumerated simple path between two nodes. */
export interface RelationshipPath {
  /** Ordered node identifiers from source to target inclusive. */
  nodes: string[];
  /** Edges connecting consecutive path nodes, in traversal order. */
  edges: RelationshipEdge[];
  /** Number of edges in the path. */
  length: number;
}

/** Bounded-path enumeration controls. */
export interface GraphPathOptions extends RelationshipQueryOptions {
  /** Maximum number of returned paths; defaults to 5. */
  maxPaths?: number;
  /** Safety bound on expanded partial paths before truncation; defaults to 10000. */
  maxVisitedPaths?: number;
}

/** Default number of paths returned by bounded path enumeration. */
const DEFAULT_MAX_PATHS = 5;
/** Default expansion-safety bound for bounded path enumeration. */
const DEFAULT_MAX_VISITED_PATHS = 10_000;
/** Default depth bound applied to bounded path enumeration. */
const DEFAULT_PATH_MAX_DEPTH = 8;

/** Require a finite non-negative integer for one path-enumeration bound. */
function assertPathBound(name: string, value: number): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0)
    throw new TypeError(`Invalid path ${name} bound: ${String(value)}`);
}

/** Endpoint of a hierarchy edge that represents the structural parent. */
export function hierarchyParentEndpoint(
  edge: RelationshipEdge,
  definition: RelationshipKindDefinition,
): string {
  // Custom hierarchy kinds may omit the direction; the registry documents the
  // source endpoint as the default parent.
  return definition.hierarchyDirection === "target_parent"
    ? edge.target
    : edge.source;
}

/** Endpoint of an ordering edge that must finish first. */
export function orderingPredecessorEndpoint(
  edge: RelationshipEdge,
  definition: RelationshipKindDefinition,
): string {
  // Ordering kinds registered without explicit precedence default to
  // source-before-target, matching the execution-analytics interpretation.
  return (definition.precedence ?? "source_before_target") ===
    "target_before_source"
    ? edge.target
    : edge.source;
}

/**
 * Orient one ordering edge into its execution direction — the predecessor that
 * must finish first and the successor it gates — honoring the kind's declared
 * precedence so inverse spellings (`blocked_by`/`blocks`) agree. This is the
 * single ordering-orientation primitive shared by scheduling and degree
 * analytics.
 */
export function orientOrderingEdge(
  edge: RelationshipEdge,
  definition: RelationshipKindDefinition,
): { predecessor: string; successor: string } {
  const predecessor = orderingPredecessorEndpoint(edge, definition);
  return {
    predecessor,
    successor: predecessor === edge.source ? edge.target : edge.source,
  };
}

/** Validate optional kind filters against one semantic edge family. */
function resolveFamilyKinds(
  graph: RelationshipGraph,
  kinds: readonly string[] | undefined,
  family: "hierarchy" | "ordering",
): Set<string> | undefined {
  if (kinds === undefined) return undefined;
  const registry = graph.registry();
  const resolved = new Set<string>();
  for (const kind of kinds) {
    const definition = registry.require(kind);
    if (!definition[family])
      throw new TypeError(
        `Relationship kind ${definition.kind} is not a ${family} kind`,
      );
    resolved.add(definition.kind);
  }
  return resolved;
}

/** Predicate deciding whether a neighbor row participates in one semantic walk. */
type SemanticNeighborPredicate = (
  row: RelationshipNeighborEdge,
  definition: RelationshipKindDefinition,
  nodeId: string,
) => boolean;

/** Mutable state for one bounded semantic breadth-first walk. */
interface SemanticWalkState {
  /** Nodes already discovered during the walk. */
  seen: Set<string>;
  /** Nodes emitted for the current page. */
  value: string[];
  /** Pending breadth-first nodes and their depths. */
  queue: { id: string; depth: number }[];
  /** Whether the optional cursor has been reached. */
  resumed: boolean;
  /** Whether a configured bound omitted reachable work. */
  truncated: boolean;
}

/** Mutable state for bounded simple-path enumeration. */
interface PathEnumerationState {
  /** Completed source-to-target paths. */
  value: RelationshipPath[];
  /** Partial simple paths pending expansion. */
  queue: { nodes: string[]; nodeSet: Set<string>; edges: RelationshipEdge[] }[];
  /** Total graph edges inspected by neighbor queries. */
  inspectedEdges: number;
}

/** Expand one node into its deterministic semantic neighbors. */
function expandSemanticNeighbors(
  graph: RelationshipGraph,
  nodeId: string,
  familyKinds: Set<string> | undefined,
  family: "hierarchy" | "ordering",
  matches: SemanticNeighborPredicate,
): { neighbors: string[]; inspectedEdges: number } {
  const registry = graph.registry();
  const rows = graph.neighborEdges(nodeId, {
    direction: "both",
    ...(familyKinds === undefined ? {} : { kinds: [...familyKinds] }),
  });
  const neighbors: string[] = [];
  const seen = new Set<string>();
  for (const row of rows.value) {
    const definition = registry.require(row.edge.kind);
    if (!definition[family]) continue;
    if (!matches(row, definition, nodeId)) continue;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    neighbors.push(row.id);
  }
  return { neighbors, inspectedEdges: rows.meta.inspectedEdges };
}

/** Append one semantic expansion and report whether the page limit was reached. */
function appendSemanticExpansion(
  expansion: { neighbors: string[] },
  currentDepth: number,
  maxDepth: number,
  limit: number,
  after: string | undefined,
  state: SemanticWalkState,
): boolean {
  if (currentDepth >= maxDepth) {
    if (expansion.neighbors.some((neighbor) => !state.seen.has(neighbor)))
      state.truncated = true;
    return false;
  }
  for (const neighbor of expansion.neighbors) {
    if (state.seen.has(neighbor)) continue;
    state.seen.add(neighbor);
    state.queue.push({ id: neighbor, depth: currentDepth + 1 });
    if (!state.resumed) {
      if (neighbor === after) state.resumed = true;
      continue;
    }
    if (state.value.length >= limit) {
      state.truncated = true;
      return true;
    }
    state.value.push(neighbor);
  }
  return false;
}

/** Run one deterministic bounded breadth-first semantic walk. */
function boundedSemanticWalk(
  graph: RelationshipGraph,
  start: string,
  options: GraphTraversalOptions,
  family: "hierarchy" | "ordering",
  matches: SemanticNeighborPredicate,
): RelationshipQueryResult<string[]> {
  if (!graph.hasNode(start))
    throw new TypeError(`Relationship node not found: ${start}`);
  const familyKinds = resolveFamilyKinds(graph, options.kinds, family);
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
  const after = options.after;
  const state: SemanticWalkState = {
    seen: new Set([start]),
    value: [],
    queue: [{ id: start, depth: 0 }],
    resumed: after === undefined,
    truncated: false,
  };
  let visitedNodes = 0;
  let inspectedEdges = 0;
  for (let index = 0; index < state.queue.length; index += 1) {
    options.signal?.throwIfAborted();
    const current = state.queue[index]!;
    visitedNodes += 1;
    const expansion = expandSemanticNeighbors(
      graph,
      current.id,
      familyKinds,
      family,
      matches,
    );
    inspectedEdges += expansion.inspectedEdges;
    if (
      appendSemanticExpansion(
        expansion,
        current.depth,
        maxDepth,
        limit,
        after,
        state,
      )
    )
      break;
  }
  if (!state.resumed)
    throw new TypeError(`Traversal cursor not found in sequence: ${after}`);
  return {
    value: state.value,
    meta: {
      visitedNodes,
      inspectedEdges,
      truncated: state.truncated,
      nextCursor: state.value.at(-1),
    },
  };
}
/** Validate one path endpoint against the indexed graph. */
function assertPathEndpoint(graph: RelationshipGraph, id: string): void {
  if (!graph.hasNode(id))
    throw new TypeError(`Relationship node not found: ${id}`);
}

/** Return eligible simple-path continuations and account for inspected edges. */
function readPathContinuations(
  graph: RelationshipGraph,
  partial: { nodes: string[]; nodeSet: Set<string>; edges: RelationshipEdge[] },
  options: GraphPathOptions,
  direction: "outgoing" | "incoming" | "both",
  state: PathEnumerationState,
): ReturnType<RelationshipGraph["neighborEdges"]>["value"] {
  const rows = graph.neighborEdges(partial.nodes.at(-1)!, {
    direction,
    ...(options.kinds === undefined ? {} : { kinds: options.kinds }),
  });
  state.inspectedEdges += rows.meta.inspectedEdges;
  return rows.value.filter((row) => !partial.nodeSet.has(row.id));
}

/** Expand one partial simple path and report whether the probe cap was reached. */
function expandPartialPath(
  graph: RelationshipGraph,
  partial: { nodes: string[]; nodeSet: Set<string>; edges: RelationshipEdge[] },
  target: string,
  options: GraphPathOptions,
  direction: "outgoing" | "incoming" | "both",
  probeLimit: number,
  state: PathEnumerationState,
): boolean {
  for (const row of readPathContinuations(
    graph,
    partial,
    options,
    direction,
    state,
  )) {
    const nodes = [...partial.nodes, row.id];
    const nodeSet = new Set(partial.nodeSet).add(row.id);
    const edges = [...partial.edges, row.edge];
    if (row.id === target) {
      state.value.push({ nodes, edges, length: edges.length });
      if (state.value.length >= probeLimit) return true;
    } else {
      state.queue.push({ nodes, nodeSet, edges });
    }
  }
  return false;
}

/**
 * Return the bounded transitive hierarchy ancestors of one node in
 * breadth-first discovery order, honoring each hierarchy kind's declared
 * parent endpoint (so `parent` and inverse `child` spellings agree).
 */
export function hierarchyAncestors(
  graph: RelationshipGraph,
  id: string,
  options: GraphTraversalOptions = {},
): RelationshipQueryResult<string[]> {
  return boundedSemanticWalk(
    graph,
    id,
    options,
    "hierarchy",
    (row, definition) =>
      hierarchyParentEndpoint(row.edge, definition) === row.id,
  );
}

/**
 * Return the bounded transitive hierarchy descendants of one node in
 * breadth-first discovery order, honoring each hierarchy kind's declared
 * parent endpoint.
 */
export function hierarchyDescendants(
  graph: RelationshipGraph,
  id: string,
  options: GraphTraversalOptions = {},
): RelationshipQueryResult<string[]> {
  return boundedSemanticWalk(
    graph,
    id,
    options,
    "hierarchy",
    (row, definition, nodeId) =>
      hierarchyParentEndpoint(row.edge, definition) === nodeId,
  );
}

/**
 * Return the bounded transitive execution predecessors of one node — the work
 * that must finish before it — in breadth-first discovery order, honoring each
 * ordering kind's declared precedence (so `blocked_by` and inverse `blocks`
 * spellings agree).
 */
export function orderingPredecessors(
  graph: RelationshipGraph,
  id: string,
  options: GraphTraversalOptions = {},
): RelationshipQueryResult<string[]> {
  return boundedSemanticWalk(
    graph,
    id,
    options,
    "ordering",
    (row, definition) =>
      orderingPredecessorEndpoint(row.edge, definition) === row.id,
  );
}

/**
 * Return the bounded transitive execution successors of one node — the work
 * this node gates — in breadth-first discovery order, honoring each ordering
 * kind's declared precedence.
 */
export function orderingSuccessors(
  graph: RelationshipGraph,
  id: string,
  options: GraphTraversalOptions = {},
): RelationshipQueryResult<string[]> {
  return boundedSemanticWalk(
    graph,
    id,
    options,
    "ordering",
    (row, definition, nodeId) =>
      orderingPredecessorEndpoint(row.edge, definition) === nodeId,
  );
}

/** Run bounded non-zero path enumeration after public option validation. */
function enumerateNonZeroRelationshipPaths(
  graph: RelationshipGraph,
  source: string,
  target: string,
  options: GraphPathOptions,
  maxPaths: number,
  maxVisitedPaths: number,
  maxDepth: number,
  direction: "outgoing" | "incoming" | "both",
): RelationshipQueryResult<RelationshipPath[]> {
  const state: PathEnumerationState = {
    value: [],
    queue: [{ nodes: [source], nodeSet: new Set([source]), edges: [] }],
    inspectedEdges: 0,
  };
  let visitedNodes = 0;
  let truncated = false;
  const probeLimit = maxPaths + 1;
  for (let index = 0; index < state.queue.length; index += 1) {
    options.signal?.throwIfAborted();
    if (state.value.length >= probeLimit || visitedNodes >= maxVisitedPaths) {
      truncated = true;
      break;
    }
    const partial = state.queue[index]!;
    visitedNodes += 1;
    if (partial.edges.length >= maxDepth) {
      if (
        readPathContinuations(graph, partial, options, direction, state)
          .length > 0
      )
        truncated = true;
      continue;
    }
    if (
      expandPartialPath(
        graph,
        partial,
        target,
        options,
        direction,
        probeLimit,
        state,
      )
    ) {
      truncated = true;
      break;
    }
  }
  return {
    value: state.value.slice(0, maxPaths),
    meta: { visitedNodes, inspectedEdges: state.inspectedEdges, truncated },
  };
}

/**
 * Enumerate bounded simple paths between two nodes, shortest first and
 * lexicographic within equal length. Traversal honors direction and kind
 * filters, caps returned paths, and reports truncation when depth, path-count,
 * or the expansion-safety bound stops the search early.
 */
export function enumerateRelationshipPaths(
  graph: RelationshipGraph,
  source: string,
  target: string,
  options: GraphPathOptions = {},
): RelationshipQueryResult<RelationshipPath[]> {
  assertPathEndpoint(graph, source);
  assertPathEndpoint(graph, target);
  const maxPaths = options.maxPaths ?? DEFAULT_MAX_PATHS;
  const maxVisitedPaths = options.maxVisitedPaths ?? DEFAULT_MAX_VISITED_PATHS;
  const maxDepth = options.maxDepth ?? DEFAULT_PATH_MAX_DEPTH;
  assertPathBound("maxPaths", maxPaths);
  assertPathBound("maxVisitedPaths", maxVisitedPaths);
  assertPathBound("maxDepth", maxDepth);
  const direction = options.direction ?? "outgoing";
  options.signal?.throwIfAborted();
  for (const kind of options.kinds ?? []) graph.registry().require(kind);
  if (source === target) {
    if (maxPaths === 0) {
      return {
        value: [],
        meta: { visitedNodes: 1, inspectedEdges: 0, truncated: true },
      };
    }
    return {
      value: [{ nodes: [source], edges: [], length: 0 }],
      meta: { visitedNodes: 1, inspectedEdges: 0, truncated: false },
    };
  }
  return enumerateNonZeroRelationshipPaths(
    graph,
    source,
    target,
    options,
    maxPaths,
    maxVisitedPaths,
    maxDepth,
    direction,
  );
}
