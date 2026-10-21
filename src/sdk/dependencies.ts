/**
 * @module sdk/dependencies
 *
 * Implements the pm deps command surface and its agent-facing runtime behavior.
 */
import { assertInitializedTracker } from "./environment/tracker-preflight.js";
import {
  getActiveCommandContext,
  getActiveExtensionRegistrations,
} from "../core/extensions/index.js";
import { resolveItemTypeRegistry } from "../core/item/type-registry.js";
import { isTerminalStatus } from "../core/item/status.js";
import { resolveRuntimeStatusRegistry } from "../core/schema/runtime-schema.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import type { GlobalOptions } from "../core/shared/command-types.js";
import { PmCliError } from "../core/shared/errors.js";
import { formatBuiltInOutput } from "../core/output/output.js";
import {
  listAllItemMetadataLight,
  locateItem,
  readLocatedItem,
} from "../core/store/item-store.js";
import { resolvePmRoot } from "../core/store/paths.js";
import { readSettings } from "../core/store/settings.js";
import type {
  Dependency,
  ItemMetadata,
  ItemStatus,
  ItemType,
} from "../types/index.js";
import { estimatePmOutputTokens } from "./cli-contracts/agent-output-contracts.js";
import { renderPmCommand } from "./command-line.js";
import { createPmCliExpectedError, type PmCliExpectedError } from "./errors.js";
import {
  isReadOutputBudgetExceeded,
  normalizeReadOutputIncludeModeOptions,
  PM_READ_OUTPUT_SURFACE_CONTRACTS,
} from "./read-output-contracts.js";
import { READ_OUTPUT_INVOCATION_PROVENANCE } from "./read-output/provenance.js";
import type { ContextBudgetProbe } from "./dependencies/context-budget-recovery.js";
import { attachReadOutputContracts } from "./context-intent-contracts.js";
import { attachOutputTokenAccounting } from "./output-token-accounting.js";
import {
  assertProjectionModeChoice,
  type OutputProjectionDeclaration,
} from "./output-projection.js";
import {
  assembleWorkspaceRelationshipGraph,
  collectDanglingDependencyReferences,
  resolveWorkspaceRelationshipKindRegistry,
  type DanglingDependencyReference,
  type WorkspaceRelationshipAssembly,
} from "./graph/assembly.js";
import {
  computeWorkspaceGraphFingerprint,
  workspaceGraphCache,
} from "./graph/cache.js";
import {
  buildRelationshipContext,
  DEFAULT_RELATIONSHIP_CONTEXT_TOKEN_BUDGET,
  type RelationshipContextOptions,
  type RelationshipContextResult,
} from "./relationship-context.js";
import {
  createRelationshipKindRegistry,
  type RelationshipKindRegistry,
} from "./relationships.js";

/** Supported values accepted by the deps format contract. */
export const DEPS_FORMAT_VALUES = ["tree", "graph", "context"] as const;
/** Restricts deps format values accepted by command, SDK, and storage contracts. */
export type DepsFormat = (typeof DEPS_FORMAT_VALUES)[number];
/** Supported values accepted by the deps collapse contract. */
export const DEPS_COLLAPSE_VALUES = ["none", "repeated"] as const;
/** Restricts deps collapse mode values accepted by command, SDK, and storage contracts. */
export type DepsCollapseMode = (typeof DEPS_COLLAPSE_VALUES)[number];
/** Supported values accepted by the deps graph-context direction contract. */
export const DEPS_DIRECTION_VALUES = ["outgoing", "incoming", "both"] as const;
/** Restricts deps traversal-direction values accepted by command, SDK, and storage contracts. */
export type DepsDirection = (typeof DEPS_DIRECTION_VALUES)[number];
const DEFAULT_DEPS_TREE_MAX_DEPTH = 32;
const DEFAULT_DEPS_TREE_NODE_LIMIT = 200;
const DEFAULT_DEPS_TREE_EDGE_LIMIT = 400;
const DEFAULT_DEPS_TREE_TOKEN_BUDGET = 16_000;

/** Documents the deps command options payload exchanged by command, SDK, and package integrations. */
export interface DepsCommandOptions {
  /** Value that configures or reports format for this contract. */
  format?: string;
  /** Value that configures or reports max depth for this contract. */
  maxDepth?: string | number;
  /** Value that configures or reports collapse for this contract. */
  collapse?: string;
  /** Value that configures or reports summary for this contract. */
  summary?: boolean;
  /** Explicitly restore the complete row projection after a summary read. */
  full?: boolean;
  /** Maximum graph-context nodes returned. */
  nodeLimit?: string | number;
  /** Maximum graph-context edges and enumerated missing-reference rows returned. */
  edgeLimit?: string | number;
  /** Maximum estimated graph-context output tokens. */
  tokenBudget?: string | number;
  /** Opaque continuation cursor for graph-context output. */
  cursor?: string;
  /** Graph-context traversal direction relative to each visited node. */
  direction?: string;
  /** Registered relationship kinds narrowing graph-context traversal. */
  kind?: string | string[];
}

interface IndexedItem {
  id: string;
  title: string;
  type: ItemType;
  status: ItemStatus;
  dependencies: IndexedDependency[];
}

interface IndexedDependency {
  id: string;
  kind: string;
}

/** Documents the deps tree node payload exchanged by command, SDK, and package integrations. */
export interface DepsTreeNode {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports title for this contract. */
  title?: string;
  /** Schema type that determines the shape and validation rules for this value. */
  type?: ItemType;
  /** Lifecycle state reported for status. */
  status?: ItemStatus;
  /** Value that configures or reports via for this contract. */
  via?: string;
  /** Value that configures or reports missing for this contract. */
  missing: boolean;
  /** Value that configures or reports cycle for this contract. */
  cycle: boolean;
  /** Value that configures or reports truncated for this contract. */
  truncated?: boolean;
  /** Value that configures or reports collapsed for this contract. */
  collapsed?: boolean;
  /** Value that configures or reports dependencies for this contract. */
  dependencies: DepsTreeNode[];
}

/** Documents the deps graph node payload exchanged by command, SDK, and package integrations. */
export interface DepsGraphNode {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports title for this contract. */
  title?: string;
  /** Schema type that determines the shape and validation rules for this value. */
  type?: ItemType;
  /** Lifecycle state reported for status. */
  status?: ItemStatus;
  /** Value that configures or reports missing for this contract. */
  missing: boolean;
}

/** Documents the deps graph edge payload exchanged by command, SDK, and package integrations. */
export interface DepsGraphEdge {
  /** Value that configures or reports from for this contract. */
  from: string;
  /** Value that configures or reports to for this contract. */
  to: string;
  /** Value that configures or reports kind for this contract. */
  kind: string;
}

