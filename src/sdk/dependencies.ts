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
import { listAllItemMetadataLight } from "../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../core/store/paths.js";
import { readSettings } from "../core/store/settings.js";
import type {
  Dependency,
  ItemMetadata,
  ItemStatus,
  ItemType,
} from "../types/index.js";
import {
  buildRelationshipContext,
  type RelationshipContextResult,
} from "./relationship-context.js";
import { RelationshipGraph } from "./relationships.js";

/** Supported values accepted by the deps format contract. */
export const DEPS_FORMAT_VALUES = ["tree", "graph", "context"] as const;
/** Restricts deps format values accepted by command, SDK, and storage contracts. */
export type DepsFormat = (typeof DEPS_FORMAT_VALUES)[number];
/** Supported values accepted by the deps collapse contract. */
export const DEPS_COLLAPSE_VALUES = ["none", "repeated"] as const;
/** Restricts deps collapse mode values accepted by command, SDK, and storage contracts. */
export type DepsCollapseMode = (typeof DEPS_COLLAPSE_VALUES)[number];

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
  /** Maximum graph-context edges returned. */
  edgeLimit?: string | number;
  /** Maximum estimated graph-context output tokens. */
  tokenBudget?: string | number;
  /** Opaque continuation cursor for graph-context output. */
  cursor?: string;
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

/** Minimal item shape inspected by dependency-reference governance. */
export interface DependencyReferenceHolder {
  /** Stable item identifier. */
  id: string;
  /** Lifecycle status used to separate actionable work from historical debt. */
  status: ItemStatus;
  /** Optional hierarchy parent reference. */
  parent?: string;
  /** Optional legacy scalar blocker reference. */
  blocked_by?: string;
  /** Structured dependency edges. */
  dependencies?: Dependency[];
}

/** Storage surface that contributed a normalized dependency reference. */
export type DependencyReferenceSource = "parent" | "blocked_by" | "dependency";

/** One normalized dependency reference whose target is absent from the tracker. */
export interface DanglingDependencyReference {
  /** Item that owns the reference. */
  holder_id: string;
  /** Missing referenced item id or legacy sentinel. */
  target_id: string;
  /** Relationship field or dependency kind. */
  kind: string;
  /** Storage surface that owns the reference and determines its remediation. */
  source: DependencyReferenceSource;
  /** Current lifecycle status of the holder. */
  holder_status: ItemStatus;
  /** Whether the holder is terminal and therefore historical, non-actionable debt. */
  legacy_terminal: boolean;
  /** Whether the target is the pre-structured-dependency `no-active-blocker` sentinel. */
  no_active_blocker_sentinel: boolean;
}

/** Actionable and historical partitions returned by dependency-reference governance. */
export interface DanglingDependencyReferenceSummary {
  /** Missing references held by active items; these may affect scheduling and should gate validation. */
  active: DanglingDependencyReference[];
  /** Missing references held only by terminal items; retained as informational history debt. */
  legacy_terminal: DanglingDependencyReference[];
  /** Legacy sentinel rows across active and terminal holders, called out separately from typo-like ids. */
  no_active_blocker_sentinels: DanglingDependencyReference[];
}

/**
 * Classify missing hierarchy and dependency targets without mutating their holders.
 *
 * Consumers provide the workspace's terminal-status predicate so custom lifecycle
 * schemas receive the same active-versus-historical behavior as the built-in
 * closed/canceled statuses.
 */
