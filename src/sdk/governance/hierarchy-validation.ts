/**
 * @module sdk/governance/hierarchy-validation
 *
 * Adapts the shared hierarchy analyzer to validation-specific diagnostics and
 * deterministic cycle paths without coupling the analyzer to CLI policy.
 */
import {
  statusIsTerminal,
  type RuntimeStatusRegistry,
} from "../../core/schema/runtime-schema.js";
import type { RelationshipKindRegistry } from "../relationships.js";
import { resolveWorkspaceRelationshipKindRegistry } from "../graph/assembly.js";
import { analyzeHierarchyIntegrity } from "../graph/hierarchy-integrity.js";
import type { ValidateItem } from "./validate-item-reader.js";

/** Resolve one deterministic closed walk through a known cycle component. */
/* c8 ignore start -- fallback branches are covered by lifecycle graph integration tests */
export function resolveLifecycleDependencyCycleSamplePath(
  component: string[],
  graph: Map<string, string[]>,
): string[] {
  const start = component[0]!;
  if (component.length === 1) return [start, start];
  const componentSet = new Set(component);
  const path: string[] = [start];
  const visited = new Set<string>([start]);
  const search = (current: string): boolean => {
    for (const next of (graph.get(current) ?? []).filter((candidate) =>
      componentSet.has(candidate),
    )) {
      if (next === start && path.length > 1) {
        path.push(start);
        return true;
      }
      if (visited.has(next)) continue;
      visited.add(next);
      path.push(next);
      if (search(next)) return true;
      path.pop();
      visited.delete(next);
    }
    return false;
  };
  return search(start) ? [...path] : [...component, start];
}
/* c8 ignore stop */

/** Resolve a scalar parent spelling to the workspace's canonical identifier. */
function resolveCanonicalScalarParent(
  parent: unknown,
  canonicalIdByLowercase: ReadonlyMap<string, string>,
): string | undefined {
  if (typeof parent !== "string") return undefined;
  const normalized = parent.trim().toLowerCase();
  return normalized.length > 0
    ? canonicalIdByLowercase.get(normalized)
    : undefined;
}

/** Append dependency-backed child-to-parent adjacency for one holder. */
function appendDependencyHierarchyEdges(
  item: ValidateItem,
  graph: Map<string, string[]>,
  canonicalIdByLowercase: ReadonlyMap<string, string>,
  relationshipRegistry: RelationshipKindRegistry,
): void {
  for (const dependency of item.dependencies ?? []) {
    const definition = relationshipRegistry.resolve(dependency.kind);
    if (!definition?.hierarchy) continue;
    const target = canonicalIdByLowercase.get(dependency.id.toLowerCase());
    if (!target) continue;
    if (definition.hierarchyDirection === "source_parent")
      graph.get(target)!.push(item.id);
    else graph.get(item.id)!.push(target);
  }
}

/** Build canonical child-to-parent adjacency across every hierarchy spelling. */
export function buildLifecycleParentGraph(
  items: ValidateItem[],
  relationshipRegistry: RelationshipKindRegistry = resolveWorkspaceRelationshipKindRegistry(),
): Map<string, string[]> {
  const canonicalIdByLowercase = new Map(
    items.map((item) => [item.id.toLowerCase(), item.id]),
  );
  const graph = new Map(items.map((item) => [item.id, [] as string[]]));
  for (const item of [...items].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    const edges = graph.get(item.id)!;
    const canonicalParentId = resolveCanonicalScalarParent(
      item.parent,
      canonicalIdByLowercase,
    );
    if (canonicalParentId) edges.push(canonicalParentId);
    appendDependencyHierarchyEdges(
      item,
      graph,
      canonicalIdByLowercase,
      relationshipRegistry,
    );
  }
  for (const [id, edges] of graph) {
    graph.set(id, [...new Set(edges)].sort());
  }
  return graph;
}

/** Project shared hierarchy analysis into the validation result contract. */
export function detectLifecycleParentCycles(
  items: ValidateItem[],
  statusRegistry?: RuntimeStatusRegistry,
  relationshipRegistry: RelationshipKindRegistry = resolveWorkspaceRelationshipKindRegistry(),
): {
  cycle_count: number;
  active_cycle_count: number;
  legacy_cycle_count: number;
  cycle_item_ids: string[];
  cycle_sample_paths: string[];
  cardinality_violation_count: number;
  active_cardinality_violation_count: number;
  legacy_cardinality_violation_count: number;
  cardinality_violation_rows: string[];
  parent_divergence_count: number;
  active_parent_divergence_count: number;
  legacy_parent_divergence_count: number;
  parent_divergence_rows: string[];
} {
  const hierarchy = analyzeHierarchyIntegrity(
    items,
    (status) =>
      statusRegistry
        ? statusIsTerminal(status, statusRegistry)
        : status === "closed" || status === "canceled",
    relationshipRegistry,
  );
  const graph = buildLifecycleParentGraph(items, relationshipRegistry);
  const cycleComponents = hierarchy.cycles.map((cycle) => cycle.item_ids);
  return {
    cycle_count: cycleComponents.length,
    active_cycle_count: hierarchy.cycles.filter(
      (cycle) => !cycle.legacy_terminal,
    ).length,
    legacy_cycle_count: hierarchy.cycles.filter(
      (cycle) => cycle.legacy_terminal,
    ).length,
    cycle_item_ids: [...new Set(cycleComponents.flat())].sort(),
    cycle_sample_paths: cycleComponents.map((component) =>
      resolveLifecycleDependencyCycleSamplePath(component, graph).join("->"),
    ),
    cardinality_violation_count: hierarchy.cardinality_violations.length,
    active_cardinality_violation_count: hierarchy.cardinality_violations.filter(
      (finding) => !finding.legacy_terminal,
    ).length,
    legacy_cardinality_violation_count: hierarchy.cardinality_violations.filter(
      (finding) => finding.legacy_terminal,
    ).length,
    cardinality_violation_rows: hierarchy.cardinality_violations.map(
      (finding) =>
        `${finding.child_id}:${finding.parent_ids.join(",")}:${finding.legacy_terminal ? "legacy" : "active"}`,
    ),
    parent_divergence_count: hierarchy.divergences.length,
    active_parent_divergence_count: hierarchy.divergences.filter(
      (finding) => !finding.legacy_terminal,
    ).length,
    legacy_parent_divergence_count: hierarchy.divergences.filter(
      (finding) => finding.legacy_terminal,
    ).length,
    parent_divergence_rows: hierarchy.divergences.map(
      (finding) =>
        `${finding.child_id}:scalar=${finding.scalar_parent_id}:dependencies=${finding.dependency_parent_ids.join(",")}:${finding.legacy_terminal ? "legacy" : "active"}`,
    ),
  };
}