/** Documents the deps graph result payload exchanged by command, SDK, and package integrations. */
export interface DepsGraphResult {
  /** Value that configures or reports root id for this contract. */
  root_id: string;
  /** Value that configures or reports nodes for this contract. */
  nodes: DepsGraphNode[];
  /** Value that configures or reports edges for this contract. */
  edges: DepsGraphEdge[];
  /** Value that configures or reports missing ids for this contract. */
  missing_ids: string[];
}

/** Documents the deps result payload exchanged by command, SDK, and package integrations. */
export interface DepsResult {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports format for this contract. */
  format: DepsFormat;
  /** Number of node entries represented by this result. */
  node_count: number;
  /** Number of edge entries represented by this result. */
  edge_count: number;
  /** Counting convention used by edge_count. */
  edge_basis: "deduplicated_directed";
  /** Stored legacy relationship aliases grouped by spelling across the workspace. */
  legacy_alias_counts?: Record<string, number>;
  /**
   * Number of missing entries represented by this result.
   *
   * Tree and graph formats count missing nodes encountered while walking
   * dependency edges; context format counts missing nodes reachable within the
   * same bounded traversal (direction, kinds, and depth) that produced the
   * packet, independent of node or token pagination, so the two formats agree
   * for equal traversal parameters over the dependency edge family.
   */
  missing_count: number;
  /** Traversal scope documenting the missing_count semantics for context format. */
  missing_scope?: "traversal";
  /** Total dangling references declared into the traversed missing nodes. */
  missing_reference_count?: number;
  /** Bounded enumeration of dangling references, capped by the context edge limit. */
  missing_references?: DanglingDependencyReference[];
  /** Explicit bounded-projection metadata when tree or graph rows were omitted. */
  truncation?: {
    /** Stable reasons explaining which bounds stopped expansion. */
    reasons: Array<"max_depth" | "node_limit" | "edge_limit" | "token_budget">;
    /** Effective bounds applied to this projection. */
    limits: {
      max_depth: number;
      node_limit: number;
      edge_limit: number;
      token_budget: number;
    };
    /** Conservative token estimate consumed by emitted tree rows and edges. */
    estimated_tokens: number;
    /** Full unique-node census reachable without projection bounds. */
    total_node_count: number;
    /** Full unique-edge census reachable without projection bounds. */
    total_edge_count: number;
    /** Unique nodes omitted from the returned projection. */
    omitted_node_count: number;
    /** Unique edges omitted from the returned projection. */
    omitted_edge_count: number;
  };
  /** Value that configures or reports tree for this contract. */
  tree?: DepsTreeNode;
  /** Value that configures or reports graph for this contract. */
  graph?: DepsGraphResult;
  /** Explainable bounded graph-context projection. */
  context?: RelationshipContextResult;
  /** Self-describing row projection used to derive a bounded omission receipt. */
  projection: OutputProjectionDeclaration;
}

type UnprojectedDepsResult = Omit<
  DepsResult,
  "projection" | "legacy_alias_counts"
>;

function parseFormat(raw: string | undefined): DepsFormat {
  const candidate = raw?.trim().toLowerCase() ?? "tree";
  if ((DEPS_FORMAT_VALUES as readonly string[]).includes(candidate)) {
    return candidate as DepsFormat;
  }
  throw new PmCliError(
    `Invalid --format value "${raw}". Use "tree", "graph", or "context".`,
    EXIT_CODE.USAGE,
  );
}

/** Parse one positive-integer graph bound, failing fast with the offending flag name. */
export function parsePositiveInteger(
  raw: string | number | undefined,
  flag: string,
): number | undefined {
  if (raw === undefined) return undefined;
  const value = typeof raw === "number" ? raw : Number(raw.trim());
  if (!Number.isInteger(value) || value < 1)
    throw new PmCliError(
      `Invalid --${flag} value "${raw}". Use a positive integer.`,
      EXIT_CODE.USAGE,
    );
  return value;
}

/** Parse the shared non-negative --max-depth traversal bound. */
export function parseMaxDepth(
  raw: string | number | undefined,
): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const normalized = typeof raw === "number" ? raw : Number(raw.trim());
  if (!Number.isInteger(normalized) || normalized < 0) {
    throw new PmCliError(
      `Invalid --max-depth value "${raw}". Use a non-negative integer.`,
      EXIT_CODE.USAGE,
    );
  }
  return normalized;
}

function parseCollapse(raw: string | undefined): DepsCollapseMode {
  const candidate = raw?.trim().toLowerCase() ?? "none";
  if ((DEPS_COLLAPSE_VALUES as readonly string[]).includes(candidate)) {
    return candidate as DepsCollapseMode;
  }
  throw new PmCliError(
    `Invalid --collapse value "${raw}". Use "none" or "repeated".`,
    EXIT_CODE.USAGE,
  );
}

/** Parse the shared graph traversal --direction value, defaulting to "both". */
export function parseDirection(raw: string | undefined): DepsDirection {
  const candidate = raw?.trim().toLowerCase() ?? "both";
  if ((DEPS_DIRECTION_VALUES as readonly string[]).includes(candidate)) {
    return candidate as DepsDirection;
  }
  throw new PmCliError(
    `Invalid --direction value "${raw}". Use "outgoing", "incoming", or "both".`,
    EXIT_CODE.USAGE,
  );
}

/**
 * Normalize repeatable and comma-separated --kind values against one
 * relationship ontology, failing fast on unknown kinds instead of silently
 * matching nothing (the multi-value filter-grammar trap tracked by pm-gknu).
 */
export function parseKinds(
  raw: string | string[] | undefined,
  registry: RelationshipKindRegistry = createRelationshipKindRegistry(),
): string[] | undefined {
  if (raw === undefined) return undefined;
  const values = (Array.isArray(raw) ? raw : [raw])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (values.length === 0) return undefined;
  const kinds = new Set<string>();
  for (const value of values) {
    const definition = registry.resolve(value);
    if (!definition) {
      const known = registry
        .list()
        .map((entry) => entry.kind)
        .join(", ");
      throw new PmCliError(
        `Invalid --kind value "${value}". Registered kinds: ${known}.`,
        EXIT_CODE.USAGE,
      );
    }
    kinds.add(definition.kind);
  }
  return [...kinds].sort();
}

