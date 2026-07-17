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

/** Semantic family explaining why a node or edge participates in graph context. */
export type RelationshipContextRole =
  | "prerequisite"
  | "dependent"
  | "ancestor"
  | "descendant"
  | "provenance"
  | "related";

/**
 * Completeness marker for one graph-context packet.
 *
 * The exact in-memory kernel only produces "complete" and "truncated" today;
 * the remaining values are reserved so index-backed, sampled, or policy-redacted
 * providers can report their result quality through the same contract.
 */
export type RelationshipContextCompleteness =
  | "complete"
  | "truncated"
  | "sampled"
  | "approximate"
  | "stale_index"
  | "redacted";

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
  /** Semantic family of this node relative to its discovery counterpart. */
  role: RelationshipContextRole;
  /** Node through which bounded traversal first discovered this node. */
  via: string;
  /** Concise deterministic reasons the node was selected. */
  reasons: string[];
}

/** Counts-first packet overview served before any row payload. */
export interface RelationshipContextSummary {
  /** Root node identifier. */
  rootId: string;
  /** Root lifecycle status when the caller supplied node details. */
  rootStatus?: string;
  /** Root-incident edge counts per semantic family under the active filters. */
  directEdges: Record<RelationshipContextRole, number>;
  /** Total root-incident edges under the active filters. */
  directTotal: number;
  /** Nodes discovered by the bounded traversal, excluding the root. */
  discoveredNodes: number;
  /** Nodes returned in this page. */
  returnedNodes: number;
  /** Edges returned in this page. */
  returnedEdges: number;
  /** Discovered nodes omitted by pagination, node, or token bounds. */
  omittedNodes: number;
  /** Qualifying edges omitted by edge or token bounds. */
  omittedEdges: number;
  /** Root evidence pointers promoted into the packet. */
  evidenceCount: number;
  /** Whether a continuation cursor is available. */
  hasMore: boolean;
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
  /** Counts-first overview of the packet. */
  summary: RelationshipContextSummary;
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
    completeness: RelationshipContextCompleteness;
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
  via: string;
  role: RelationshipContextRole;
}

/** Deterministic priority used when one node matches several semantic families. */
const RELATIONSHIP_CONTEXT_ROLE_PRIORITY: readonly RelationshipContextRole[] = [
  "prerequisite",
  "dependent",
  "ancestor",
  "descendant",
  "provenance",
  "related",
];

const tokenEncoder = new TextEncoder();

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
  return Math.max(
    1,
    Math.ceil(tokenEncoder.encode(JSON.stringify(value)).byteLength / 4),
  );
}

function explainDirectEdge(
  edge: RelationshipEdge,
  node: string,
  registry: RelationshipKindRegistry,
): RelationshipContextRole {
  const definition = registry.resolve(edge.kind);
  if (definition?.ordering) {
    // Legacy and JSON-parsed definitions may predate explicit precedence.
    const sourceFirst =
      (definition.precedence ?? "source_before_target") ===
      "source_before_target";
    const before = sourceFirst ? edge.source : edge.target;
    return node === before ? "prerequisite" : "dependent";
  }
  if (definition?.hierarchy) {
    // Legacy and JSON-parsed definitions may predate explicit hierarchy direction.
    const sourceIsParent =
      (definition.hierarchyDirection ?? "source_parent") === "source_parent";
    const parent = sourceIsParent ? edge.source : edge.target;
    return node === parent ? "ancestor" : "descendant";
  }
  if (edge.kind === "discovered_from" || edge.kind === "incident_from")
    return "provenance";
  return "related";
}

function directReasons(
  rootEdges: readonly RelationshipEdge[],
  root: string,
  node: string,
  registry: RelationshipKindRegistry,
): RelationshipContextRole[] {
  const reasons = rootEdges
    .filter(
      (edge) =>
        (edge.source === root && edge.target === node) ||
        (edge.target === root && edge.source === node),
    )
    .map((edge) => explainDirectEdge(edge, node, registry));
  return [...new Set(reasons)].sort();
}

/** Pick the deterministic primary family when a node matches several. */
function primaryRole(
  roles: readonly RelationshipContextRole[],
): RelationshipContextRole {
  // Callers only pass non-empty classification sets drawn from the fixed
  // family list, so a priority match always exists.
  return RELATIONSHIP_CONTEXT_ROLE_PRIORITY.find((role) =>
    roles.includes(role),
  )!;
}

