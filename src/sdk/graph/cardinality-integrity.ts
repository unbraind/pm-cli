/** @module sdk/graph/cardinality-integrity */
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import type { Dependency } from "../../types/index.js";
import type { RelationshipKindRegistry } from "../relationships.js";
import { resolveWorkspaceRelationshipKindRegistry } from "./workspace-relationship-kind-registry.js";

/** Minimal immutable item projection needed to compare relationship cardinality. */
export interface RelationshipCardinalityItem {
  /** Canonical workspace item identity. */
  id: string;
  /** Stored relationship rows, including their canonical kind and endpoint. */
  dependencies?: readonly Pick<Dependency, "id" | "kind">[];
}

interface CardinalityGroup {
  kind: string;
  direction: "outgoing" | "incoming";
  node_id: string;
  endpoints: Set<string>;
}

/** Share the workspace integrity lock for every kind that constrains edge multiplicity. */
export function relationshipKindNeedsIntegrityLock(kind: string, registry: RelationshipKindRegistry): boolean {
  const definition = registry.resolve(kind);
  return definition?.hierarchy === true || definition?.outgoing === "one" || definition?.incoming === "one";
}

/** Add one logical endpoint without counting duplicate provenance rows twice. */
function addEndpoint(groups: Map<string, CardinalityGroup>, kind: string, direction: CardinalityGroup["direction"], node: string, endpoint: string): void {
  const key = JSON.stringify([kind, direction, node]);
  let group = groups.get(key);
  if (group === undefined) {
    group = { kind, direction, node_id: node, endpoints: new Set() };
    groups.set(key, group);
  }
  group.endpoints.add(endpoint);
}

/** Project the active non-hierarchy one-edge constraints; hierarchy retains its richer shared validator. */
function cardinalityGroups(items: readonly RelationshipCardinalityItem[], registry: RelationshipKindRegistry): Map<string, CardinalityGroup> {
  const groups = new Map<string, CardinalityGroup>();
  for (const item of items) {
    for (const dependency of item.dependencies ?? []) {
      const definition = registry.resolve(dependency.kind);
      if (definition === undefined || definition.hierarchy) continue;
      if (definition.outgoing === "one") addEndpoint(groups, definition.kind, "outgoing", item.id, dependency.id);
      if (definition.incoming === "one") addEndpoint(groups, definition.kind, "incoming", dependency.id, item.id);
    }
  }
  return groups;
}

/** Reject newly introduced non-hierarchy cardinality debt while allowing unchanged debt and repairs. */
export function assertNonHierarchyCardinalityMutationAllowed(
  before: readonly RelationshipCardinalityItem[],
  after: readonly RelationshipCardinalityItem[],
  registry: RelationshipKindRegistry = resolveWorkspaceRelationshipKindRegistry(),
): void {
  const prior = cardinalityGroups(before, registry);
  const prospective = cardinalityGroups(after, registry);
  for (const key of [...prospective.keys()].sort()) {
    const group = prospective.get(key)!;
    if (group.endpoints.size <= 1) continue;
    const old = prior.get(key);
    if ([...group.endpoints].every((endpoint) => old?.endpoints.has(endpoint))) continue;
    throw new PmCliError(`Relationship ${group.kind} permits only one ${group.direction} endpoint for ${group.node_id}.`, EXIT_CODE.USAGE, {
      code: "dependency_cardinality_created",
      field: "dependencies", value: group.kind,
      relationship_cardinality: { kind: group.kind, direction: group.direction, node_id: group.node_id,
        endpoint_ids: [...group.endpoints].sort() },
      required: "The final dependency set must satisfy the active relationship kind's one-edge cardinality.",
      nextSteps: ["Drop extra --dep seeds, or remove conflicting rows with update --dep-remove before adding another edge.", "Choose another kind only when its declared semantics match the intended relationship."],
    });
  }
}