function normalizeDependencies(
  dependencies: Dependency[] | undefined,
): IndexedDependency[] {
  if (!dependencies || dependencies.length === 0) {
    return [];
  }
  const sorted = dependencies
    .map(({ id, kind }) => ({
      id: id.trim(),
      kind: kind.trim().toLowerCase(),
    }))
    .sort((left, right) => {
      const byKind = left.kind.localeCompare(right.kind);
      if (byKind !== 0) return byKind;
      return left.id.localeCompare(right.id);
    });
  const deduped = new Map<string, IndexedDependency>();
  for (const dependency of sorted) {
    const key = `${dependency.kind.toLowerCase()}::${dependency.id.toLowerCase()}`;
    if (!deduped.has(key)) {
      deduped.set(key, { id: dependency.id, kind: dependency.kind });
    }
  }
  return [...deduped.values()];
}

function toIndexedItem(item: ItemMetadata): IndexedItem {
  return {
    id: item.id,
    title: item.title,
    type: item.type,
    status: item.status,
    dependencies: normalizeDependencies(item.dependencies),
  };
}

interface DepsTreeBudget {
  nodeLimit: number;
  edgeLimit: number;
  tokenBudget: number;
  nodes: number;
  edges: number;
  estimatedTokens: number;
  reasons: Set<"max_depth" | "node_limit" | "edge_limit" | "token_budget">;
}

function estimateTreeNodeTokens(node: DepsTreeNode): number {
  return estimatePmOutputTokens(
    new TextEncoder().encode(
      JSON.stringify({ ...node, dependencies: undefined }),
    ).byteLength,
  );
}

function appendTreeDependencies(
  baseNode: DepsTreeNode,
  item: IndexedItem,
  index: Map<string, IndexedItem>,
  nextLineage: Set<string>,
  maxDepth: number | undefined,
  collapse: DepsCollapseMode,
  expanded: Set<string>,
  budget: DepsTreeBudget,
  depth: number,
): void {
  for (const dependency of item.dependencies) {
    const edgeTokens = Math.max(
      1,
      Math.ceil(
        JSON.stringify({
          from: baseNode.id,
          to: dependency.id,
          kind: dependency.kind,
        }).length / 3,
      ),
    );
    if (budget.nodes >= budget.nodeLimit) {
      baseNode.truncated = true;
      budget.reasons.add("node_limit");
      break;
    }
    if (budget.edges >= budget.edgeLimit) {
      baseNode.truncated = true;
      budget.reasons.add("edge_limit");
      break;
    }
    if (budget.estimatedTokens + edgeTokens >= budget.tokenBudget) {
      baseNode.truncated = true;
      budget.reasons.add("token_budget");
      break;
    }
    budget.edges += 1;
    budget.estimatedTokens += edgeTokens;
    baseNode.dependencies.push(
      toTreeNode(
        dependency.id,
        index,
        nextLineage,
        maxDepth,
        collapse,
        expanded,
        budget,
        depth + 1,
        dependency.kind,
      ),
    );
  }
}

function shouldStopTreeNodeExpansion(
  node: DepsTreeNode,
  item: IndexedItem | undefined,
  lookupId: string,
  maxDepth: number | undefined,
  collapse: DepsCollapseMode,
  expanded: Set<string>,
  budget: DepsTreeBudget,
  depth: number,
): boolean {
  if (
    budget.estimatedTokens >= budget.tokenBudget &&
    item?.dependencies.length
  ) {
    node.truncated = true;
    budget.reasons.add("token_budget");
    return true;
  }
  if (!item || node.cycle) {
    return true;
  }
  if (maxDepth !== undefined && depth >= maxDepth) {
    if (item.dependencies.length > 0) {
      node.truncated = true;
      budget.reasons.add("max_depth");
    }
    return true;
  }
  if (collapse === "repeated" && expanded.has(lookupId)) {
    node.collapsed = true;
    return true;
  }
  return false;
}

function toTreeNode(
  id: string,
  index: Map<string, IndexedItem>,
  lineage: Set<string>,
  maxDepth: number | undefined,
  collapse: DepsCollapseMode,
  expanded: Set<string>,
  budget: DepsTreeBudget,
  depth = 0,
  via?: string,
): DepsTreeNode {
  const lookupId = id.trim().toLowerCase();
  const item = index.get(lookupId);
  const baseNode: DepsTreeNode = {
    id: item?.id ?? id,
    title: item?.title,
    type: item?.type,
    status: item?.status,
    via,
    missing: !item,
    cycle: lineage.has(lookupId),
    dependencies: [],
  };
  budget.nodes += 1;
  budget.estimatedTokens += estimateTreeNodeTokens(baseNode);
  if (
    shouldStopTreeNodeExpansion(
      baseNode,
      item,
      lookupId,
      maxDepth,
      collapse,
      expanded,
      budget,
      depth,
    )
  ) {
    return baseNode;
  }
  if (collapse === "repeated") {
    expanded.add(lookupId);
  }
  const nextLineage = new Set(lineage);
  nextLineage.add(lookupId);
  appendTreeDependencies(
    baseNode,
    item!,
    index,
    nextLineage,
    maxDepth,
    collapse,
    expanded,
    budget,
    depth,
  );
  return baseNode;
}

function mergeGraphNode(
  existing: DepsGraphNode | undefined,
  candidate: DepsGraphNode,
): DepsGraphNode {
  if (!existing) {
    return candidate;
  }
  /* c8 ignore start -- defensive: mixed missing/non-missing duplicates only occur in malformed synthetic trees. */
  if (existing.missing && !candidate.missing) return candidate;
  /* c8 ignore stop */
  return {
    ...existing,
    title: existing.title ?? candidate.title,
    type: existing.type ?? candidate.type,
    status: existing.status ?? candidate.status,
  };
}

function toGraph(root: DepsTreeNode): DepsGraphResult {
  const nodesById = new Map<string, DepsGraphNode>();
  const edgesByKey = new Map<string, DepsGraphEdge>();

  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    nodesById.set(
      node.id,
      mergeGraphNode(nodesById.get(node.id), {
        id: node.id,
        title: node.title,
        type: node.type,
        status: node.status,
        missing: node.missing,
      }),
    );
    for (const child of node.dependencies) {
      nodesById.set(
        child.id,
        mergeGraphNode(nodesById.get(child.id), {
          id: child.id,
          title: child.title,
          type: child.type,
          status: child.status,
          missing: child.missing,
        }),
      );
      /* c8 ignore start -- legacy malformed dependency payloads may omit kind/via. */
      const relationKind = child.via ?? "related";
      const edgeKey = `${node.id}::${child.id}::${relationKind}`;
      if (!edgesByKey.has(edgeKey)) {
        edgesByKey.set(edgeKey, {
          from: node.id,
          to: child.id,
          kind: relationKind,
        });
      }
      /* c8 ignore stop */
      if (!child.cycle) {
        pending.push(child);
      }
    }
  }

  const nodes = [...nodesById.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const edges = [...edgesByKey.values()].sort((left, right) => {
    const byFrom = left.from.localeCompare(right.from);
    if (byFrom !== 0) return byFrom;
    const byTo = left.to.localeCompare(right.to);
    if (byTo !== 0) return byTo;
    return left.kind.localeCompare(right.kind);
  });
  const missingIds = nodes
    .filter((node) => node.missing)
    .map((node) => node.id);
  return {
    root_id: root.id,
    nodes,
    edges,
    missing_ids: missingIds,
  };
}

