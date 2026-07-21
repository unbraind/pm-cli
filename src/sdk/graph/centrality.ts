/**
 * @module sdk/graph/centrality
 *
 * Structural-importance and fragility analytics over the undirected knowledge
 * graph: exact shortest-path betweenness (Brandes), Wasserman–Faust closeness,
 * undirected degree, and directed fan-in/fan-out per node, plus articulation
 * points and bridges (single points of failure) via an iterative Tarjan
 * low-link search. Every analysis is deterministic, cancellable, exact on the
 * bounded workspace, and reports the visited-node and inspected-edge cost so
 * agents can budget follow-up reads. Adjacency is the simple undirected graph
 * (parallel edges and self-loops collapsed) so a pair connected by any kind
 * counts once.
 */
import {
  RelationshipGraph,
  type RelationshipQueryResult,
} from "../relationships.js";
import { forEachMatchedRelationshipEdge } from "./analytics.js";

/** One node ranked by structural centrality with directed fan-in/fan-out. */
export interface RelationshipCentralityRow {
  /** Node id. */
  id: string;
  /** Undirected unique-neighbor degree over selected kinds. */
  degree: number;
  /** Distinct directed predecessors (fan-in) over directed kinds. */
  inDegree: number;
  /** Distinct directed successors (fan-out) over directed kinds. */
  outDegree: number;
  /** Shortest-path betweenness centrality, rounded to six decimals. */
  betweenness: number;
  /** Wasserman–Faust closeness centrality, rounded to six decimals. */
  closeness: number;
}

/** Bounded centrality-analysis controls. */
export interface GraphCentralityOptions {
  /** Registered relationship kinds whose edges define adjacency. */
  kinds?: readonly string[];
  /** Abort signal checked once per source sweep. */
  signal?: AbortSignal;
}

/** Deterministic centrality ranking over the undirected knowledge graph. */
export interface RelationshipCentralityAnalysis {
  /** Total indexed graph nodes. */
  nodeCount: number;
  /** Simple undirected edge count over selected kinds. */
  edgeCount: number;
  /** Node rows ranked by betweenness, then degree, then id. */
  rows: RelationshipCentralityRow[];
}

/** One undirected bridge edge whose removal disconnects its endpoints. */
export interface RelationshipBridge {
  /** Lexicographically smaller endpoint. */
  source: string;
  /** Lexicographically larger endpoint. */
  target: string;
}

/** Bounded cut-structure controls. */
export interface GraphCutStructureOptions {
  /** Registered relationship kinds whose edges define adjacency. */
  kinds?: readonly string[];
  /** Abort signal checked once per component root. */
  signal?: AbortSignal;
}

/** Articulation points and bridges of the undirected knowledge graph. */
export interface RelationshipCutStructure {
  /** Sorted articulation-point ids — nodes whose removal adds components. */
  articulationPoints: string[];
  /** Bridge edges sorted by source then target. */
  bridges: RelationshipBridge[];
}