function discoverNodes(
  graph: RelationshipGraph,
  root: string,
  registry: RelationshipKindRegistry,
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
  const queue: { id: string; distance: number }[] = [
    { id: root, distance: 0 },
  ];
  const rows: DiscoveredNode[] = [];
  let inspectedEdges = 0;
  let depthTruncated = false;
  for (let index = 0; index < queue.length; index += 1) {
    options.signal?.throwIfAborted();
    const current = queue[index]!;
    if (current.distance >= maxDepth && depthTruncated) continue;
    const adjacent = graph.neighborEdges(current.id, {
      direction,
      kinds: options.kinds,
      signal: options.signal,
    });
    inspectedEdges += adjacent.meta.inspectedEdges;
    if (current.distance >= maxDepth) {
      if (adjacent.value.some((row) => !seen.has(row.id))) depthTruncated = true;
      continue;
    }
    for (const { id, edge } of adjacent.value) {
      if (seen.has(id)) continue;
      seen.add(id);
      const row = {
        id,
        distance: current.distance + 1,
        via: current.id,
        role: explainDirectEdge(edge, id, registry),
      };
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

/** Count root-incident edges per semantic family under the active filters. */
function summarizeDirectEdges(
  graph: RelationshipGraph,
  root: string,
  registry: RelationshipKindRegistry,
  options: RelationshipContextOptions,
): {
  directEdges: Record<RelationshipContextRole, number>;
  directTotal: number;
  rootEdges: RelationshipEdge[];
} {
  const directEdges: Record<RelationshipContextRole, number> = {
    prerequisite: 0,
    dependent: 0,
    ancestor: 0,
    descendant: 0,
    provenance: 0,
    related: 0,
  };
  const rows = graph.neighborEdges(root, {
    direction: options.direction ?? "both",
    kinds: options.kinds,
    signal: options.signal,
  }).value;
  for (const { id, edge } of rows)
    directEdges[explainDirectEdge(edge, id, registry)] += 1;
  return {
    directEdges,
    directTotal: rows.length,
    rootEdges: rows.map(({ edge }) => edge),
  };
}

function selectContextNodes(params: {
  candidates: readonly DiscoveredNode[];
  details: ReadonlyMap<string, RelationshipContextNodeDetails>;
  rootEdges: readonly RelationshipEdge[];
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
    const direct =
      candidate.distance === 1
        ? directReasons(
            params.rootEdges,
            params.rootId,
            candidate.id,
            params.registry,
          )
        : [];
    const node: RelationshipContextNode = {
      ...(params.details.get(candidate.id) ?? { id: candidate.id }),
      distance: candidate.distance,
      role: direct.length > 0 ? primaryRole(direct) : candidate.role,
      via: candidate.via,
      reasons:
        direct.length > 0
          ? direct
          : [
              `${candidate.role} via ${candidate.via} (depth ${candidate.distance})`,
            ],
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
  options: RelationshipContextOptions;
  registry: RelationshipKindRegistry;
  edgeLimit: number;
  tokenBudget: number;
  initialTokens: number;
}): {
  edges: RelationshipEdge[];
  usedTokens: number;
  candidateCount: number;
} {
  const kinds = params.options.kinds
    ? new Set(
        params.options.kinds.map((kind) => params.registry.require(kind).kind),
      )
    : undefined;
  const candidates = params.graph
    .edges()
    .filter(
      (edge) => {
        if (
          !params.included.has(edge.source) ||
          !params.included.has(edge.target)
        )
          return false;
        if (kinds === undefined || kinds.has(edge.kind)) return true;
        const inverse = params.registry.resolve(edge.kind)?.inverse;
        return inverse !== undefined && kinds.has(inverse);
      },
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
  const rootDetails: RelationshipContextNodeDetails = byId.get(rootId) ?? {
    id: rootId,
  };
  const { evidence: rootEvidence = [], ...root } = rootDetails;
  const evidence = [...rootEvidence];
  const discovery = discoverNodes(graph, rootId, registry, options);
  const { rootEdges, ...directSummary } = summarizeDirectEdges(
    graph,
    rootId,
    registry,
    options,
  );
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
  const initialTokens = estimateTokens(root) + estimateTokens(evidence);
  if (initialTokens > tokenBudget)
    throw new TypeError(
      "Relationship context tokenBudget cannot fit root and evidence",
    );
  const nodeSelection = selectContextNodes({
    candidates,
    details: byId,
    rootEdges,
    rootId,
    registry,
    nodeLimit,
    tokenBudget,
    initialTokens,
  });
  const { nodes } = nodeSelection;

  const included = new Set([rootId, ...nodes.map(({ id }) => id)]);
  const edgeSelection = selectContextEdges({
    graph,
    included,
    options,
    registry,
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
  const summary: RelationshipContextSummary = {
    rootId,
    ...(root.status === undefined ? {} : { rootStatus: root.status }),
    ...directSummary,
    discoveredNodes: discovery.rows.length,
    returnedNodes: nodes.length,
    returnedEdges: edges.length,
    omittedNodes: discovery.rows.length - consumed,
    omittedEdges,
    evidenceCount: evidence.length,
    hasMore: hasMoreNodes,
  };
  return {
    root,
    summary,
    nodes,
    edges,
    evidence,
    meta: {
      exact: true,
      truncated,
      completeness: truncated ? "truncated" : "complete",
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
