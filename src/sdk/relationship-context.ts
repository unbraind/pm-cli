/**
 * @module sdk/relationship-context
 *
 * Assembles one explainable, cursorable, token-bounded relationship context
 * packet for agents, custom tools, and presentation-layer adapters.
 */
import {
  createQueryFingerprint,
  encodeQueryCursor,
  resolveQueryCursorStart,
} from "./pagination.js";
import {
  RelationshipGraph,
  RelationshipKindRegistry,
  createRelationshipKindRegistry,
  type RelationshipEdge,
  type RelationshipTraversalDirection,
} from "./relationships.js";

/** Caller-owned compact node details joined into graph context. */
export interface RelationshipContextNodeDetails {
  /** Stable graph node identifier. */
  id: string;
  /** Optional display title. */
  title?: string;
  /** Optional lifecycle status. */
  status?: string;
  /** Optional evidence pointers such as files, tests, or history ids. */
  evidence?: readonly string[];
}

/** One selected graph-context node with explainable inclusion. */
export interface RelationshipContextNode extends RelationshipContextNodeDetails {
  /** Shortest bounded distance from the root. */
  distance: number;
  /** Concise deterministic reasons the node was selected. */
  reasons: string[];
}

/** Controls for bounded graph-context assembly. */
export interface RelationshipContextOptions {
  /** Traversal direction relative to each visited node. */
  direction?: RelationshipTraversalDirection;
  /** Optional registered kind filter. */
  kinds?: readonly string[];
  /** Maximum traversal depth. */
  maxDepth?: number;
  /** Maximum nodes returned in this page. */
  nodeLimit?: number;
  /** Maximum edges returned in this page. */
  edgeLimit?: number;
  /** Maximum estimated output tokens charged to rows and edges. */
  tokenBudget?: number;
  /** Opaque continuation from an equivalent query. */
  cursor?: string;
  /** Registry used to explain custom relationship semantics. */
  registry?: RelationshipKindRegistry;
  /** Abort signal checked during traversal. */
  signal?: AbortSignal;
}

/** Explainable graph context packet. */
export interface RelationshipContextResult {
  /** Root node details. */
  root: RelationshipContextNodeDetails;
  /** Bounded related-node page. */
  nodes: RelationshipContextNode[];
  /** Bounded edges whose endpoints are present in the packet. */
  edges: RelationshipEdge[];
  /** Root evidence pointers promoted for immediate consumption. */
  evidence: string[];
  /** Completeness, continuation, and cost envelope. */
  meta: {
    exact: true;
    truncated: boolean;
    nodeLimit: number;
    edgeLimit: number;
    tokenBudget: number;
    usedTokens: number;
    visitedNodes: number;
    inspectedEdges: number;
    omittedNodes: number;
    omittedEdges: number;
    nextCursor?: string;
  };
}

interface DiscoveredNode {
  id: string;
  distance: number;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  field: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1)
    throw new TypeError(`Relationship context ${field} must be positive`);
  return resolved;
}

function estimateTokens(value: unknown): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(value)) / 4));
}

function explainDirectEdge(
  edge: RelationshipEdge,
  root: string,
  node: string,
  registry: RelationshipKindRegistry,
): string {
  const definition = registry.require(edge.kind);
  if (definition.ordering) {
    const sourceFirst =
      (definition.precedence ?? "source_before_target") ===
      "source_before_target";
    const before = sourceFirst ? edge.source : edge.target;
    return node === before ? "prerequisite" : "dependent";
  }
  if (definition.hierarchy) {
    if (edge.source === root && edge.target === node) return "ancestor";
    return "descendant";
  }
  if (edge.kind === "discovered_from" || edge.kind === "incident_from")
    return "provenance";
  return "related";
}

function directReasons(
  graph: RelationshipGraph,
  root: string,
  node: string,
  registry: RelationshipKindRegistry,
): string[] {
  const reasons = graph
    .edges()
    .filter(
      (edge) =>
        (edge.source === root && edge.target === node) ||
        (edge.target === root && edge.source === node),
    )
    .map((edge) => explainDirectEdge(edge, root, node, registry));
  return [...new Set(reasons)].sort();
}

function discoverNodes(
  graph: RelationshipGraph,
  root: string,
  options: RelationshipContextOptions,
): {
  rows: DiscoveredNode[];
  visitedNodes: number;
  inspectedEdges: number;
  depthTruncated: boolean;
} {
  const direction = options.direction ?? "both";
  const maxDepth = options.maxDepth ?? 3;
  if (!Number.isInteger(maxDepth) || maxDepth < 0)
    throw new TypeError("Relationship context maxDepth must be non-negative");
  const seen = new Set([root]);
  const queue = [{ id: root, distance: 0 }];
  const rows: DiscoveredNode[] = [];
  let inspectedEdges = 0;
  let depthTruncated = false;
  for (let index = 0; index < queue.length; index += 1) {
    options.signal?.throwIfAborted();
    const current = queue[index]!;
    const adjacent = graph.adjacency(current.id, {
      direction,
      kinds: options.kinds,
      signal: options.signal,
    });
    inspectedEdges += adjacent.meta.inspectedEdges;
    if (current.distance >= maxDepth) {
      if (adjacent.value.some((id) => !seen.has(id))) depthTruncated = true;
      continue;
    }
    for (const id of adjacent.value) {
      if (seen.has(id)) continue;
      seen.add(id);
      const row = { id, distance: current.distance + 1 };
      rows.push(row);
      queue.push(row);
    }
  }
  rows.sort(
    (left, right) =>
      left.distance - right.distance || left.id.localeCompare(right.id),
  );
  return {
    rows,
    visitedNodes: queue.length,
    inspectedEdges,
    depthTruncated,
  };
}

