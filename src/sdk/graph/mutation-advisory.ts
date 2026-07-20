/**
 * @module sdk/graph/mutation-advisory
 *
 * Detects newly introduced execution-order cycles across immutable workspace
 * snapshots so mutation clients can warn without rejecting legacy graph debt.
 * Detection is incremental: instead of assembling the full workspace
 * relationship graph and running whole-graph cycle analysis twice per
 * mutation, both snapshots build only a lightweight ordering digraph and scope
 * cycle enumeration to the changed item's weakly connected ordering component
 * — a cycle containing the changed item can never span nodes outside it.
 */
import type { ItemMetadata } from "../../types/index.js";
import type { RelationshipKindRegistry } from "../relationships.js";
import {
  normalizeDependencyGraphTarget,
  resolveWorkspaceRelationshipKindRegistry,
} from "./assembly.js";
import { collectOrderingCycles } from "./governance.js";

/** Lightweight ordering digraph over one immutable item snapshot. */
interface OrderingDigraph {
  /** Sorted successor adjacency oriented predecessor -> successor. */
  successors: Map<string, string[]>;
  /** Sorted predecessor adjacency, the reverse orientation of successors. */
  predecessors: Map<string, string[]>;
  /** Canonical original-case ids keyed by their lowercase spelling. */
  canonicalIds: Map<string, string>;
}

function cycleKey(component: readonly string[]): string {
  return [...component].sort().join("\u0000");
}

/** Append one oriented ordering edge to both adjacency orientations. */
function addOrderingEdge(
  digraph: OrderingDigraph,
  predecessor: string,
  successor: string,
): void {
  const forward = digraph.successors.get(predecessor);
  if (forward) forward.push(successor);
  else digraph.successors.set(predecessor, [successor]);
  const backward = digraph.predecessors.get(successor);
  if (backward) backward.push(predecessor);
  else digraph.predecessors.set(successor, [predecessor]);
}

/**
 * Orient one candidate reference into the digraph when its kind is a
 * registry-known order-bearing kind and its target resolves to a real item.
 * Associative kinds, unknown kinds, retired sentinels, and references to
 * absent items are skipped because none of them can create an
 * execution-order cycle — a referenced-but-absent item has no stored
 * out-edges.
 */
function orientOrderingEdge(
  digraph: OrderingDigraph,
  registry: RelationshipKindRegistry,
  source: string,
  target: unknown,
  kind: string,
): void {
  const definition = registry.resolve(kind);
  if (definition?.ordering !== true) return;
  const normalized = normalizeDependencyGraphTarget(target);
  const canonicalTarget =
    normalized === undefined
      ? undefined
      : digraph.canonicalIds.get(normalized.toLowerCase());
  if (canonicalTarget === undefined) return;
  const sourceFirst =
    (definition.precedence ?? "source_before_target") ===
    "source_before_target";
  addOrderingEdge(
    digraph,
    sourceFirst ? source : canonicalTarget,
    sourceFirst ? canonicalTarget : source,
  );
}

/**
 * Build the ordering-only digraph for one item snapshot without assembling a
 * full relationship graph: one linear pass over the legacy scalar blocker and
 * structured dependency rows of every item.
 */
function buildOrderingDigraph(
  items: readonly ItemMetadata[],
  registry: RelationshipKindRegistry,
): OrderingDigraph {
  const digraph: OrderingDigraph = {
    successors: new Map(),
    predecessors: new Map(),
    canonicalIds: new Map(),
  };
  const safeItems = items.filter(
    (item) => typeof item?.id === "string" && item.id.trim().length > 0,
  );
  for (const item of safeItems) {
    const id = item.id.trim();
    digraph.canonicalIds.set(id.toLowerCase(), id);
  }
  for (const item of safeItems) {
    const id = item.id.trim();
    orientOrderingEdge(digraph, registry, id, item.blocked_by, "blocked_by");
    for (const dependency of item.dependencies ?? []) {
      if (typeof dependency !== "object" || dependency === null) continue;
      orientOrderingEdge(
        digraph,
        registry,
        id,
        dependency.id,
        typeof dependency.kind === "string" ? dependency.kind : "related",
      );
    }
  }
  for (const adjacency of [digraph.successors, digraph.predecessors])
    for (const neighbors of adjacency.values()) neighbors.sort();
  return digraph;
}