/** Count a dependency result without allocating its potentially exponential tree payload. */
function countDependencyGraph(
  rootId: string,
  index: Map<string, IndexedItem>,
  maxDepth: number | undefined,
): Pick<
  DepsResult,
  "node_count" | "edge_count" | "edge_basis" | "missing_count"
> {
  const nodeIds = new Set<string>();
  const edgeKeys = new Set<string>();
  const missingIds = new Set<string>();
  const expanded = new Set<string>();
  const pending = [{ id: rootId, depth: 0 }];
  let pendingIndex = 0;
  while (pendingIndex < pending.length) {
    const current = pending[pendingIndex++]!;
    const lookupId = current.id.trim().toLowerCase();
    nodeIds.add(lookupId);
    const item = index.get(lookupId);
    if (!item) {
      missingIds.add(lookupId);
      continue;
    }
    if (maxDepth !== undefined && current.depth >= maxDepth) {
      continue;
    }
    if (expanded.has(lookupId)) {
      continue;
    }
    expanded.add(lookupId);
    for (const dependency of item.dependencies) {
      edgeKeys.add(
        `${lookupId}::${dependency.id.trim().toLowerCase()}::${dependency.kind}`,
      );
      pending.push({ id: dependency.id, depth: current.depth + 1 });
    }
  }
  return {
    node_count: nodeIds.size,
    edge_count: edgeKeys.size,
    edge_basis: "deduplicated_directed",
    missing_count: missingIds.size,
  };
}

/** Options subset consumed by the deps graph-context projection. */
type DepsContextOptions = Pick<
  DepsCommandOptions,
  | "maxDepth"
  | "nodeLimit"
  | "edgeLimit"
  | "tokenBudget"
  | "cursor"
  | "direction"
  | "kind"
>;

/** Parse CLI-compatible deps context options once for packet and closure parity. */
function parseDepsContextOptions(
  options: DepsContextOptions,
  registry: RelationshipKindRegistry = createRelationshipKindRegistry(),
): RelationshipContextOptions {
  const maxDepth = parseMaxDepth(options.maxDepth);
  const nodeLimit = parsePositiveInteger(options.nodeLimit, "node-limit");
  const edgeLimit = parsePositiveInteger(options.edgeLimit, "edge-limit");
  const tokenBudget = parsePositiveInteger(options.tokenBudget, "token-budget");
  const kinds = parseKinds(options.kind, registry);
  return {
    direction: parseDirection(options.direction),
    ...(kinds === undefined ? {} : { kinds }),
    ...(maxDepth === undefined ? {} : { maxDepth }),
    ...(nodeLimit === undefined ? {} : { nodeLimit }),
    ...(edgeLimit === undefined ? {} : { edgeLimit }),
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
    ...(options.cursor?.trim() ? { cursor: options.cursor.trim() } : {}),
  };
}

/** Build one bounded context packet from an assembled deps relationship graph. */
function buildContextFromAssembly(
  assembly: WorkspaceRelationshipAssembly,
  rootId: string,
  options: RelationshipContextOptions,
  rootEvidence: readonly string[],
): RelationshipContextResult {
  return buildRelationshipContext(
    assembly.graph,
    rootId,
    assembly.details.map((detail) =>
      detail.id === rootId && rootEvidence.length > 0
        ? { ...detail, evidence: rootEvidence }
        : detail,
    ),
    options,
  );
}

/** Build the SDK-backed bounded relationship-context projection for deps. */
export function buildDepsRelationshipContext(
  rootId: string,
  items: readonly ItemMetadata[],
  options: DepsContextOptions,
  rootEvidence: readonly string[] = [],
): RelationshipContextResult {
  const assembly = assembleWorkspaceRelationshipGraph(items);
  return buildContextFromAssembly(
    assembly,
    rootId,
    parseDepsContextOptions(options, assembly.graph.registry()),
    rootEvidence,
  );
}

/** Append up to `limit` labeled pointers from one linked collection. */
function appendEvidencePointers(
  evidence: string[],
  label: string,
  values: readonly (string | undefined)[],
  limit: number,
): void {
  for (const value of values.slice(0, limit)) {
    const trimmed = value?.trim();
    if (trimmed) evidence.push(`${label}:${trimmed}`);
  }
}

/**
 * Load bounded root evidence pointers (linked files, tests, docs, and
 * annotation counts) so the context packet answers "where is the proof"
 * without a follow-up item read.
 */
async function collectRootEvidence(
  pmRoot: string,
  id: string,
  settings: Awaited<ReturnType<typeof readSettings>>,
  typeToFolder: Record<string, string>,
): Promise<string[]> {
  const located = await locateItem(
    pmRoot,
    id,
    settings.id_prefix,
    settings.item_format,
    typeToFolder,
  );
  // The caller already resolved the root against the light index, so a miss
  // can only happen when storage mutates mid-read; degrade to no evidence.
  /* c8 ignore start -- defensive: unreachable without a concurrent delete between the index scan and this read. */
  if (!located) return [];
  /* c8 ignore stop */
  const { document } = await readLocatedItem(located, {
    schema: settings.schema,
  });
  const metadata = document.metadata;
  const files = metadata.files ?? [];
  const tests = metadata.tests ?? [];
  const docs = metadata.docs ?? [];
  const counts = [
    ["files", files.length],
    ["tests", tests.length],
    ["docs", docs.length],
    ["comments", (metadata.comments ?? []).length],
    ["notes", (metadata.notes ?? []).length],
    ["learnings", (metadata.learnings ?? []).length],
  ] as const;
  if (counts.every(([, count]) => count === 0)) return [];
  const evidence = [
    `linked:${counts.map(([key, count]) => `${key}=${count}`).join(",")}`,
  ];
  appendEvidencePointers(
    evidence,
    "file",
    files.map((file) => file.path),
    3,
  );
  appendEvidencePointers(
    evidence,
    "test",
    tests.map((test) => test.command ?? test.path),
    2,
  );
  appendEvidencePointers(
    evidence,
    "doc",
    docs.map((doc) => doc.path),
    2,
  );
  return evidence;
}

