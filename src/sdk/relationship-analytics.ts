/**
 * @module sdk/relationship-analytics
 *
 * Provides exact, deterministic graph analytics with explicit semantics and
 * provenance suitable for planning, impact analysis, and context selection.
 */
import type { RelationshipSnapshot } from "./relationship-history.js";
import {
  RelationshipGraph,
  RelationshipKindRegistry,
  createRelationshipKindRegistry,
  type RelationshipEdge,
  type RelationshipQueryOptions,
} from "./relationships.js";

/** Exact execution-graph analysis over registered ordering kinds. */
export interface RelationshipExecutionAnalysis {
  /** Whether the result is exact rather than sampled or approximate. */
  exact: true;
  /** Whether the order-bearing graph is acyclic. */
  acyclic: boolean;
  /** Deterministic topological order for acyclic nodes. */
  order: string[];
  /** Parallelizable topological layers. */
  layers: string[][];
  /** Nodes with no prerequisites. */
  frontier: string[];
  /** Longest prerequisite distance for each acyclic node. */
  depth: Record<string, number>;
  /** Longest deterministic execution path. */
  criticalPath: string[];
  /** Edge count of the critical path. */
  criticalPathLength: number;
  /** Strongly connected order-bearing components that represent cycles. */
  cycles: string[][];
  /** Semantic provenance for the analysis. */
  provenance: { algorithm: "kahn-longest-path"; edgeFamily: "ordering" };
}

/** One affected node with its exact shortest explanation path. */
export interface RelationshipImpactRow {
  /** Affected node identifier. */
  id: string;
  /** Shortest relationship distance from the root. */
  distance: number;
  /** Exact path explaining why the node is affected. */
  path: string[];
}

/** Bounded reverse- or forward-impact result. */
export interface RelationshipImpactAnalysis {
  /** Impact origin. */
  root: string;
  /** Deterministic affected-node rows. */
  affected: RelationshipImpactRow[];
  /** Returned rows are exact even when the bounded result is incomplete. */
  exact: true;
  /** Whether configured traversal bounds omitted reachable work. */
  truncated: boolean;
  /** Query work retained for performance and explainability. */
  cost: { visitedNodes: number; inspectedEdges: number };
}

/** Exact structural summary of the complete graph snapshot. */
export interface RelationshipKnowledgeAnalysis {
  /** Weakly connected components, largest then lexicographic. */
  components: string[][];
  /** Strongly connected components over directed stored edges. */
  stronglyConnected: string[][];
  /** Nodes with no relationship edges. */
  orphans: string[];
  /** Maximum-degree nodes and their unique-neighbor degree. */
  hubs: { id: string; degree: number }[];
  /** Whether the result is exact. */
  exact: true;
  /** Semantic provenance for the analysis. */
  provenance: { algorithm: "component-degree"; edgeFamily: "all" };
}

/** Edge-level delta between two immutable snapshots. */
export interface RelationshipSnapshotComparison {
  /** Earlier snapshot version. */
  fromVersion: number;
  /** Later snapshot version. */
  toVersion: number;
  /** Edges introduced in the later snapshot. */
  added: RelationshipEdge[];
  /** Edges absent from the later snapshot. */
  removed: RelationshipEdge[];
  /** Number of byte-equivalent edges retained. */
  unchangedCount: number;
  /** Whether the comparison is exact. */
  exact: true;
}

/** Registry override for custom domain semantics. */
export interface RelationshipAnalyticsOptions {
  /** Registry used to interpret ordering direction and custom kinds. */
  registry?: RelationshipKindRegistry;
}

function appendNeighbor(
  adjacency: Map<string, Set<string>>,
  source: string,
  target: string,
): void {
  adjacency.get(source)!.add(target);
}

function createAdjacency(nodes: readonly string[]): Map<string, Set<string>> {
  return new Map(nodes.map((node) => [node, new Set<string>()]));
}

function sortComponents(components: string[][]): string[][] {
  for (const component of components) component.sort();
  return components.sort(
    (left, right) =>
      right.length - left.length || left[0]!.localeCompare(right[0]!),
  );
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => stableJsonValue(entry));
  if (value === null || typeof value !== "object") return value;
  const toJSON = (value as { toJSON?: (this: object) => unknown }).toJSON;
  if (typeof toJSON === "function") return stableJsonValue(toJSON.call(value));
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableJsonValue(entry)]),
  );
}

