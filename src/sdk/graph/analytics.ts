/**
 * @module sdk/graph/analytics
 *
 * Structural graph analytics beyond exact components: deterministic
 * label-propagation community detection over the undirected relationship
 * structure, transitively redundant edge discovery over ordering and
 * hierarchy families, and dominator (bottleneck) analysis over one node's
 * reachable subgraph. Every analysis is deterministic, cancellable, bounded,
 * and reports exact cost metadata so agents can budget follow-up reads
 * without re-scanning the workspace.
 */
import {
  RelationshipGraph,
  type RelationshipEdge,
  type RelationshipKindDefinition,
  type RelationshipNeighborEdge,
  type RelationshipQueryResult,
  type RelationshipTraversalDirection,
} from "../relationships.js";
import {
  hierarchyParentEndpoint,
  orderingPredecessorEndpoint,
} from "./traversal.js";

/** Default label-propagation sweeps before reporting non-convergence. */
const DEFAULT_MAX_ITERATIONS = 16;
/** Default minimum member count for a reported community. */
const DEFAULT_MIN_COMMUNITY_SIZE = 2;
/** Default witness-path depth searched per candidate redundant edge. */
const DEFAULT_REDUNDANCY_MAX_DEPTH = 8;

/** One detected relationship community. */
export interface RelationshipCommunity {
  /** Lexicographically smallest member id, naming the community. */
  representative: string;
  /** Total member count. */
  size: number;
  /** Sorted member node ids. */
  members: string[];
}

/** Bounded community-detection controls. */
export interface GraphCommunityOptions {
  /** Registered relationship kinds whose edges define adjacency. */
  kinds?: readonly string[];
  /** Maximum label-propagation sweeps before reporting non-convergence; defaults to 16. */
  maxIterations?: number;
  /** Minimum member count for a reported community; defaults to 2. */
  minSize?: number;
  /** Abort signal checked once per sweep. */
  signal?: AbortSignal;
}

/** Deterministic label-propagation community analysis. */
export interface RelationshipCommunityAnalysis {
  /** Detected communities, largest first and by representative within equal size. */
  communities: RelationshipCommunity[];
  /** Label-propagation sweeps executed. */
  iterations: number;
  /** Whether labels stabilized before the iteration bound stopped the sweep. */
  converged: boolean;
}

/** One stored edge implied by a longer same-family witness path. */
export interface RedundantRelationshipEdge {
  /** The stored redundant edge in its original spelling. */
  edge: RelationshipEdge;
  /** Semantic-orientation witness node path proving the implication, endpoints inclusive. */
  witness: string[];
}

/** Bounded redundancy-scan controls. */
export interface GraphRedundancyOptions {
  /** Directed ordering or hierarchy kinds to scan; defaults to every eligible registered kind. */
  kinds?: readonly string[];
  /** Maximum witness-path depth searched per edge; defaults to 8. */
  maxDepth?: number;
  /** Maximum reported redundant edges. */
  limit?: number;
  /** Abort signal checked once per scanned edge. */
  signal?: AbortSignal;
}

/** One reachable node with its immediate dominator and gating weight. */
export interface RelationshipDominatorRow {
  /** Reachable node id. */
  id: string;
  /** Immediate dominator appearing on every root-to-node path. */
  idom: string;
  /** Nodes strictly dominated by this node — its dominator-subtree size minus itself. */
  dominatedCount: number;
}

/** Bounded dominator-analysis controls. */
export interface GraphDominatorOptions {
  /** Registered relationship kinds whose edges define reachability. */
  kinds?: readonly string[];
  /** Traversal direction relative to each visited node; defaults to "outgoing". */
  direction?: RelationshipTraversalDirection;
  /** Maximum reachability depth from the root as a non-negative integer. */
  maxDepth?: number;
  /** Abort signal checked once per processed node. */
  signal?: AbortSignal;
}