function createContextDepsResult(params: {
  canonicalId: string;
  context: RelationshipContextResult;
  missingCount: number;
  missingReferences: DanglingDependencyReference[];
  referenceLimit: number;
  summaryOnly: boolean;
}): UnprojectedDepsResult {
  const {
    canonicalId,
    context,
    missingCount,
    missingReferences,
    referenceLimit,
    summaryOnly,
  } = params;
  return {
    id: canonicalId,
    format: "context",
    node_count: context.nodes.length + 1,
    edge_count: context.edges.length,
    edge_basis: "deduplicated_directed",
    missing_count: missingCount,
    missing_scope: "traversal",
    missing_reference_count: missingReferences.length,
    ...(summaryOnly
      ? {}
      : {
          missing_references: missingReferences.slice(0, referenceLimit),
          context,
        }),
  };
}

function includesContextMissingReference(params: {
  row: DanglingDependencyReference;
  missingReachableSet: ReadonlySet<string>;
  packetIds: ReadonlySet<string>;
  filteredKinds: ReadonlySet<string> | undefined;
  registry: RelationshipKindRegistry;
}): boolean {
  const { row, missingReachableSet, packetIds, filteredKinds, registry } =
    params;
  if (
    row.no_active_blocker_sentinel ||
    !missingReachableSet.has(row.target_id.trim().toLowerCase()) ||
    !packetIds.has(row.holder_id)
  ) {
    return false;
  }
  if (filteredKinds === undefined) return true;
  const definition = registry.resolve(row.kind);
  return (
    definition !== undefined &&
    (filteredKinds.has(definition.kind) ||
      (definition.inverse !== undefined &&
        filteredKinds.has(definition.inverse)))
  );
}

/** Complete built-in transport policy, including metadata attached after graph packing. */
interface DepsRenderingOptions {
  format: "json" | "toon";
  global: GlobalOptions;
  commandOptions: DepsCommandOptions;
  legacyAliasCounts: Record<string, number>;
  commandOptionsOverride?: Record<string, unknown>;
}

/** Use the same read-contract disclosure and pure renderer as the final host delivery. */
function discloseDepsOutput(
  result: DepsResult,
  rendering: DepsRenderingOptions,
): unknown {
  const activeCommand = getActiveCommandContext();
  const commandOptions =
    rendering.commandOptionsOverride ??
    (activeCommand?.command === "deps"
      ? activeCommand.options
      : rendering.commandOptions);
  return attachReadOutputContracts(
    "deps",
    {
      ...commandOptions,
      ...rendering.global,
      resolvedOutputFormat: rendering.format,
    },
    result,
  );
}

/** Render the complete built-in transport, including optional accounting metadata. */
function renderDepsOutput(
  result: DepsResult,
  rendering: DepsRenderingOptions,
): string {
  const disclosed = discloseDepsOutput(result, rendering);
  const render = (value: unknown): string =>
    formatBuiltInOutput(
      value,
      rendering.format,
      rendering.global.lean === true,
    );
  return render(
    rendering.global.tokenAccounting === true
      ? attachOutputTokenAccounting(disclosed, render)
      : disclosed,
  );
}

/** Settle embedded token-count digit width against the exact built-in delivery representation. */
function settleRenderedTokenCount(
  result: DepsResult,
  rendering: DepsRenderingOptions,
  assign: (tokens: number) => void,
): number {
  let embeddedTokens: number | undefined;
  for (;;) {
    const measuredTokens = estimatePmOutputTokens(
      new TextEncoder().encode(renderDepsOutput(result, rendering)).byteLength,
    );
    if (measuredTokens === embeddedTokens) return measuredTokens;
    assign(measuredTokens);
    embeddedTokens = measuredTokens;
  }
}

/** Identify the context packer's controlled signal that no smaller packet fits. */
function isContextBudgetFloorError(error: unknown): error is TypeError {
  return (
    error instanceof TypeError &&
    error.message.startsWith("Relationship context tokenBudget cannot fit ")
  );
}

interface DepsContextBudgetParameters {
  pmRoot: string;
  assembly: WorkspaceRelationshipAssembly;
  canonicalId: string;
  contextOptions: RelationshipContextOptions;
  rootEvidence: readonly string[];
  summaryOnly: boolean;
  rendering: DepsRenderingOptions;
  missingCount: number;
  missingReferences: DanglingDependencyReference[];
}

/** Pack within the rendered ceiling, preserving the structural floor as a controlled signal. */
function enforceContextRenderedTokenBudget(
  params: DepsContextBudgetParameters,
): UnprojectedDepsResult {
  const {
    assembly,
    canonicalId,
    contextOptions,
    rootEvidence,
    summaryOnly,
    rendering,
    missingCount,
    missingReferences,
  } = params;
  const referenceLimit = contextOptions.edgeLimit ?? 40;
  let emittedReferenceLimit = Math.min(
    referenceLimit,
    missingReferences.length,
  );
  let internalTokenBudget = contextOptions.tokenBudget;
  let requestedTokenBudget: number | undefined;
  for (;;) {
    const context = buildContextFromAssembly(
      assembly,
      canonicalId,
      {
        ...contextOptions,
        ...(internalTokenBudget === undefined
          ? {}
          : { tokenBudget: internalTokenBudget }),
      },
      rootEvidence,
    );
    requestedTokenBudget ??= context.meta.tokenBudget;
    internalTokenBudget ??= requestedTokenBudget;
    const result = createContextDepsResult({
      canonicalId,
      context,
      missingCount,
      missingReferences,
      referenceLimit: emittedReferenceLimit,
      summaryOnly,
    });
    if (summaryOnly) {
      const tokens = estimatePmOutputTokens(
        new TextEncoder().encode(
          renderDepsOutput(
            attachDepsProjection(result, true, rendering.legacyAliasCounts),
            rendering,
          ),
        ).byteLength,
      );
      if (tokens > requestedTokenBudget)
        throw new TypeError(
          "Relationship context tokenBudget cannot fit the rendered summary",
        );
      return result;
    }
    context.meta.tokenBudget = requestedTokenBudget;
    context.meta.usedTokens = settleRenderedTokenCount(
      attachDepsProjection(result, false, rendering.legacyAliasCounts),
      rendering,
      (tokens) => {
        context.meta.usedTokens = tokens;
      },
    );
    if (context.meta.usedTokens <= requestedTokenBudget) return result;
    if (emittedReferenceLimit > 0) {
      emittedReferenceLimit -= 1;
      continue;
    }
    const currentInternalBudget = internalTokenBudget;
    const scaledInternalBudget =
      (currentInternalBudget * requestedTokenBudget) / context.meta.usedTokens;
    internalTokenBudget = Math.min(
      currentInternalBudget - 1,
      Math.max(1, Math.floor(scaledInternalBudget * 0.9)),
    );
  }
}