function relationshipEdgeKey(edge: RelationshipEdge): string {
  return JSON.stringify(stableJsonValue(edge));
}

function appendFinishingOrder(
  start: string,
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
  visited: Set<string>,
  order: string[],
): void {
  const stack = [{ id: start, expanded: false }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.expanded) {
      order.push(current.id);
      continue;
    }
    if (visited.has(current.id)) continue;
    visited.add(current.id);
    stack.push({ id: current.id, expanded: true });
    const neighbors = [...adjacency.get(current.id)!].sort().reverse();
    for (const neighbor of neighbors)
      if (!visited.has(neighbor)) stack.push({ id: neighbor, expanded: false });
  }
}

function computeFinishingOrder(
  nodes: readonly string[],
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  const visited = new Set<string>();
  const order: string[] = [];
  for (const start of nodes)
    if (!visited.has(start))
      appendFinishingOrder(start, adjacency, visited, order);
  return order;
}

function collectReverseComponents(
  order: readonly string[],
  reverse: ReadonlyMap<string, ReadonlySet<string>>,
): string[][] {
  const visited = new Set<string>();
  const components: string[][] = [];
  for (const start of [...order].reverse()) {
    if (visited.has(start)) continue;
    const component: string[] = [];
    const stack = [start];
    visited.add(start);
    while (stack.length > 0) {
      const current = stack.pop()!;
      component.push(current);
      for (const neighbor of reverse.get(current)!) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        stack.push(neighbor);
      }
    }
    components.push(component);
  }
  return sortComponents(components);
}

function stronglyConnectedComponents(
  nodes: readonly string[],
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
): string[][] {
  const reverse = createAdjacency(nodes);
  for (const [source, targets] of adjacency)
    for (const target of targets) appendNeighbor(reverse, target, source);
  return collectReverseComponents(
    computeFinishingOrder(nodes, adjacency),
    reverse,
  );
}

function buildExecutionAdjacency(
  graph: RelationshipGraph,
  registry: RelationshipKindRegistry,
): Map<string, Set<string>> {
  const adjacency = createAdjacency(graph.nodes());
  for (const edge of graph.edges()) {
    const definition = registry.require(edge.kind);
    if (!definition.ordering) continue;
    const sourceFirst =
      (definition.precedence ?? "source_before_target") ===
      "source_before_target";
    appendNeighbor(
      adjacency,
      sourceFirst ? edge.source : edge.target,
      sourceFirst ? edge.target : edge.source,
    );
  }
  return adjacency;
}

function topologicalLayers(
  nodes: readonly string[],
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
): string[][] {
  const indegree = new Map(nodes.map((node) => [node, 0]));
  for (const targets of adjacency.values())
    for (const target of targets)
      indegree.set(target, indegree.get(target)! + 1);
  let frontier = nodes.filter((node) => indegree.get(node) === 0).sort();
  const layers: string[][] = [];
  while (frontier.length > 0) {
    layers.push(frontier);
    const next: string[] = [];
    for (const source of frontier) {
      for (const target of adjacency.get(source)!) {
        const remaining = indegree.get(target)! - 1;
        indegree.set(target, remaining);
        if (remaining === 0) next.push(target);
      }
    }
    frontier = next.sort();
  }
  return layers;
}

function longestPath(
  order: readonly string[],
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
): { depth: Record<string, number>; path: string[] } {
  const depth = new Map(order.map((node) => [node, 0]));
  const parent = new Map<string, string>();
  for (const source of order) {
    for (const target of adjacency.get(source)!) {
      if (!depth.has(target)) continue;
      const candidate = depth.get(source)! + 1;
      const currentParent = parent.get(target);
      if (
        candidate > depth.get(target)! ||
        (candidate === depth.get(target)! &&
          (currentParent === undefined ||
            source.localeCompare(currentParent) < 0))
      ) {
        depth.set(target, candidate);
        parent.set(target, source);
      }
    }
  }
  const end = [...order].sort(
    (left, right) =>
      depth.get(right)! - depth.get(left)! || left.localeCompare(right),
  )[0];
  const path = end === undefined ? [] : [end];
  while (path[0] !== undefined && parent.has(path[0]!))
    path.unshift(parent.get(path[0]!)!);
  return { depth: Object.fromEntries(depth), path };
}