/** Dominator-tree analysis of one node's reachable subgraph. */
export interface RelationshipDominatorAnalysis {
  /** Analyzed root id. */
  root: string;
  /** Reachable node count including the root. */
  reachableCount: number;
  /** Non-root reachable rows sorted by gating weight, then id. */
  rows: RelationshipDominatorRow[];
}

/** Require a positive integer for one analytics bound. */
function assertPositiveBound(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1)
    throw new TypeError(`Invalid ${name} bound: ${String(value)}`);
}

/** Build the deterministic undirected adjacency restricted to canonicalized kinds. */
function buildUndirectedAdjacency(
  graph: RelationshipGraph,
  kinds: readonly string[] | undefined,
): Map<string, string[]> {
  const registry = graph.registry();
  const wanted =
    kinds === undefined
      ? undefined
      : new Set(kinds.map((kind) => registry.require(kind).kind));
  const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges()) {
    if (edge.source === edge.target) continue;
    if (wanted !== undefined) {
      const definition = registry.require(edge.kind);
      const matches =
        wanted.has(definition.kind) ||
        (definition.inverse !== undefined && wanted.has(definition.inverse));
      if (!matches) continue;
    }
    appendAdjacency(adjacency, edge.source, edge.target);
    appendAdjacency(adjacency, edge.target, edge.source);
  }
  for (const neighbors of adjacency.values()) neighbors.sort();
  return adjacency;
}

/** Append one neighbor to a node's adjacency list, creating the list on demand. */
function appendAdjacency(
  adjacency: Map<string, string[]>,
  from: string,
  to: string,
): void {
  const neighbors = adjacency.get(from);
  if (neighbors === undefined) adjacency.set(from, [to]);
  else neighbors.push(to);
}

/** Adopt the most frequent neighbor label with lexicographic tie-breaking. */
function dominantNeighborLabel(
  neighbors: readonly string[],
  labels: Map<string, string>,
): string {
  const counts = new Map<string, number>();
  for (const neighbor of neighbors) {
    const label = labels.get(neighbor)!;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [label, count] of counts) {
    if (count > bestCount || (count === bestCount && label < best!)) {
      best = label;
      bestCount = count;
    }
  }
  return best!;
}

/** Group stabilized labels into sorted communities meeting the size floor. */
function collectCommunities(
  labels: Map<string, string>,
  minSize: number,
): RelationshipCommunity[] {
  const groups = new Map<string, string[]>();
  for (const [id, label] of labels) {
    const members = groups.get(label);
    if (members === undefined) groups.set(label, [id]);
    else members.push(id);
  }
  const communities: RelationshipCommunity[] = [];
  for (const members of groups.values()) {
    if (members.length < minSize) continue;
    members.sort();
    communities.push({
      representative: members[0]!,
      size: members.length,
      members,
    });
  }
  return communities.sort(
    (left, right) =>
      right.size - left.size ||
      left.representative.localeCompare(right.representative),
  );
}

/**
 * Detect communities with deterministic asynchronous label propagation: nodes
 * are swept in sorted order, each adopting the most frequent label among its
 * neighbors with lexicographic tie-breaking, until labels stabilize or the
 * iteration bound stops the sweep. Adjacency is undirected — every
 * participating edge connects both endpoints symmetrically and parallel edges
 * weight their neighbor. `meta.truncated` reports non-convergence.
 */
export function detectRelationshipCommunities(
  graph: RelationshipGraph,
  options: GraphCommunityOptions = {},
): RelationshipQueryResult<RelationshipCommunityAnalysis> {
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const minSize = options.minSize ?? DEFAULT_MIN_COMMUNITY_SIZE;
  assertPositiveBound("maxIterations", maxIterations);
  assertPositiveBound("minSize", minSize);
  const adjacency = buildUndirectedAdjacency(graph, options.kinds);
  const nodes = graph.nodes();
  const labels = new Map(nodes.map((id) => [id, id]));
  let iterations = 0;
  let converged = false;
  let visitedNodes = 0;
  let inspectedEdges = 0;
  while (iterations < maxIterations && !converged) {
    options.signal?.throwIfAborted();
    iterations += 1;
    converged = true;
    for (const id of nodes) {
      visitedNodes += 1;
      const neighbors = adjacency.get(id);
      if (neighbors === undefined) continue;
      inspectedEdges += neighbors.length;
      const dominant = dominantNeighborLabel(neighbors, labels);
      if (dominant !== labels.get(id)) {
        labels.set(id, dominant);
        converged = false;
      }
    }
  }
  return {
    value: {
      communities: collectCommunities(labels, minSize),
      iterations,
      converged,
    },
    meta: { visitedNodes, inspectedEdges, truncated: !converged },
  };
}