/**
 * Collect the changed item's weakly connected ordering component: every node
 * reachable through ordering edges in either orientation. Cycle enumeration
 * restricted to this member set is exact for cycles containing the changed
 * item, because a strongly connected component is always contained in a
 * weakly connected one.
 */
function collectWeakComponent(
  digraph: OrderingDigraph,
  start: string,
): Set<string> {
  const members = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const node = queue.pop()!;
    for (const adjacency of [digraph.successors, digraph.predecessors]) {
      for (const neighbor of adjacency.get(node) ?? []) {
        if (members.has(neighbor)) continue;
        members.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  return members;
}

/** Restrict a successor adjacency to edges whose endpoints are both members. */
function induceSuccessors(
  digraph: OrderingDigraph,
  members: ReadonlySet<string>,
): Map<string, string[]> {
  const induced = new Map<string, string[]>();
  for (const member of members) {
    const neighbors = (digraph.successors.get(member) ?? []).filter((node) =>
      members.has(node),
    );
    if (neighbors.length > 0) induced.set(member, neighbors);
  }
  return induced;
}

/** Enumerate component-scoped ordering cycles around one canonical item id. */
function collectScopedCycles(
  items: readonly ItemMetadata[],
  registry: RelationshipKindRegistry,
  changedItemId: string,
): {
  cycles: string[][];
  successors: Map<string, string[]>;
  canonical: string;
} {
  const digraph = buildOrderingDigraph(items, registry);
  const canonical = digraph.canonicalIds.get(
    changedItemId.trim().toLowerCase(),
  );
  if (canonical === undefined)
    return { cycles: [], successors: new Map(), canonical: changedItemId };
  const successors = induceSuccessors(
    digraph,
    collectWeakComponent(digraph, canonical),
  );
  return {
    cycles: collectOrderingCycles(successors).filter((component) =>
      component.includes(canonical),
    ),
    successors,
    canonical,
  };
}

function findCyclePath(
  adjacency: ReadonlyMap<string, readonly string[]>,
  component: readonly string[],
  changedItemId: string,
): string[] {
  const members = new Set(component);
  const start = members.has(changedItemId) ? changedItemId : component[0]!;
  if (adjacency.get(start)?.includes(start)) return [start, start];
  for (const first of adjacency.get(start) ?? []) {
    if (!members.has(first)) continue;
    const path = findPathBackToStart(adjacency, members, start, first);
    if (path) return path;
  }
  return [...component, component[0]!];
}

function findPathBackToStart(
  adjacency: ReadonlyMap<string, readonly string[]>,
  members: ReadonlySet<string>,
  start: string,
  first: string,
): string[] | undefined {
  const queue = [[first]];
  const visited = new Set([start, first]);
  while (queue.length > 0) {
    const path = queue.shift()!;
    const tail = path.at(-1)!;
    for (const next of adjacency.get(tail) ?? []) {
      if (next === start) return [start, ...path, start];
      if (!members.has(next) || visited.has(next)) continue;
      visited.add(next);
      queue.push([...path, next]);
    }
  }
  return undefined;
}

/** Return actionable warnings only for ordering cycles created by the later snapshot and containing the changed item. */
export function collectNewOrderingCycleWarnings(
  beforeItems: readonly ItemMetadata[],
  afterItems: readonly ItemMetadata[],
  changedItemId: string,
): string[] {
  const registry = resolveWorkspaceRelationshipKindRegistry();
  const before = collectScopedCycles(beforeItems, registry, changedItemId);
  const after = collectScopedCycles(afterItems, registry, changedItemId);
  const beforeCycles = new Set(before.cycles.map(cycleKey));
  return after.cycles
    .filter((component) => !beforeCycles.has(cycleKey(component)))
    .map(
      (component) =>
        `ordering_cycle_created:${findCyclePath(after.successors, component, after.canonical).join(" -> ")}:items_will_not_be_ready:run_pm_graph_audit`,
    );
}

/** White-box graph-path helpers for exhaustive SDK primitive verification. */
export const mutationAdvisoryTestOnly = {
  buildOrderingDigraph,
  collectWeakComponent,
  induceSuccessors,
  findCyclePath,
  findPathBackToStart,
};