export function collectDanglingDependencyReferences(
  items: readonly DependencyReferenceHolder[],
  isTerminal: (status: ItemStatus) => boolean = (status) =>
    status === "closed" || status === "canceled",
): DanglingDependencyReferenceSummary {
  const knownIds = new Set(items.map((item) => item.id.trim().toLowerCase()));
  const rows = new Map<string, DanglingDependencyReference>();
  const addReference = (
    item: DependencyReferenceHolder,
    target: unknown,
    kind: string,
    source: DependencyReferenceSource,
  ): void => {
    const normalized = typeof target === "string" ? target.trim() : "";
    if (
      !normalized ||
      ["none", "null", "n/a", "na"].includes(normalized.toLowerCase()) ||
      knownIds.has(normalized.toLowerCase())
    ) {
      return;
    }
    const row: DanglingDependencyReference = {
      holder_id: item.id,
      target_id: normalized,
      kind,
      source,
      holder_status: item.status,
      legacy_terminal: isTerminal(item.status),
      no_active_blocker_sentinel:
        normalized.toLowerCase() === "no-active-blocker",
    };
    rows.set(
      `${row.holder_id}::${row.target_id}::${row.kind}::${row.source}`,
      row,
    );
  };
  for (const item of items) {
    addReference(item, item.parent, "parent", "parent");
    addReference(item, item.blocked_by, "blocked_by", "blocked_by");
    for (const dependency of item.dependencies ?? []) {
      // Public SDK callers may supply legacy or JSON-decoded payloads that do
      // not yet satisfy the current structured dependency contract.
      if (typeof dependency !== "object" || dependency === null) {
        continue;
      }
      const legacyDependency = dependency as Partial<Dependency>;
      addReference(
        item,
        legacyDependency.id,
        typeof legacyDependency.kind === "string"
          ? legacyDependency.kind
          : "related",
        "dependency",
      );
    }
  }
  const sorted = [...rows.values()].sort(
    (left, right) =>
      left.holder_id.localeCompare(right.holder_id) ||
      left.target_id.localeCompare(right.target_id) ||
      left.kind.localeCompare(right.kind) ||
      left.source.localeCompare(right.source),
  );
  const legacyTerminal = sorted.filter((row) => row.legacy_terminal);
  return {
    active: sorted.filter((row) => !row.legacy_terminal),
    legacy_terminal: legacyTerminal,
    no_active_blocker_sentinels: sorted.filter(
      (row) => row.no_active_blocker_sentinel,
    ),
  };
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
  /** Number of missing entries represented by this result. */
  missing_count: number;
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

function parsePositiveInteger(raw: string | number | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = typeof raw === "number" ? raw : Number(raw.trim());
  if (!Number.isInteger(value) || value < 1)
    throw new PmCliError(`Invalid --${flag} value "${raw}". Use a positive integer.`, EXIT_CODE.USAGE);
  return value;
}

function parseMaxDepth(raw: string | number | undefined): number | undefined {
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

/** Build the SDK-backed bounded relationship-context projection for deps. */
export function buildDepsRelationshipContext(
  rootId: string,
  items: readonly ItemMetadata[],
  options: Pick<DepsCommandOptions, "maxDepth" | "nodeLimit" | "edgeLimit" | "tokenBudget" | "cursor">,
): RelationshipContextResult {
  const maxDepth = parseMaxDepth(options.maxDepth);
  const nodeLimit = parsePositiveInteger(options.nodeLimit, "node-limit");
  const edgeLimit = parsePositiveInteger(options.edgeLimit, "edge-limit");
  const tokenBudget = parsePositiveInteger(options.tokenBudget, "token-budget");
  const canonicalIds = new Map(items.map((item) => [item.id.trim().toLowerCase(), item.id.trim()]));
  const dangling = collectDanglingDependencyReferences(items);
  const missingIds = [...new Set(
    [...dangling.active, ...dangling.legacy_terminal].map(({ target_id }) => target_id.trim()),
  )].sort((left, right) => left.localeCompare(right));
  const graphItems = items.map((item) => ({
    id: item.id,
    ...(item.parent ? { parent: canonicalIds.get(item.parent.trim().toLowerCase()) ?? item.parent.trim() } : {}),
    ...(item.blocked_by ? { blocked_by: canonicalIds.get(item.blocked_by.trim().toLowerCase()) ?? item.blocked_by.trim() } : {}),
    dependencies: (item.dependencies ?? []).map((dependency) => ({
      ...dependency,
      id: canonicalIds.get(dependency.id.trim().toLowerCase()) ?? dependency.id.trim(),
    })),
  }));
  return buildRelationshipContext(
    RelationshipGraph.fromItems([...graphItems, ...missingIds.map((id) => ({ id }))]),
    rootId,
    [
      ...items.map((item) => ({ id: item.id, title: item.title, status: item.status })),
      ...missingIds.map((id) => ({ id, title: `[missing] ${id}`, status: "missing" })),
    ],
    {
      ...(maxDepth === undefined ? {} : { maxDepth }),
      ...(nodeLimit === undefined ? {} : { nodeLimit }),
      ...(edgeLimit === undefined ? {} : { edgeLimit }),
      ...(tokenBudget === undefined ? {} : { tokenBudget }),
      ...(options.cursor?.trim() ? { cursor: options.cursor.trim() } : {}),
    },
  );
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
    const context = buildDepsRelationshipContext(canonicalId, items, options);
    return {
      id: canonicalId,
      format,
      node_count: context.nodes.length + 1,
      edge_count: context.edges.length,
      missing_count: new Set(
        [...dangling.active, ...dangling.legacy_terminal].map(({ target_id }) => target_id.trim().toLowerCase()),
      ).size,
      ...(summaryOnly ? {} : { context }),
    };
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