/** Decide whether a kind carries transitive semantics eligible for redundancy analysis. */
function isTransitiveKind(definition: RelationshipKindDefinition): boolean {
  return (
    definition.direction === "directed" &&
    (definition.ordering || definition.hierarchy)
  );
}

/** Family grouping key joining a directed kind with its inverse spelling. */
function transitiveFamilyKey(definition: RelationshipKindDefinition): string {
  return definition.inverse !== undefined &&
    definition.inverse < definition.kind
    ? definition.inverse
    : definition.kind;
}

/** Orient one transitive edge into its semantic forward direction. */
function orientTransitiveEdge(
  edge: RelationshipEdge,
  definition: RelationshipKindDefinition,
): { from: string; to: string } {
  // Hierarchy families flow child -> parent; ordering families flow
  // predecessor -> successor, so inverse spellings land in one relation.
  const head = definition.hierarchy
    ? hierarchyParentEndpoint(edge, definition)
    : edge.source === orderingPredecessorEndpoint(edge, definition)
      ? edge.target
      : edge.source;
  return head === edge.target
    ? { from: edge.source, to: edge.target }
    : { from: edge.target, to: edge.source };
}

/** One semantically oriented transitive edge retaining its stored spelling. */
interface OrientedTransitiveEdge {
  /** Semantic tail node. */
  from: string;
  /** Semantic head node. */
  to: string;
  /** Original stored edge. */
  edge: RelationshipEdge;
}

/** Per-family oriented edges and their deterministic forward adjacency. */
interface TransitiveFamily {
  /** Deduplicated forward adjacency in semantic orientation, sorted after collection. */
  adjacency: Map<string, Set<string>>;
  /** Oriented edges in deterministic stored order. */
  records: OrientedTransitiveEdge[];
}

/** Resolve explicit redundancy kind filters into their family keys. */
function resolveRedundancyFamilies(
  graph: RelationshipGraph,
  kinds: readonly string[] | undefined,
): Set<string> | undefined {
  if (kinds === undefined) return undefined;
  const registry = graph.registry();
  const families = new Set<string>();
  for (const kind of kinds) {
    const definition = registry.require(kind);
    if (!isTransitiveKind(definition))
      throw new TypeError(
        `Relationship kind ${definition.kind} is not a directed ordering or hierarchy kind`,
      );
    families.add(transitiveFamilyKey(definition));
  }
  return families;
}

/** Group eligible stored edges into oriented per-family scan structures. */
function collectTransitiveFamilies(
  graph: RelationshipGraph,
  wanted: Set<string> | undefined,
): Map<string, TransitiveFamily> {
  const registry = graph.registry();
  const families = new Map<string, TransitiveFamily>();
  for (const edge of graph.edges()) {
    const definition = registry.require(edge.kind);
    if (!isTransitiveKind(definition)) continue;
    const key = transitiveFamilyKey(definition);
    if (wanted !== undefined && !wanted.has(key)) continue;
    const oriented = orientTransitiveEdge(edge, definition);
    if (oriented.from === oriented.to) continue;
    let family = families.get(key);
    if (family === undefined) {
      family = { adjacency: new Map(), records: [] };
      families.set(key, family);
    }
    const targets = family.adjacency.get(oriented.from);
    if (targets === undefined)
      family.adjacency.set(oriented.from, new Set([oriented.to]));
    else targets.add(oriented.to);
    family.records.push({ ...oriented, edge });
  }
  return families;
}

