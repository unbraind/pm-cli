/**
 * @module sdk/graph/mutation-advisory
 *
 * Detects newly introduced execution-order cycles across immutable workspace
 * snapshots so mutation clients can warn without rejecting legacy graph debt.
 */
import type { ItemMetadata } from "../../types/index.js";
import { analyzeRelationshipExecution } from "../relationship-analytics.js";
import type { RelationshipGraph } from "../relationships.js";
import { assembleWorkspaceRelationshipGraph } from "./assembly.js";

function cycleKey(component: readonly string[]): string {
  return [...component]
    .sort((left, right) => left.localeCompare(right))
    .join("\u0000");
}

function buildOrderingAdjacency(graph: RelationshipGraph): Map<string, string[]> {
  const adjacency = new Map(graph.nodes().map((node) => [node, [] as string[]]));
  for (const edge of graph.edges()) {
    const definition = graph.registry().require(edge.kind);
    if (!definition.ordering) continue;
    const sourceFirst =
      (definition.precedence ?? "source_before_target") ===
      "source_before_target";
    adjacency
      .get(sourceFirst ? edge.source : edge.target)!
      .push(sourceFirst ? edge.target : edge.source);
  }
  for (const neighbors of adjacency.values()) {
    neighbors.sort((left, right) => left.localeCompare(right));
  }
  return adjacency;
}

function findCyclePath(
  graph: RelationshipGraph,
  component: readonly string[],
  changedItemId: string,
): string[] {
  const members = new Set(component);
  const start = members.has(changedItemId) ? changedItemId : component[0]!;
  const adjacency = buildOrderingAdjacency(graph);
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
  const beforeGraph = assembleWorkspaceRelationshipGraph(beforeItems).graph;
  const afterGraph = assembleWorkspaceRelationshipGraph(afterItems).graph;
  const beforeCycles = new Set(
    analyzeRelationshipExecution(beforeGraph, {
      registry: beforeGraph.registry(),
    }).cycles.map(cycleKey),
  );
  return analyzeRelationshipExecution(afterGraph, {
    registry: afterGraph.registry(),
  }).cycles
    .filter(
      (component) =>
        component.includes(changedItemId) &&
        !beforeCycles.has(cycleKey(component)),
    )
    .map(
      (component) =>
        `ordering_cycle_created:${findCyclePath(afterGraph, component, changedItemId).join(" -> ")}:items_will_not_be_ready:run_pm_graph_audit`,
    );
}

/** White-box graph-path helpers for exhaustive SDK primitive verification. */
export const mutationAdvisoryTestOnly = {
  buildOrderingAdjacency,
  findCyclePath,
  findPathBackToStart,
};