function selectContextNodes(params: {
  candidates: readonly DiscoveredNode[];
  details: ReadonlyMap<string, RelationshipContextNodeDetails>;
  graph: RelationshipGraph;
  rootId: string;
  registry: RelationshipKindRegistry;
  nodeLimit: number;
  tokenBudget: number;
  initialTokens: number;
}): { nodes: RelationshipContextNode[]; usedTokens: number } {
  const nodes: RelationshipContextNode[] = [];
  let usedTokens = params.initialTokens;
  for (const candidate of params.candidates) {
    if (nodes.length >= params.nodeLimit) break;
    const node: RelationshipContextNode = {
      ...(params.details.get(candidate.id) ?? { id: candidate.id }),
      distance: candidate.distance,
      reasons:
        candidate.distance === 1
          ? directReasons(
              params.graph,
              params.rootId,
              candidate.id,
              params.registry,
            )
          : [`reachable at depth ${candidate.distance}`],
    };
    const cost = estimateTokens(node);
    if (usedTokens + cost > params.tokenBudget) break;
    nodes.push(node);
    usedTokens += cost;
  }
  if (params.candidates.length > 0 && nodes.length === 0)
    throw new TypeError("Relationship context tokenBudget cannot fit one node");
  return { nodes, usedTokens };
}

function selectContextEdges(params: {
  graph: RelationshipGraph;
  included: ReadonlySet<string>;
  edgeLimit: number;
  tokenBudget: number;
  initialTokens: number;
}): {
  edges: RelationshipEdge[];
  usedTokens: number;
  candidateCount: number;
} {
  const candidates = params.graph
    .edges()
    .filter(
      (edge) =>
        params.included.has(edge.source) && params.included.has(edge.target),
    );
  const edges: RelationshipEdge[] = [];
  let usedTokens = params.initialTokens;
  for (const edge of candidates) {
    if (edges.length >= params.edgeLimit) break;
    const cost = estimateTokens(edge);
    if (usedTokens + cost > params.tokenBudget) break;
    edges.push(edge);
    usedTokens += cost;
  }
  return { edges, usedTokens, candidateCount: candidates.length };
}

/** Build one deterministic bounded graph-context packet with continuation. */
export function buildRelationshipContext(
  graph: RelationshipGraph,
  rootId: string,
  details: readonly RelationshipContextNodeDetails[],
  options: RelationshipContextOptions = {},
): RelationshipContextResult {
  if (!graph.nodes().includes(rootId))
    throw new TypeError(`Relationship node not found: ${rootId}`);
  const nodeLimit = positiveInteger(options.nodeLimit, 20, "nodeLimit");
  const edgeLimit = positiveInteger(options.edgeLimit, 40, "edgeLimit");
  const tokenBudget = positiveInteger(options.tokenBudget, 1200, "tokenBudget");
  const registry = options.registry ?? createRelationshipKindRegistry();
  const byId = new Map(details.map((detail) => [detail.id, detail]));
  const root = { ...(byId.get(rootId) ?? { id: rootId }) };
  const evidence = [...(root.evidence ?? [])];
  const discovery = discoverNodes(graph, rootId, options);
  const fingerprint = createQueryFingerprint("relationship-context", {
    rootId,
    direction: options.direction ?? "both",
    kinds: [...(options.kinds ?? [])].sort(),
    maxDepth: options.maxDepth ?? 3,
  });
  const pageStart = resolveQueryCursorStart(
    discovery.rows,
    options.cursor,
    fingerprint,
    ({ id }) => id,
  );
  const candidates = discovery.rows.slice(pageStart);
  const nodeSelection = selectContextNodes({
    candidates,
    details: byId,
    graph,
    rootId,
    registry,
    nodeLimit,
    tokenBudget,
    initialTokens: estimateTokens(root) + estimateTokens(evidence),
  });
  const { nodes } = nodeSelection;

  const included = new Set([rootId, ...nodes.map(({ id }) => id)]);
  const edgeSelection = selectContextEdges({
    graph,
    included,
    edgeLimit,
    tokenBudget,
    initialTokens: nodeSelection.usedTokens,
  });
  const { edges, usedTokens } = edgeSelection;

  const consumed = pageStart + nodes.length;
  const hasMoreNodes = consumed < discovery.rows.length;
  const lastNode = nodes.at(-1);
  const omittedEdges = edgeSelection.candidateCount - edges.length;
  const truncated =
    discovery.depthTruncated || hasMoreNodes || omittedEdges > 0;
  return {
    root,
    nodes,
    edges,
    evidence,
    meta: {
      exact: true,
      truncated,
      nodeLimit,
      edgeLimit,
      tokenBudget,
      usedTokens,
      visitedNodes: discovery.visitedNodes,
      inspectedEdges: discovery.inspectedEdges,
      omittedNodes: discovery.rows.length - consumed,
      omittedEdges,
      ...(hasMoreNodes && lastNode
        ? {
            nextCursor: encodeQueryCursor(
              fingerprint,
              lastNode.id,
              consumed - 1,
            ),
          }
        : {}),
    },
  };
}