/** Freeze one family's adjacency sets into deterministic sorted lists. */
function sortedFamilyAdjacency(
  family: TransitiveFamily,
): Map<string, readonly string[]> {
  const sorted = new Map<string, readonly string[]>();
  for (const [from, targets] of family.adjacency)
    sorted.set(from, [...targets].sort());
  return sorted;
}

/** Rebuild the witness node path from breadth-first parent pointers. */
function reconstructWitness(
  parents: Map<string, string>,
  from: string,
  tail: string,
  head: string,
): string[] {
  const witness = [head];
  for (let node = tail; node !== from; node = parents.get(node)!)
    witness.push(node);
  witness.push(from);
  return witness.reverse();
}

/** Expand one witness frontier node; return the completed witness when the head is reached. */
function expandWitnessFrontier(
  adjacency: Map<string, readonly string[]>,
  record: OrientedTransitiveEdge,
  current: { id: string; depth: number },
  parents: Map<string, string>,
  queue: { id: string; depth: number }[],
  cost: { visitedNodes: number; inspectedEdges: number },
): string[] | undefined {
  for (const next of adjacency.get(current.id) ?? []) {
    cost.inspectedEdges += 1;
    // Skip the direct edge under test; deeper hops may still reach the head.
    if (current.depth === 0 && next === record.to) continue;
    if (parents.has(next)) continue;
    parents.set(next, current.id);
    if (next === record.to)
      return reconstructWitness(parents, record.from, current.id, next);
    queue.push({ id: next, depth: current.depth + 1 });
  }
  return undefined;
}

/** Search one bounded same-family witness path that implies a direct edge. */
function findWitnessPath(
  adjacency: Map<string, readonly string[]>,
  record: OrientedTransitiveEdge,
  maxDepth: number,
  cost: { visitedNodes: number; inspectedEdges: number },
): string[] | undefined {
  const parents = new Map<string, string>([[record.from, record.from]]);
  const queue = [{ id: record.from, depth: 0 }];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    cost.visitedNodes += 1;
    if (current.depth >= maxDepth) continue;
    const witness = expandWitnessFrontier(
      adjacency,
      record,
      current,
      parents,
      queue,
      cost,
    );
    if (witness !== undefined) return witness;
  }
  return undefined;
}

/**
 * Find stored edges implied by a longer path of the same semantic family —
 * the transitive-reduction view of ordering and hierarchy relations. Each
 * family joins a directed kind with its inverse spelling in semantic
 * orientation, so `blocked_by` and `blocks` witness each other. The witness
 * search is breadth-first, shortest and lexicographic first, bounded by
 * `maxDepth` per edge; `meta.truncated` reports only the `limit` bound.
 */
export function findRedundantRelationshipEdges(
  graph: RelationshipGraph,
  options: GraphRedundancyOptions = {},
): RelationshipQueryResult<RedundantRelationshipEdge[]> {
  const maxDepth = options.maxDepth ?? DEFAULT_REDUNDANCY_MAX_DEPTH;
  assertPositiveBound("maxDepth", maxDepth);
  if (options.limit !== undefined) assertPositiveBound("limit", options.limit);
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const wanted = resolveRedundancyFamilies(graph, options.kinds);
  const families = collectTransitiveFamilies(graph, wanted);
  const value: RedundantRelationshipEdge[] = [];
  const cost = { visitedNodes: 0, inspectedEdges: 0 };
  let truncated = false;
  scan: for (const key of [...families.keys()].sort()) {
    const family = families.get(key)!;
    const adjacency = sortedFamilyAdjacency(family);
    for (const record of family.records) {
      options.signal?.throwIfAborted();
      const witness = findWitnessPath(adjacency, record, maxDepth, cost);
      if (witness === undefined) continue;
      if (value.length >= limit) {
        truncated = true;
        break scan;
      }
      value.push({ edge: record.edge, witness });
    }
  }
  return {
    value,
    meta: {
      visitedNodes: cost.visitedNodes,
      inspectedEdges: cost.inspectedEdges,
      truncated,
    },
  };
}

