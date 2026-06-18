/**
 * @module cli/commands/deps
 *
 * Implements the pm deps command surface and its agent-facing runtime behavior.
 */
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import { pathExists } from "../../core/fs/fs-utils.js";
import { resolveItemTypeRegistry } from "../../core/item/type-registry.js";
import { EXIT_CODE } from "../../core/shared/constants.js";
import type { GlobalOptions } from "../../core/shared/command-types.js";
import { PmCliError } from "../../core/shared/errors.js";
import { listAllFrontMatterLight } from "../../core/store/item-store.js";
import { getSettingsPath, resolvePmRoot } from "../../core/store/paths.js";
import { readSettings } from "../../core/store/settings.js";
import type { Dependency, ItemFrontMatter, ItemStatus, ItemType } from "../../types/index.js";

export const DEPS_FORMAT_VALUES = ["tree", "graph"] as const;
/**
 * Restricts deps format values accepted by command, SDK, and storage contracts.
 */
export type DepsFormat = (typeof DEPS_FORMAT_VALUES)[number];
export const DEPS_COLLAPSE_VALUES = ["none", "repeated"] as const;
/**
 * Restricts deps collapse mode values accepted by command, SDK, and storage contracts.
 */
export type DepsCollapseMode = (typeof DEPS_COLLAPSE_VALUES)[number];

/**
 * Documents the deps command options payload exchanged by command, SDK, and package integrations.
 */
export interface DepsCommandOptions {
  format?: string;
  maxDepth?: string | number;
  collapse?: string;
  summary?: boolean;
}

interface IndexedItem {
  id: string;
  title: string;
  type: ItemType;
  status: ItemStatus;
  dependencies: Dependency[];
}

/**
 * Documents the deps tree node payload exchanged by command, SDK, and package integrations.
 */
export interface DepsTreeNode {
  id: string;
  title?: string;
  type?: ItemType;
  status?: ItemStatus;
  via?: string;
  missing: boolean;
  cycle: boolean;
  truncated?: boolean;
  collapsed?: boolean;
  dependencies: DepsTreeNode[];
}

/**
 * Documents the deps graph node payload exchanged by command, SDK, and package integrations.
 */
export interface DepsGraphNode {
  id: string;
  title?: string;
  type?: ItemType;
  status?: ItemStatus;
  missing: boolean;
}

/**
 * Documents the deps graph edge payload exchanged by command, SDK, and package integrations.
 */
export interface DepsGraphEdge {
  from: string;
  to: string;
  kind: string;
}

/**
 * Documents the deps graph result payload exchanged by command, SDK, and package integrations.
 */
export interface DepsGraphResult {
  root_id: string;
  nodes: DepsGraphNode[];
  edges: DepsGraphEdge[];
  missing_ids: string[];
}

/**
 * Documents the deps result payload exchanged by command, SDK, and package integrations.
 */
export interface DepsResult {
  id: string;
  format: DepsFormat;
  node_count: number;
  edge_count: number;
  missing_count: number;
  tree?: DepsTreeNode;
  graph?: DepsGraphResult;
}

function parseFormat(raw: string | undefined): DepsFormat {
  const candidate = raw?.trim().toLowerCase() ?? "tree";
  if ((DEPS_FORMAT_VALUES as readonly string[]).includes(candidate)) {
    return candidate as DepsFormat;
  }
  throw new PmCliError(`Invalid --format value "${raw}". Use "tree" or "graph".`, EXIT_CODE.USAGE);
}

function parseMaxDepth(raw: string | number | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const normalized = typeof raw === "number" ? raw : Number(raw.trim());
  if (!Number.isInteger(normalized) || normalized < 0) {
    throw new PmCliError(`Invalid --max-depth value "${raw}". Use a non-negative integer.`, EXIT_CODE.USAGE);
  }
  return normalized;
}

function parseCollapse(raw: string | undefined): DepsCollapseMode {
  const candidate = raw?.trim().toLowerCase() ?? "none";
  if ((DEPS_COLLAPSE_VALUES as readonly string[]).includes(candidate)) {
    return candidate as DepsCollapseMode;
  }
  throw new PmCliError(`Invalid --collapse value "${raw}". Use "none" or "repeated".`, EXIT_CODE.USAGE);
}

function normalizeDependencies(dependencies: Dependency[] | undefined): Dependency[] {
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

function toIndexedItem(item: ItemFrontMatter): IndexedItem {
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
    toTreeNode(dependency.id, index, nextLineage, maxDepth, collapse, expanded, depth + 1, dependency.kind),
  );
  return baseNode;
}

function mergeGraphNode(existing: DepsGraphNode | undefined, candidate: DepsGraphNode): DepsGraphNode {
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

  const nodes = [...nodesById.values()].sort((left, right) => left.id.localeCompare(right.id));
  const edges = [...edgesByKey.values()].sort((left, right) => {
    const byFrom = left.from.localeCompare(right.from);
    if (byFrom !== 0) return byFrom;
    const byTo = left.to.localeCompare(right.to);
    if (byTo !== 0) return byTo;
    return left.kind.localeCompare(right.kind);
  });
  const missingIds = nodes.filter((node) => node.missing).map((node) => node.id);
  return {
    root_id: root.id,
    nodes,
    edges,
    missing_ids: missingIds,
  };
}

/**
 * Implements run deps for the public runtime surface of this module.
 */
export async function runDeps(id: string, options: DepsCommandOptions, global: GlobalOptions): Promise<DepsResult> {
  const pmRoot = resolvePmRoot(process.cwd(), global.path);
  if (!(await pathExists(getSettingsPath(pmRoot)))) {
    throw new PmCliError(`Tracker is not initialized at ${pmRoot}. Run pm init first.`, EXIT_CODE.NOT_FOUND);
  }
  const format = parseFormat(options.format);
  const maxDepth = parseMaxDepth(options.maxDepth);
  const collapse = parseCollapse(options.collapse);
  const summaryOnly = options.summary === true;
  const settings = await readSettings(pmRoot);
  const typeRegistry = resolveItemTypeRegistry(settings, getActiveExtensionRegistrations());
  const items = await listAllFrontMatterLight(pmRoot, settings.item_format, typeRegistry.type_to_folder, undefined, settings.schema);
  const index = new Map(items.map((item) => [item.id, toIndexedItem(item)]));
  if (!index.has(id)) {
    throw new PmCliError(`Item ${id} not found`, EXIT_CODE.NOT_FOUND);
  }

  const tree = toTreeNode(id, index, new Set<string>(), maxDepth, collapse, new Set<string>());
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