/** Analyze registered order-bearing relationships without treating associative cycles as blockers. */
export function analyzeRelationshipExecution(
  graph: RelationshipGraph,
  options: RelationshipAnalyticsOptions = {},
): RelationshipExecutionAnalysis {
  const registry = options.registry ?? createRelationshipKindRegistry();
  const nodes = [...graph.nodes()];
  const adjacency = buildExecutionAdjacency(graph, registry);
  const layers = topologicalLayers(nodes, adjacency);
  const order = layers.flat();
  const acyclic = order.length === nodes.length;
  const cycles = acyclic
    ? []
    : stronglyConnectedComponents(nodes, adjacency).filter(
        (component) =>
          component.length > 1 ||
          adjacency.get(component[0]!)!.has(component[0]!),
      );
  const longest = longestPath(order, adjacency);
  return {
    exact: true,
    acyclic,
    order,
    layers,
    frontier: layers[0] ?? [],
    depth: longest.depth,
    criticalPath: longest.path,
    criticalPathLength: Math.max(0, longest.path.length - 1),
    cycles,
    provenance: { algorithm: "kahn-longest-path", edgeFamily: "ordering" },
  };
}

/** Compute bounded impact rows and exact shortest explanation paths. */
export function analyzeGraphImpact(
  graph: RelationshipGraph,
  root: string,
  options: RelationshipQueryOptions = {},
): RelationshipImpactAnalysis {
  const closure = graph.closure(root, options);
  return {
    root,
    affected: closure.value.map((id) => {
      const path = graph.shortestPath(root, id, options).value;
      return { id, distance: path.length - 1, path };
    }),
    exact: true,
    truncated: closure.meta.truncated,
    cost: {
      visitedNodes: closure.meta.visitedNodes,
      inspectedEdges: closure.meta.inspectedEdges,
    },
  };
}

/** Analyze weak/strong components, isolates, and exact unique-neighbor hubs. */
export function analyzeKnowledgeGraph(
  graph: RelationshipGraph,
): RelationshipKnowledgeAnalysis {
  const nodes = [...graph.nodes()];
  const weak = createAdjacency(nodes);
  const directed = createAdjacency(nodes);
  for (const edge of graph.edges()) {
    appendNeighbor(weak, edge.source, edge.target);
    appendNeighbor(weak, edge.target, edge.source);
    appendNeighbor(directed, edge.source, edge.target);
  }
  const components: string[][] = [];
  const visited = new Set<string>();
  for (const start of nodes) {
    if (visited.has(start)) continue;
    const component: string[] = [];
    const stack = [start];
    visited.add(start);
    while (stack.length > 0) {
      const current = stack.pop()!;
      component.push(current);
      for (const neighbor of weak.get(current)!) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        stack.push(neighbor);
      }
    }
    components.push(component);
  }
  const degrees = nodes.map((id) => ({ id, degree: weak.get(id)!.size }));
  const maximum = Math.max(0, ...degrees.map(({ degree }) => degree));
  return {
    components: sortComponents(components),
    stronglyConnected: stronglyConnectedComponents(nodes, directed),
    orphans: degrees.filter(({ degree }) => degree === 0).map(({ id }) => id),
    hubs: degrees.filter(({ degree }) => degree > 0 && degree === maximum),
    exact: true,
    provenance: { algorithm: "component-degree", edgeFamily: "all" },
  };
}

/** Compare two immutable relationship snapshots by full normalized edge value. */
export function compareRelationshipSnapshots(
  before: RelationshipSnapshot,
  after: RelationshipSnapshot,
): RelationshipSnapshotComparison {
  const earlier = new Map(
    before.edges.map((edge) => [relationshipEdgeKey(edge), edge]),
  );
  const later = new Map(
    after.edges.map((edge) => [relationshipEdgeKey(edge), edge]),
  );
  return {
    fromVersion: before.version,
    toVersion: after.version,
    added: [...later]
      .filter(([key]) => !earlier.has(key))
      .map(([, edge]) => edge),
    removed: [...earlier]
      .filter(([key]) => !later.has(key))
      .map(([, edge]) => edge),
    unchangedCount: [...earlier.keys()].filter((key) => later.has(key)).length,
    exact: true,
  };
}