/** Reachability index of one root's directed subgraph. */
interface ReachableSubgraph {
  /** Reachable node ids in breadth-first discovery order. */
  order: string[];
  /** Deterministic successor lists per reachable node. */
  successors: Map<string, string[]>;
  /** Reachable predecessor sets per reachable node. */
  predecessors: Map<string, Set<string>>;
  /** Candidate edges inspected while indexing. */
  inspectedEdges: number;
  /** Whether the depth bound excluded reachable nodes. */
  truncated: boolean;
}

/** Mutable frontier state threaded through bounded reachability expansion. */
interface ReachabilityState {
  /** Nodes already discovered. */
  seen: Set<string>;
  /** Pending breadth-first nodes and their depths. */
  queue: { id: string; depth: number }[];
  /** Reachable predecessor sets per discovered node. */
  predecessors: Map<string, Set<string>>;
  /** Whether the depth bound excluded reachable nodes. */
  truncated: boolean;
}

/** Expand one node's neighbor rows into successors, predecessors, and frontier work. */
function expandReachableNode(
  id: string,
  depth: number,
  rows: readonly RelationshipNeighborEdge[],
  maxDepth: number,
  state: ReachabilityState,
): string[] {
  const nextSet = new Set<string>();
  const nexts: string[] = [];
  for (const row of rows) {
    if (row.id === id || nextSet.has(row.id)) continue;
    if (!state.seen.has(row.id)) {
      // A depth-boundary node keeps its edges to already-indexed nodes but
      // may not discover new ones; excluded discoveries mark truncation.
      if (depth >= maxDepth) {
        state.truncated = true;
        continue;
      }
      state.seen.add(row.id);
      state.queue.push({ id: row.id, depth: depth + 1 });
    }
    nextSet.add(row.id);
    nexts.push(row.id);
    let incoming = state.predecessors.get(row.id);
    if (incoming === undefined) {
      incoming = new Set();
      state.predecessors.set(row.id, incoming);
    }
    incoming.add(id);
  }
  return nexts;
}

/** Index the bounded reachable subgraph used by dominator analysis. */
function indexReachableSubgraph(
  graph: RelationshipGraph,
  root: string,
  options: GraphDominatorOptions,
): ReachableSubgraph {
  const direction = options.direction ?? "outgoing";
  const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
  const order: string[] = [];
  const successors = new Map<string, string[]>();
  const state: ReachabilityState = {
    seen: new Set([root]),
    queue: [{ id: root, depth: 0 }],
    predecessors: new Map(),
    truncated: false,
  };
  let inspectedEdges = 0;
  for (let index = 0; index < state.queue.length; index += 1) {
    options.signal?.throwIfAborted();
    const { id, depth } = state.queue[index]!;
    order.push(id);
    const rows = graph.neighborEdges(id, {
      direction,
      ...(options.kinds === undefined ? {} : { kinds: options.kinds }),
    });
    inspectedEdges += rows.meta.inspectedEdges;
    successors.set(id, expandReachableNode(id, depth, rows.value, maxDepth, state));
  }
  return {
    order,
    successors,
    predecessors: state.predecessors,
    inspectedEdges,
    truncated: state.truncated,
  };
}

/** Compute the deterministic reverse postorder of one reachable subgraph. */
function reversePostorder(subgraph: ReachableSubgraph, root: string): string[] {
  const postorder: string[] = [];
  const visited = new Set([root]);
  const stack = [{ id: root, index: 0 }];
  while (stack.length > 0) {
    const frame = stack.at(-1)!;
    const nexts = subgraph.successors.get(frame.id)!;
    if (frame.index < nexts.length) {
      const next = nexts[frame.index]!;
      frame.index += 1;
      if (!visited.has(next)) {
        visited.add(next);
        stack.push({ id: next, index: 0 });
      }
    } else {
      postorder.push(frame.id);
      stack.pop();
    }
  }
  return postorder.reverse();
}