/** Executable retry arguments and the exact output policy used to verify them. */
interface ContextRetryPlan {
  args: string[];
  budgetIndex: number;
  /** Native projection after canonical include modes have been consumed. */
  summaryOnly: boolean;
  rendering: DepsRenderingOptions;
}

/** Preserve retry scope and output policy, consuming canonical include modes before verification. */
function createContextRetryPlan(
  params: DepsContextBudgetParameters,
  budget: number,
): ContextRetryPlan {
  const options = params.contextOptions;
  const global = {
    ...params.rendering.global,
    outputFormat: params.rendering.format,
  };
  const args = [
    "--pm-path",
    params.pmRoot,
    "item",
    "deps",
    params.canonicalId,
    "--format",
    "context",
    "--output-format",
    params.rendering.format,
    "--token-budget",
  ];
  const budgetIndex = args.length;
  args.push(String(budget));
  const provided = new Set([
    "--pm-path",
    "--format",
    "--output-format",
    "--token-budget",
  ]);
  const commandOptions: Record<string, unknown> = {
    format: "context",
    tokenBudget: budget,
    kind: options.kinds,
  };
  const values: Array<[string, string, unknown]> = [
    ["--max-depth", "maxDepth", options.maxDepth],
    ["--node-limit", "nodeLimit", options.nodeLimit],
    ["--edge-limit", "edgeLimit", options.edgeLimit],
    ["--direction", "direction", options.direction],
    ["--cursor", "cursor", options.cursor],
    ["--output-include", "outputInclude", global.outputInclude],
    ["--output-limit", "outputLimit", global.outputLimit],
    ["--output-budget", "outputBudget", global.outputBudget],
    ["--output-session", "outputSession", global.outputSession],
    ["--output-cursor", "outputCursor", global.outputCursor],
  ];
  for (const [flag, key, value] of values) {
    if (value === undefined) continue;
    args.push(flag, String(value));
    provided.add(flag);
    commandOptions[key] = value;
  }
  for (const kind of options.kinds ?? []) {
    args.push("--kind", kind);
    provided.add("--kind");
  }
  const booleans: Array<[string, string, boolean | undefined]> = [
    ["--summary", "summary", params.summaryOnly],
    ["--full", "full", params.rendering.commandOptions.full],
    ["--json", "json", global.json],
    ["--lean", "lean", global.lean],
    ["--output-row-contract", "outputRowContract", global.outputRowContract],
    ["--token-accounting", "tokenAccounting", global.tokenAccounting],
    ["--no-extensions", "noExtensions", global.noExtensions],
    ["--no-pager", "noPager", global.noPager],
  ];
  for (const [flag, key, enabled] of booleans) {
    if (enabled !== true) continue;
    args.push(flag);
    provided.add(flag);
    commandOptions[key] = true;
  }
  const contract = PM_READ_OUTPUT_SURFACE_CONTRACTS.find(
    (candidate) => candidate.command === "deps",
  )!;
  Reflect.set(commandOptions, READ_OUTPUT_INVOCATION_PROVENANCE, {
    canonical_include_modes: [],
    cli_invocation_observed: true,
    explicit_legacy_aliases: Object.values(contract.dimensions).flatMap(
      (dimension) =>
        dimension.legacy_aliases.flatMap((alias) =>
          provided.has(alias.flag) ? [alias.flag] : [],
        ),
    ),
  });
  normalizeReadOutputIncludeModeOptions("deps", commandOptions);
  assertProjectionModeChoice(
    commandOptions.summary === true,
    commandOptions.full === true,
    "--summary",
  );
  global.outputInclude = commandOptions.outputInclude as string | undefined;
  return {
    args,
    budgetIndex,
    summaryOnly: commandOptions.summary === true,
    rendering: {
      ...params.rendering,
      global,
      commandOptionsOverride: commandOptions,
    },
  };
}

/** Probe the real packer without recursively constructing another refusal or hiding unrelated failures. */
function probeContextRetry(
  params: DepsContextBudgetParameters,
  plan: ContextRetryPlan,
  budget: number,
): ContextBudgetProbe {
  const rendering = {
    ...plan.rendering,
    commandOptionsOverride: {
      ...plan.rendering.commandOptionsOverride,
      tokenBudget: budget,
    },
  };
  let result: UnprojectedDepsResult;
  try {
    result = enforceContextRenderedTokenBudget({
      ...params,
      contextOptions: { ...params.contextOptions, tokenBudget: budget },
      summaryOnly: plan.summaryOnly,
      rootEvidence: plan.summaryOnly ? [] : params.rootEvidence,
      rendering,
    });
  } catch (error) {
    if (!isContextBudgetFloorError(error)) throw error;
    return "native_floor";
  }
  const disclosed = discloseDepsOutput(
    attachDepsProjection(result, plan.summaryOnly, rendering.legacyAliasCounts),
    rendering,
  );
  return isReadOutputBudgetExceeded(disclosed) ? "output_constraints" : "fits";
}