/** Round a centrality score to six decimals to suppress floating-point noise. */
function roundScore(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** Add one value to a set-valued map entry, creating the set on demand. */
function addToSetMap(
  map: Map<string, Set<string>>,
  key: string,
  value: string,
): void {
  const set = map.get(key);
  if (set === undefined) map.set(key, new Set([value]));
  else set.add(value);
}

/** Build the deterministic simple undirected adjacency over every node. */
function buildSimpleUndirectedAdjacency(
  graph: RelationshipGraph,
  kinds: readonly string[] | undefined,
): Map<string, string[]> {
  const sets = new Map(graph.nodes().map((id) => [id, new Set<string>()]));
  forEachMatchedRelationshipEdge(graph, kinds, (edge) => {
    sets.get(edge.source)!.add(edge.target);
    sets.get(edge.target)!.add(edge.source);
  });
  const adjacency = new Map<string, string[]>();
  for (const [id, neighbors] of sets) adjacency.set(id, [...neighbors].sort());
  return adjacency;
}

/** Collect distinct directed predecessors and successors per node over directed kinds. */
function collectDirectedDegrees(
  graph: RelationshipGraph,
  kinds: readonly string[] | undefined,
): { incoming: Map<string, Set<string>>; outgoing: Map<string, Set<string>> } {
  const incoming = new Map<string, Set<string>>();
  const outgoing = new Map<string, Set<string>>();
  forEachMatchedRelationshipEdge(graph, kinds, (edge, definition) => {
    if (definition.direction !== "directed") return;
    addToSetMap(outgoing, edge.source, edge.target);
    addToSetMap(incoming, edge.target, edge.source);
  });
  return { incoming, outgoing };
}

/** Single-source shortest-path state accumulated by one Brandes sweep. */
interface BrandesSweep {
  /** Nodes in nondecreasing distance (breadth-first dequeue) order. */
  stack: string[];
  /** Number of shortest paths from the source to each node. */
  sigma: Map<string, number>;
  /** Shortest-path predecessors of each node. */
  predecessors: Map<string, string[]>;
  /** Reachable node count excluding the source. */
  reachableCount: number;
  /** Sum of shortest distances to every reachable node. */
  distanceSum: number;
}

/** Run one breadth-first single-source shortest-path sweep for Brandes accumulation. */
function brandesShortestPaths(
  source: string,
  adjacency: ReadonlyMap<string, readonly string[]>,
  cost: { visitedNodes: number; inspectedEdges: number },
): BrandesSweep {
  const distance = new Map<string, number>([[source, 0]]);
  const sigma = new Map<string, number>([[source, 1]]);
  const predecessors = new Map<string, string[]>();
  const stack: string[] = [];
  const queue = [source];
  let reachableCount = 0;
  let distanceSum = 0;
  for (let index = 0; index < queue.length; index += 1) {
    const node = queue[index]!;
    cost.visitedNodes += 1;
    stack.push(node);
    const nodeDistance = distance.get(node)!;
    if (node !== source) {
      reachableCount += 1;
      distanceSum += nodeDistance;
    }
    for (const neighbor of adjacency.get(node)!) {
      cost.inspectedEdges += 1;
      if (!distance.has(neighbor)) {
        distance.set(neighbor, nodeDistance + 1);
        queue.push(neighbor);
      }
      if (distance.get(neighbor) === nodeDistance + 1) {
        sigma.set(neighbor, (sigma.get(neighbor) ?? 0) + sigma.get(node)!);
        const predecessorList = predecessors.get(neighbor);
        if (predecessorList === undefined) predecessors.set(neighbor, [node]);
        else predecessorList.push(node);
      }
    }
  }
  return { stack, sigma, predecessors, reachableCount, distanceSum };
}

/** Fold one completed sweep's dependencies back into the running betweenness totals. */
function accumulateBetweenness(
  sweep: BrandesSweep,
  source: string,
  betweenness: Map<string, number>,
): void {
  const dependency = new Map<string, number>();
  for (let index = sweep.stack.length - 1; index >= 0; index -= 1) {
    const node = sweep.stack[index]!;
    const share = (1 + (dependency.get(node) ?? 0)) / sweep.sigma.get(node)!;
    for (const predecessor of sweep.predecessors.get(node) ?? []) {
      dependency.set(
        predecessor,
        (dependency.get(predecessor) ?? 0) + sweep.sigma.get(predecessor)! * share,
      );
    }
    if (node !== source)
      betweenness.set(node, (betweenness.get(node) ?? 0) + (dependency.get(node) ?? 0));
  }
}

/**
 * Wasserman–Faust closeness normalizes reachability so disconnected graphs
 * compare fairly. A reachable count above zero implies a positive distance sum
 * (every shortest distance is at least one), so those two guards suffice.
 */
function wassermanFaustCloseness(sweep: BrandesSweep, nodeCount: number): number {
  if (nodeCount <= 1 || sweep.reachableCount === 0) return 0;
  return (
    (sweep.reachableCount / (nodeCount - 1)) *
    (sweep.reachableCount / sweep.distanceSum)
  );
}

/** Assemble one ranked centrality row from the accumulated scores. */
function centralityRow(
  id: string,
  adjacency: ReadonlyMap<string, readonly string[]>,
  directed: ReturnType<typeof collectDirectedDegrees>,
  betweenness: Map<string, number>,
  closeness: Map<string, number>,
): RelationshipCentralityRow {
  return {
    id,
    degree: adjacency.get(id)!.length,
    inDegree: directed.incoming.get(id)?.size ?? 0,
    outDegree: directed.outgoing.get(id)?.size ?? 0,
    // Undirected betweenness double-counts each ordered pair; halve it.
    betweenness: roundScore((betweenness.get(id) ?? 0) / 2),
    // Every node is a sweep source, so closeness is always populated.
    closeness: roundScore(closeness.get(id)!),
  };
}

/**
 * Compute exact shortest-path betweenness (Brandes), Wasserman–Faust closeness,
 * undirected degree, and directed fan-in/fan-out for every node over the simple
 * undirected graph induced by the selected kinds. Rows rank by betweenness, then
 * degree, then id. The result is exact on the bounded workspace; callers bound
 * the returned rows for token-aware projection.
 */
export function computeRelationshipCentrality(
  graph: RelationshipGraph,
  options: GraphCentralityOptions = {},
): RelationshipQueryResult<RelationshipCentralityAnalysis> {
  const adjacency = buildSimpleUndirectedAdjacency(graph, options.kinds);
  const directed = collectDirectedDegrees(graph, options.kinds);
  const nodes = graph.nodes();
  const betweenness = new Map<string, number>();
  const closeness = new Map<string, number>();
  const cost = { visitedNodes: 0, inspectedEdges: 0 };
  for (const source of nodes) {
    options.signal?.throwIfAborted();
    const sweep = brandesShortestPaths(source, adjacency, cost);
    closeness.set(source, wassermanFaustCloseness(sweep, nodes.length));
    accumulateBetweenness(sweep, source, betweenness);
  }
  let degreeSum = 0;
  for (const neighbors of adjacency.values()) degreeSum += neighbors.length;
  const rows = nodes
    .map((id) => centralityRow(id, adjacency, directed, betweenness, closeness))
    .sort(
      (left, right) =>
        right.betweenness - left.betweenness ||
        right.degree - left.degree ||
        left.id.localeCompare(right.id),
    );
  return {
    value: { nodeCount: nodes.length, edgeCount: degreeSum / 2, rows },
    meta: {
      visitedNodes: cost.visitedNodes,
      inspectedEdges: cost.inspectedEdges,
      truncated: false,
    },
  };
}

/** Order one bridge endpoint pair deterministically. */
function orderedBridge(left: string, right: string): RelationshipBridge {
  return left <= right
    ? { source: left, target: right }
    : { source: right, target: left };
}

/** Mutable depth-first frame for the iterative articulation/bridge search. */
interface CutFrame {
  /** Node owned by this frame. */
  node: string;
  /** Depth-first tree parent, or null at a component root. */
  parent: string | null;
  /** Next unexplored neighbor index in the node's adjacency. */
  neighborIndex: number;
  /** Depth-first tree children discovered through this frame. */
  children: number;
}

/** Shared low-link state threaded through the iterative cut-structure search. */
interface CutState {
  /** Discovery index per visited node. */
  discovery: Map<string, number>;
  /** Low-link value per visited node. */
  low: Map<string, number>;
  /** Monotonic discovery counter. */
  timer: number;
  /** Articulation points found so far. */
  articulation: Set<string>;
  /** Bridge edges found so far. */
  bridges: RelationshipBridge[];
  /** Adjacency reads performed. */
  inspectedEdges: number;
}

/**
 * Advance the top frame by one neighbor: descend into an undiscovered neighbor,
 * or relax the low-link against a back edge. Returns the discovered child frame
 * to push, or undefined when the step consumed a back edge or the tree parent.
 */
function advanceCutFrame(
  frame: CutFrame,
  adjacency: ReadonlyMap<string, readonly string[]>,
  state: CutState,
): CutFrame | undefined {
  const neighbors = adjacency.get(frame.node)!;
  const neighbor = neighbors[frame.neighborIndex]!;
  frame.neighborIndex += 1;
  state.inspectedEdges += 1;
  if (neighbor === frame.parent) return undefined;
  if (state.discovery.has(neighbor)) {
    state.low.set(
      frame.node,
      Math.min(state.low.get(frame.node)!, state.discovery.get(neighbor)!),
    );
    return undefined;
  }
  frame.children += 1;
  state.discovery.set(neighbor, state.timer);
  state.low.set(neighbor, state.timer);
  state.timer += 1;
  return { node: neighbor, parent: frame.node, neighborIndex: 0, children: 0 };
}

/** Retreat from a finished frame: fold its low-link into its parent and flag cuts. */
function retreatCutFrame(frame: CutFrame, root: string, state: CutState): void {
  if (frame.parent === null) {
    if (frame.children > 1) state.articulation.add(frame.node);
    return;
  }
  const parent = frame.parent;
  const childLow = state.low.get(frame.node)!;
  state.low.set(parent, Math.min(state.low.get(parent)!, childLow));
  if (parent !== root && childLow >= state.discovery.get(parent)!)
    state.articulation.add(parent);
  if (childLow > state.discovery.get(parent)!)
    state.bridges.push(orderedBridge(parent, frame.node));
}

/** Walk one connected component's depth-first tree, updating low-links and cuts. */
function searchComponentCuts(
  root: string,
  adjacency: ReadonlyMap<string, readonly string[]>,
  state: CutState,
  signal: AbortSignal | undefined,
): void {
  state.discovery.set(root, state.timer);
  state.low.set(root, state.timer);
  state.timer += 1;
  const stack: CutFrame[] = [
    { node: root, parent: null, neighborIndex: 0, children: 0 },
  ];
  while (stack.length > 0) {
    signal?.throwIfAborted();
    const frame = stack.at(-1)!;
    if (frame.neighborIndex < adjacency.get(frame.node)!.length) {
      const child = advanceCutFrame(frame, adjacency, state);
      if (child !== undefined) stack.push(child);
    } else {
      retreatCutFrame(frame, root, state);
      stack.pop();
    }
  }
}

/**
 * Find articulation points and bridges of the undirected knowledge graph with
 * an iterative Tarjan low-link search over the simple adjacency. An articulation
 * point is a node whose removal increases the connected-component count; a bridge
 * is an edge whose removal does the same — both are single points of failure in
 * the relationship graph. Results are deterministic and exact.
 */
export function findRelationshipCutStructure(
  graph: RelationshipGraph,
  options: GraphCutStructureOptions = {},
): RelationshipQueryResult<RelationshipCutStructure> {
  const adjacency = buildSimpleUndirectedAdjacency(graph, options.kinds);
  const state: CutState = {
    discovery: new Map(),
    low: new Map(),
    timer: 0,
    articulation: new Set(),
    bridges: [],
    inspectedEdges: 0,
  };
  for (const root of graph.nodes()) {
    if (state.discovery.has(root)) continue;
    searchComponentCuts(root, adjacency, state, options.signal);
  }
  return {
    value: {
      articulationPoints: [...state.articulation].sort(),
      bridges: state.bridges.sort(
        (left, right) =>
          left.source.localeCompare(right.source) ||
          left.target.localeCompare(right.target),
      ),
    },
    meta: {
      visitedNodes: state.discovery.size,
      inspectedEdges: state.inspectedEdges,
      truncated: false,
    },
  };
}
