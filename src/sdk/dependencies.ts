/**
 * @module sdk/dependencies
 *
 * Implements the pm deps command surface and its agent-facing runtime behavior.
 */
import { getActiveExtensionRegistrations } from "../core/extensions/index.js";
import { pathExists } from "../core/fs/fs-utils.js";
import { resolveItemTypeRegistry } from "../core/item/type-registry.js";
import { isTerminalStatus } from "../core/item/status.js";
import { resolveRuntimeStatusRegistry } from "../core/schema/runtime-schema.js";
import { EXIT_CODE } from "../core/shared/constants.js";
import type { GlobalOptions } from "../core/shared/command-types.js";
import { PmCliError } from "../core/shared/errors.js";
import {
  listAllItemMetadataLight,
  locateItem,
  readLocatedItem,
} from "../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../core/store/paths.js";
import { readSettings } from "../core/store/settings.js";
import type {
  Dependency,
  ItemMetadata,
  ItemStatus,
  ItemType,
} from "../types/index.js";
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
  type RelationshipContextOptions,
  type RelationshipContextResult,
} from "./relationship-context.js";
import { createRelationshipKindRegistry } from "./relationships.js";

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
  /** Value that configures or reports tree for this contract. */
  tree?: DepsTreeNode;
  /** Value that configures or reports graph for this contract. */
  graph?: DepsGraphResult;
  /** Explainable bounded graph-context projection. */
  context?: RelationshipContextResult;
}

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
export function parsePositiveInteger(raw: string | number | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = typeof raw === "number" ? raw : Number(raw.trim());
  if (!Number.isInteger(value) || value < 1)
    throw new PmCliError(`Invalid --${flag} value "${raw}". Use a positive integer.`, EXIT_CODE.USAGE);
  return value;
}

