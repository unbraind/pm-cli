/**
 * @module sdk/dependencies
 *
 * Implements the pm deps command surface and its agent-facing runtime behavior.
 */
import { getActiveExtensionRegistrations } from "../core/extensions/index.js";
import { pathExists } from "../core/fs/fs-utils.js";
import { resolveItemTypeRegistry } from "../core/item/type-registry.js";
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

/** Supported values accepted by the deps format contract. */
export const DEPS_FORMAT_VALUES = ["tree", "graph"] as const;
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
}

interface IndexedItem {
  id: string;
  title: string;
  type: ItemType;
  status: ItemStatus;
  dependencies: Dependency[];
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

/** One normalized dependency reference whose target is absent from the tracker. */
export interface DanglingDependencyReference {
  /** Item that owns the reference. */
  holder_id: string;
  /** Missing referenced item id or legacy sentinel. */
  target_id: string;
  /** Relationship field or dependency kind. */
  kind: string;
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
  /** Historical sentinel rows called out separately from typo-like missing ids. */
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
      holder_status: item.status,
      legacy_terminal: isTerminal(item.status),
      no_active_blocker_sentinel:
        normalized.toLowerCase() === "no-active-blocker",
    };
    rows.set(`${row.holder_id}::${row.target_id}::${row.kind}`, row);
  };
  for (const item of items) {
    addReference(item, item.parent, "parent");
    addReference(item, item.blocked_by, "blocked_by");
    for (const dependency of item.dependencies ?? []) {
      addReference(item, dependency.id, dependency.kind);
    }
  }
  const sorted = [...rows.values()].sort(
    (left, right) =>
      left.holder_id.localeCompare(right.holder_id) ||
      left.target_id.localeCompare(right.target_id) ||
      left.kind.localeCompare(right.kind),
  );
  const legacyTerminal = sorted.filter((row) => row.legacy_terminal);
  return {
    active: sorted.filter((row) => !row.legacy_terminal),
    legacy_terminal: legacyTerminal,
    no_active_blocker_sentinels: legacyTerminal.filter(
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
}

function parseFormat(raw: string | undefined): DepsFormat {
  const candidate = raw?.trim().toLowerCase() ?? "tree";
  if ((DEPS_FORMAT_VALUES as readonly string[]).includes(candidate)) {
    return candidate as DepsFormat;
  }
  throw new PmCliError(
    `Invalid --format value "${raw}". Use "tree" or "graph".`,
    EXIT_CODE.USAGE,
  );
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
): Dependency[] {
  if (!dependencies || dependencies.length === 0) {
    return [];
  }
  const sorted = [...dependencies].sort((left, right) => {
    const byKind = left.kind.localeCompare(right.kind);
    if (byKind !== 0) return byKind;
    const byId = left.id.localeCompare(right.id);
    if (byId !== 0) return byId;
    return left.created_at.localeCompare(right.created_at);
  });
  const deduped = new Map<string, Dependency>();
  for (const dependency of sorted) {
    const key = `${dependency.kind}::${dependency.id}`;
    if (!deduped.has(key)) {
      deduped.set(key, dependency);
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
  const item = index.get(id);
  const baseNode: DepsTreeNode = {
    id,
    title: item?.title,
    type: item?.type,
    status: item?.status,
    via,
    missing: !item,
    cycle: lineage.has(id),
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
  if (collapse === "repeated" && expanded.has(id)) {
    baseNode.collapsed = true;
    return baseNode;
  }
  if (collapse === "repeated") {
    expanded.add(id);
  }
  const nextLineage = new Set(lineage);
  nextLineage.add(id);
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
  const index = new Map(items.map((item) => [item.id, toIndexedItem(item)]));
  if (!index.has(id)) {
    throw new PmCliError(`Item ${id} not found`, EXIT_CODE.NOT_FOUND);
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
  if (summaryOnly) {
    return baseResult;
  }
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