/** Walk two dominator-tree fingers to their common ancestor by reverse-postorder number. */
function intersectDominators(
  left: string,
  right: string,
  idom: Map<string, string>,
  ordinal: Map<string, number>,
): string {
  let first = left;
  let second = right;
  while (first !== second) {
    while (ordinal.get(first)! > ordinal.get(second)!) first = idom.get(first)!;
    while (ordinal.get(second)! > ordinal.get(first)!) second = idom.get(second)!;
  }
  return first;
}

/** Fold one node's processed predecessors into its dominator candidate. */
function dominatorCandidate(
  predecessors: ReadonlySet<string>,
  idom: Map<string, string>,
  ordinal: Map<string, number>,
): string | undefined {
  let candidate: string | undefined;
  for (const pred of [...predecessors].sort()) {
    if (!idom.has(pred)) continue;
    candidate =
      candidate === undefined
        ? pred
        : intersectDominators(candidate, pred, idom, ordinal);
  }
  return candidate;
}

/** Run the Cooper–Harvey–Kennedy fixed-point over one reverse postorder. */
function solveImmediateDominators(
  subgraph: ReachableSubgraph,
  root: string,
  order: readonly string[],
  ordinal: Map<string, number>,
  signal: AbortSignal | undefined,
): Map<string, string> {
  const idom = new Map<string, string>([[root, root]]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of order) {
      signal?.throwIfAborted();
      if (id === root) continue;
      // Every non-root node in the order was discovered through at least one
      // predecessor, so the set is always present.
      const candidate = dominatorCandidate(
        subgraph.predecessors.get(id)!,
        idom,
        ordinal,
      );
      if (candidate !== undefined && idom.get(id) !== candidate) {
        idom.set(id, candidate);
        changed = true;
      }
    }
  }
  return idom;
}

/**
 * Compute immediate dominators and gating weights over one node's reachable
 * subgraph using the Cooper–Harvey–Kennedy fixed-point. A node dominates the
 * work that every path from the root must pass through it to reach, so rows
 * with a positive `dominatedCount` are the structural bottlenecks of the
 * root's blast radius. Rows sort by gating weight, then id; `meta.truncated`
 * reports when the `maxDepth` bound excluded reachable nodes.
 */
export function computeRelationshipDominators(
  graph: RelationshipGraph,
  root: string,
  options: GraphDominatorOptions = {},
): RelationshipQueryResult<RelationshipDominatorAnalysis> {
  if (!graph.hasNode(root))
    throw new TypeError(`Relationship node not found: ${root}`);
  if (
    options.maxDepth !== undefined &&
    (!Number.isInteger(options.maxDepth) || options.maxDepth < 0)
  )
    throw new TypeError(`Invalid maxDepth bound: ${String(options.maxDepth)}`);
  const subgraph = indexReachableSubgraph(graph, root, options);
  const order = reversePostorder(subgraph, root);
  const ordinal = new Map(order.map((id, index) => [id, index]));
  const idom = solveImmediateDominators(
    subgraph,
    root,
    order,
    ordinal,
    options.signal,
  );
  const subtreeSizes = new Map(order.map((id) => [id, 1]));
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const id = order[index]!;
    if (id === root) continue;
    const parent = idom.get(id)!;
    subtreeSizes.set(parent, subtreeSizes.get(parent)! + subtreeSizes.get(id)!);
  }
  const rows = order
    .filter((id) => id !== root)
    .map((id) => ({
      id,
      idom: idom.get(id)!,
      dominatedCount: subtreeSizes.get(id)! - 1,
    }))
    .sort(
      (left, right) =>
        right.dominatedCount - left.dominatedCount ||
        left.id.localeCompare(right.id),
    );
  return {
    value: { root, reachableCount: subgraph.order.length, rows },
    meta: {
      visitedNodes: subgraph.order.length,
      inspectedEdges: subgraph.inspectedEdges,
      truncated: subgraph.truncated,
    },
  };
}