/** Parse the shared non-negative --max-depth traversal bound. */
export function parseMaxDepth(raw: string | number | undefined): number | undefined {
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
 * Normalize repeatable and comma-separated --kind values against the built-in
 * relationship ontology, failing fast on unknown kinds instead of silently
 * matching nothing (the multi-value filter-grammar trap tracked by pm-gknu).
 */
export function parseKinds(raw: string | string[] | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const registry = createRelationshipKindRegistry();
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
  const sorted = dependencies.map(({ id, kind }) => ({
    id: id.trim(),
    kind: kind.trim().toLowerCase(),
  })).sort((left, right) => {
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

function toTreeNode(
  id: string,
  index: Map<string, IndexedItem>,
  lineage: Set<string>,
  maxDepth: number | undefined,
  collapse: DepsCollapseMode,
  expanded: Set<string>,
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
  if (!item || baseNode.cycle) {
    return baseNode;
  }
  if (maxDepth !== undefined && depth >= maxDepth) {
    if (item.dependencies.length > 0) {
      baseNode.truncated = true;
    }
    return baseNode;
  }
  if (collapse === "repeated" && expanded.has(lookupId)) {
    baseNode.collapsed = true;
    return baseNode;
  }
  if (collapse === "repeated") {
    expanded.add(lookupId);
  }
  const nextLineage = new Set(lineage);
  nextLineage.add(lookupId);
  baseNode.dependencies = item.dependencies.map((dependency) =>
    toTreeNode(
      dependency.id,
      index,
      nextLineage,
      maxDepth,
      collapse,
      expanded,
      depth + 1,
      dependency.kind,
    ),
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

  const visit = (node: DepsTreeNode): void => {
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
        visit(child);
      }
    }
  };

  visit(root);

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
): Pick<DepsResult, "node_count" | "edge_count" | "missing_count"> {
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
): RelationshipContextOptions {
  const maxDepth = parseMaxDepth(options.maxDepth);
  const nodeLimit = parsePositiveInteger(options.nodeLimit, "node-limit");
  const edgeLimit = parsePositiveInteger(options.edgeLimit, "edge-limit");
  const tokenBudget = parsePositiveInteger(options.tokenBudget, "token-budget");
  const kinds = parseKinds(options.kind);
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
  return buildContextFromAssembly(
    assembleWorkspaceRelationshipGraph(items),
    rootId,
    parseDepsContextOptions(options),
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
  appendEvidencePointers(evidence, "file", files.map((file) => file.path), 3);
  appendEvidencePointers(
    evidence,
    "test",
    tests.map((test) => test.command ?? test.path),
    2,
  );
  appendEvidencePointers(evidence, "doc", docs.map((doc) => doc.path), 2);
  return evidence;
}

/** Assemble the context-format deps result with traversal-scoped missing enumeration. */
function buildContextDepsResult(params: {
  assembly: WorkspaceRelationshipAssembly;
  canonicalId: string;
  options: DepsCommandOptions;
  rootEvidence: readonly string[];
  summaryOnly: boolean;
}): DepsResult {
  const { assembly, canonicalId, options, rootEvidence, summaryOnly } = params;
  const contextOptions = parseDepsContextOptions(options);
  const context = buildContextFromAssembly(
    assembly,
    canonicalId,
    contextOptions,
    rootEvidence,
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
  ].filter((row) => {
    if (
      row.no_active_blocker_sentinel ||
      !missingReachableSet.has(row.target_id.trim().toLowerCase()) ||
      !packetIds.has(row.holder_id)
    )
      return false;
    if (filteredKinds === undefined) return true;
    const definition = relationshipRegistry.resolve(row.kind);
    return (
      definition !== undefined &&
      (filteredKinds.has(definition.kind) ||
        (definition.inverse !== undefined &&
          filteredKinds.has(definition.inverse)))
    );
  });
  const referenceLimit = contextOptions.edgeLimit ?? 40;
  return {
    id: canonicalId,
    format: "context",
    node_count: context.nodes.length + 1,
    edge_count: context.edges.length,
    missing_count: missingReachable.length,
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

/** Implements run deps for the public runtime surface of this module. */
export async function runDeps(
  id: string,
  options: DepsCommandOptions,
  global: GlobalOptions,
): Promise<DepsResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(
      `Tracker is not initialized at ${pmRoot}. Run pm init first.`,
      EXIT_CODE.NOT_FOUND,
    );
  }
  const format = parseFormat(options.format);
  const maxDepth = parseMaxDepth(options.maxDepth);
  const collapse = parseCollapse(options.collapse);
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
  const dangling = collectDanglingDependencyReferences(
    items,
    (status) => isTerminalStatus(status, statusRegistry),
  );
  for (const reference of [...dangling.active, ...dangling.legacy_terminal]) {
    const holder = index.get(reference.holder_id.trim().toLowerCase());
    const referenceKind = reference.kind.trim().toLowerCase();
    if (
      holder &&
      !holder.dependencies.some(
        (dependency) =>
          dependency.id.trim().toLowerCase() === reference.target_id.trim().toLowerCase() &&
          dependency.kind === referenceKind,
      )
    ) {
      holder.dependencies.push({ id: reference.target_id, kind: referenceKind });
    }
  }
  if (!index.has(id.trim().toLowerCase())) {
    throw new PmCliError(`Item ${id} not found`, EXIT_CODE.NOT_FOUND);
  }

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
    return buildContextDepsResult({
      assembly: lookup.assembly,
      canonicalId,
      options,
      rootEvidence,
      summaryOnly,
    });
  }

  if (summaryOnly) {
    return {
      id,
      format,
      ...countDependencyGraph(id, index, maxDepth),
    };
  }

  const tree = toTreeNode(
    id,
    index,
    new Set<string>(),
    maxDepth,
    collapse,
    new Set<string>(),
  );
  const graph = toGraph(tree);
  const baseResult = {
    id,
    format,
    node_count: graph.nodes.length,
    edge_count: graph.edges.length,
    missing_count: graph.missing_ids.length,
  };
  if (format === "tree") {
    return {
      ...baseResult,
      tree,
    };
  }
  return {
    ...baseResult,
    graph,
  };
}