/** Compute bounded, honest budget advice and retain a separate compact inspection option. */
async function createContextBudgetRefusal(
  params: DepsContextBudgetParameters,
  cause: TypeError,
): Promise<PmCliExpectedError> {
  const requested =
    params.contextOptions.tokenBudget ??
    DEFAULT_RELATIONSHIP_CONTEXT_TOKEN_BUDGET;
  const plan = createContextRetryPlan(params, requested);
  const referencePasses = plan.summaryOnly
    ? 1
    : 1 +
      Math.min(
        params.contextOptions.edgeLimit ?? 40,
        params.missingReferences.length,
      );
  const workUnits =
    referencePasses *
    (params.assembly.details.reduce(
      (sum, node) =>
        sum +
        node.id.length +
        node.title.length +
        node.status.length +
        (node.type?.length ?? 0),
      params.assembly.graph.edges().length + params.missingReferences.length,
    ) +
      (plan.summaryOnly ? [] : params.rootEvidence).reduce(
        (sum, pointer) => sum + pointer.length,
        0,
      ));
  const { findContextBudgetRecovery } =
    await import("./dependencies/context-budget-recovery.js");
  const bounds = findContextBudgetRecovery({
    requested,
    initialBudget: DEFAULT_RELATIONSHIP_CONTEXT_TOKEN_BUDGET,
    workUnits,
    probe: (budget) => probeContextRetry(params, plan, budget),
  });
  const inspectionArgs = [
    "--pm-path",
    params.pmRoot,
    "item",
    "deps",
    params.canonicalId,
    "--format",
    "tree",
    "--summary",
  ];
  const inspection = renderPmCommand(inspectionArgs);
  const retryArgs =
    bounds.feasible_tokens === null ? inspectionArgs : [...plan.args];
  if (bounds.feasible_tokens !== null)
    retryArgs[plan.budgetIndex] = String(bounds.feasible_tokens);
  const retry = renderPmCommand(retryArgs);
  return createPmCliExpectedError(
    "Relationship context tokenBudget cannot fit the required rendered packet",
    {
      exitCode: EXIT_CODE.USAGE,
      cause,
      context: {
        code: "invalid_argument_value",
        field: "tokenBudget",
        value: String(requested),
        required:
          bounds.feasible_tokens === null
            ? "Inspect the compact summary and review the output constraints."
            : "Retry the preserved context query with --token-budget " +
              bounds.feasible_tokens +
              ".",
        why: "Budget advice is verified against the current query. A minimum is reported only after every smaller positive budget is checked.",
        examples: [retry, inspection],
        nextSteps: [retry],
        recovery: {
          recovery_mode: "compact",
          suggested_flags: ["--token-budget"],
          token_budget: bounds,
          suggested_retry_args: retryArgs,
          suggested_retry: retry,
          next_best_command: inspection,
          fallback_candidates: [
            {
              source: "relationship_summary",
              command: inspection,
              reason: "Inspect bounded counts separately from context rows.",
            },
          ],
        },
      },
    },
  );
}

/** Assemble the context-format deps result with traversal-scoped missing enumeration. */
async function buildContextDepsResult(params: {
  pmRoot: string;
  assembly: WorkspaceRelationshipAssembly;
  canonicalId: string;
  options: DepsCommandOptions;
  rootEvidence: readonly string[];
  summaryOnly: boolean;
  rendering: DepsRenderingOptions;
}): Promise<UnprojectedDepsResult> {
  const {
    pmRoot,
    assembly,
    canonicalId,
    options,
    rootEvidence,
    summaryOnly,
    rendering,
  } = params;
  const contextOptions = parseDepsContextOptions(
    options,
    assembly.graph.registry(),
  );
  const reachable = assembly.graph.closure(canonicalId, {
    direction: contextOptions.direction,
    ...(contextOptions.kinds === undefined
      ? {}
      : { kinds: contextOptions.kinds }),
    maxDepth: contextOptions.maxDepth ?? 3,
  });
  const missingReachable = reachable.value.filter((nodeId) =>
    assembly.missingIdSet.has(nodeId.toLowerCase()),
  );
  const missingReachableSet = new Set(
    missingReachable.map((nodeId) => nodeId.toLowerCase()),
  );
  const relationshipRegistry = assembly.graph.registry();
  const filteredKinds = contextOptions.kinds
    ? new Set(
        contextOptions.kinds.map(
          (kind) => relationshipRegistry.require(kind).kind,
        ),
      )
    : undefined;
  const packetIds = new Set([canonicalId, ...reachable.value]);
  const missingReferences = [
    ...assembly.dangling.active,
    ...assembly.dangling.legacy_terminal,
  ].filter((row) =>
    includesContextMissingReference({
      row,
      missingReachableSet,
      packetIds,
      filteredKinds,
      registry: relationshipRegistry,
    }),
  );
  const budgetParams: DepsContextBudgetParameters = {
    pmRoot,
    assembly,
    canonicalId,
    contextOptions,
    rootEvidence,
    summaryOnly,
    rendering,
    missingCount: missingReachable.length,
    missingReferences,
  };
  try {
    return enforceContextRenderedTokenBudget(budgetParams);
  } catch (error) {
    if (error instanceof PmCliError && error.code === "invalid_query_cursor") {
      const plan = createContextRetryPlan({
        ...budgetParams,
        contextOptions: { ...contextOptions, cursor: undefined },
        rendering: { ...rendering, global: { ...rendering.global, outputCursor: undefined } },
      }, contextOptions.tokenBudget ?? DEFAULT_RELATIONSHIP_CONTEXT_TOKEN_BUDGET);
      const retry = renderPmCommand(plan.args);
      throw new PmCliError(error.message, error.exitCode, {
        ...error.context,
        // Shared pagination refusals always supply their producer's guidance.
        nextSteps: [...error.context.nextSteps!, retry],
        recovery: { suggested_retry: retry, suggested_retry_args: plan.args },
      });
    }
    if (!isContextBudgetFloorError(error)) throw error;
    throw await createContextBudgetRefusal(budgetParams, error);
  }
}

function trimDeepestDependency(tree: DepsTreeNode): boolean {
  const pending = [tree];
  let parentToTrim: DepsTreeNode | undefined;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.dependencies.length > 0) {
      parentToTrim = current;
      pending.push(...current.dependencies);
    }
  }
  if (!parentToTrim) return false;
  parentToTrim.dependencies.pop();
  parentToTrim.truncated = true;
  return true;
}

/** Settle emitted tree/graph accounting while trimming the deepest dependency rows first. */
function buildTreeOrGraphDepsResult(
  id: string,
  format: Exclude<DepsFormat, "context">,
  options: DepsCommandOptions,
  index: Map<string, IndexedItem>,
  maxDepth: number | undefined,
  collapse: DepsCollapseMode,
  rendering: DepsRenderingOptions,
): UnprojectedDepsResult {
  const effectiveMaxDepth = maxDepth ?? DEFAULT_DEPS_TREE_MAX_DEPTH;
  const nodeLimit =
    parsePositiveInteger(options.nodeLimit, "node-limit") ??
    DEFAULT_DEPS_TREE_NODE_LIMIT;
  const edgeLimit =
    parsePositiveInteger(options.edgeLimit, "edge-limit") ??
    DEFAULT_DEPS_TREE_EDGE_LIMIT;
  const tokenBudget =
    parsePositiveInteger(options.tokenBudget, "token-budget") ??
    DEFAULT_DEPS_TREE_TOKEN_BUDGET;
  const budget: DepsTreeBudget = {
    nodeLimit,
    edgeLimit,
    tokenBudget,
    nodes: 0,
    edges: 0,
    estimatedTokens: 0,
    reasons: new Set(),
  };
  const tree = toTreeNode(
    id,
    index,
    new Set<string>(),
    effectiveMaxDepth,
    format === "graph" ? "repeated" : collapse,
    new Set<string>(),
    budget,
  );
  const totals = countDependencyGraph(id, index, undefined);
  let result: UnprojectedDepsResult;
  for (;;) {
    const graph = toGraph(tree);
    const truncation =
      budget.reasons.size === 0
        ? undefined
        : {
            reasons: [...budget.reasons].sort(),
            limits: {
              max_depth: effectiveMaxDepth,
              node_limit: nodeLimit,
              edge_limit: edgeLimit,
              token_budget: tokenBudget,
            },
            estimated_tokens: 0,
            total_node_count: totals.node_count,
            total_edge_count: totals.edge_count,
            omitted_node_count: Math.max(
              0,
              totals.node_count - graph.nodes.length,
            ),
            omitted_edge_count: Math.max(
              0,
              totals.edge_count - graph.edges.length,
            ),
          };
    const baseResult = {
      id,
      format,
      node_count: graph.nodes.length,
      edge_count: graph.edges.length,
      edge_basis: "deduplicated_directed" as const,
      missing_count: graph.missing_ids.length,
      ...(truncation ? { truncation } : {}),
    };
    result =
      format === "tree" ? { ...baseResult, tree } : { ...baseResult, graph };
    const settledTokens =
      result.truncation === undefined
        ? estimatePmOutputTokens(
            new TextEncoder().encode(
              renderDepsOutput(
                attachDepsProjection(
                  result,
                  false,
                  rendering.legacyAliasCounts,
                ),
                rendering,
              ),
            ).byteLength,
          )
        : settleRenderedTokenCount(
            attachDepsProjection(result, false, rendering.legacyAliasCounts),
            rendering,
            (tokens) => {
              result.truncation!.estimated_tokens = tokens;
            },
          );
    if (settledTokens <= tokenBudget) {
      return result;
    }
    if (!trimDeepestDependency(tree)) {
      budget.reasons.add("token_budget");
      return result;
    }
    budget.reasons.add("token_budget");
  }
}

function attachDepsProjection(
  result: UnprojectedDepsResult,
  summaryOnly: boolean,
  legacyAliasCounts: Record<string, number> = {},
): DepsResult {
  const group = {
    name:
      result.format === "tree"
        ? "dependency_tree"
        : result.format === "graph"
          ? "dependency_graph"
          : "relationship_context",
    restore_with: "--full",
  };
  const boundedGroups = result.context?.meta.truncated
    ? [{
        name: "relationship_context_bounds",
        restore_with: "--token-budget <n> --node-limit <n> --edge-limit <n> --max-depth <n>",
      }]
    : [];
  return {
    ...result,
    legacy_alias_counts: legacyAliasCounts,
    projection: {
      mode: summaryOnly ? "summary" : "full",
      declared_field_groups: [group, ...boundedGroups],
      included_field_groups: summaryOnly ? [] : [group.name],
    },
  };
}

/** Implements run deps for the public runtime surface of this module. */
export async function runDeps(
  id: string,
  options: DepsCommandOptions,
  global: GlobalOptions,
): Promise<DepsResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  await assertInitializedTracker(pmRoot);
  const format = parseFormat(options.format);
  const maxDepth = parseMaxDepth(options.maxDepth);
  const collapse = parseCollapse(options.collapse);
  assertProjectionModeChoice(
    options.summary === true,
    options.full === true,
    "--summary",
  );
  const summaryOnly = options.summary === true;
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
  const index = new Map(
    items.map((item) => [item.id.trim().toLowerCase(), toIndexedItem(item)]),
  );
  const dangling = collectDanglingDependencyReferences(items, (status) =>
    isTerminalStatus(status, statusRegistry),
  );
  for (const reference of [...dangling.active, ...dangling.legacy_terminal]) {
    const holder = index.get(reference.holder_id.trim().toLowerCase());
    const referenceKind = reference.kind.trim().toLowerCase();
    if (
      holder &&
      !holder.dependencies.some(
        (dependency) =>
          dependency.id.trim().toLowerCase() ===
            reference.target_id.trim().toLowerCase() &&
          dependency.kind === referenceKind,
      )
    ) {
      holder.dependencies.push({
        id: reference.target_id,
        kind: referenceKind,
      });
    }
  }
  if (!index.has(id.trim().toLowerCase())) {
    throw new PmCliError(`Item ${id} not found`, EXIT_CODE.NOT_FOUND);
  }

  const outputFormat =
    global.outputFormat ??
    (global.json === true ||
    (global.json === undefined && global.defaultOutputFormat === "json")
      ? "json"
      : "toon");
  if (format === "context") {
    const canonicalId = index.get(id.trim().toLowerCase())!.id;
    const rootEvidence = summaryOnly
      ? []
      : await collectRootEvidence(
          pmRoot,
          canonicalId,
          settings,
          typeRegistry.type_to_folder,
        );
    const isTerminal = (status: ItemStatus): boolean =>
      isTerminalStatus(status, statusRegistry);
    const relationshipRegistry = resolveWorkspaceRelationshipKindRegistry();
    // Reuse the fingerprint-keyed shared cache so bounded context packets in
    // long-lived hosts stop paying full-workspace assembly on every call.
    const lookup = workspaceGraphCache().lookup(
      pmRoot,
      computeWorkspaceGraphFingerprint(items, isTerminal, relationshipRegistry),
      () =>
        assembleWorkspaceRelationshipGraph(
          items,
          isTerminal,
          relationshipRegistry,
        ),
    );
    return attachDepsProjection(
      await buildContextDepsResult({
        pmRoot,
        assembly: lookup.assembly,
        canonicalId,
        options,
        rootEvidence,
        summaryOnly,
        rendering: {
          format: outputFormat,
          global,
          commandOptions: options,
          legacyAliasCounts: lookup.assembly.legacyAliasCounts,
        },
      }),
      summaryOnly,
      lookup.assembly.legacyAliasCounts,
    );
  }

  const legacyAliasCounts = Object.fromEntries(
    Object.entries(
      assembleWorkspaceRelationshipGraph(items, (status) =>
        isTerminalStatus(status, statusRegistry),
      ).legacyAliasCounts,
    ),
  );
  if (summaryOnly) {
    return attachDepsProjection(
      {
        id,
        format,
        ...countDependencyGraph(id, index, maxDepth),
      },
      true,
      legacyAliasCounts,
    );
  }

  return attachDepsProjection(
    buildTreeOrGraphDepsResult(id, format, options, index, maxDepth, collapse, {
      format: outputFormat,
      global,
      commandOptions: options,
      legacyAliasCounts,
    }),
    false,
    legacyAliasCounts,
  );
}
