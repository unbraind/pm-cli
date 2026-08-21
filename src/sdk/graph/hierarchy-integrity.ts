/**
 * @module sdk/graph/hierarchy-integrity
 *
 * Normalizes scalar and dependency-backed hierarchy evidence into one graph,
 * reports structural defects, and rejects mutations that introduce new debt.
 */
import { EXIT_CODE } from "../../core/shared/constants.js";
import { PmCliError } from "../../core/shared/errors.js";
import type { Dependency, ItemStatus } from "../../types/index.js";
import {
  createRelationshipKindRegistry,
  type RelationshipKindRegistry,
} from "../relationships.js";

/** Storage surface from which one normalized hierarchy relation originated. */
export type HierarchyRelationSource = "scalar_parent" | "dependency";

/** Minimal workspace item shape required by hierarchy-integrity analysis. */
export interface HierarchyIntegrityItem {
  /** Stable item identifier. */
  id: string;
  /** Lifecycle status used to classify historical-only defects. */
  status: ItemStatus;
  /** Optional scalar structural parent. */
  parent?: string;
  /** Structured relationship rows that may carry hierarchy semantics. */
  dependencies?: Dependency[];
}

/** One canonical parent-to-child relation with exact stored-row provenance. */
export interface HierarchyRelation {
  /** Canonical structural parent identifier. */
  parent_id: string;
  /** Canonical structural child identifier. */
  child_id: string;
  /** Storage surface that asserted the relation. */
  source: HierarchyRelationSource;
  /** Canonical relationship kind, or `parent` for the scalar field. */
  kind: string;
  /** Item document that stores the relation. */
  holder_id: string;
  /** Referenced endpoint for dependency-backed relations. */
  target_id?: string;
  /** Registry cardinality at the child endpoint of this relation. */
  child_cardinality: "one" | "many";
}

/** One strongly connected hierarchy component. */
export interface HierarchyCycle {
  /** Deterministically sorted item identifiers in the cycle. */
  item_ids: string[];
  /** Whether every member is in a terminal lifecycle state. */
  legacy_terminal: boolean;
}

/** One child assigned to more than one logical parent. */
export interface HierarchyCardinalityViolation {
  /** Child whose parent cardinality was exceeded. */
  child_id: string;
  /** Deterministically sorted unique parent identifiers. */
  parent_ids: string[];
  /** Whether the child and every asserted parent are terminal. */
  legacy_terminal: boolean;
}

/** One scalar parent that disagrees with dependency-backed hierarchy evidence. */
export interface HierarchyParentDivergence {
  /** Child whose hierarchy storage surfaces disagree. */
  child_id: string;
  /** Parent declared by the scalar metadata field. */
  scalar_parent_id: string;
  /** Different dependency-backed parent identifiers. */
  dependency_parent_ids: string[];
  /** Whether the child and every asserted parent are terminal. */
  legacy_terminal: boolean;
}

/** Complete deterministic hierarchy-integrity projection for a workspace. */
export interface HierarchyIntegrityAnalysis {
  /** Normalized evidence rows retained for exact diagnostics and repair. */
  relations: HierarchyRelation[];
  /** Cyclic structural components. */
  cycles: HierarchyCycle[];
  /** Logical one-parent cardinality violations. */
  cardinality_violations: HierarchyCardinalityViolation[];
  /** Scalar and dependency-backed parent disagreements. */
  divergences: HierarchyParentDivergence[];
}

/** Deterministic adjacency indexes derived from normalized hierarchy evidence. */
export interface HierarchyRelationIndexes {
  /** Unique logical parents keyed by child id. */
  parents_by_child: ReadonlyMap<string, readonly string[]>;
  /** Unique logical children keyed by parent id. */
  children_by_parent: ReadonlyMap<string, readonly string[]>;
}

function normalizeItemId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function relationIdentity(relation: HierarchyRelation): string {
  return [
    relation.parent_id,
    relation.child_id,
    relation.source,
    relation.kind,
    relation.holder_id,
    relation.target_id ?? "",
  ].join("\u0000");
}

function collectHierarchyFinishOrder(
  nodeIds: readonly string[],
  childrenByParent: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  const visited = new Set<string>();
  const finishOrder: string[] = [];
  for (const root of [...nodeIds].sort()) {
    if (visited.has(root)) continue;
    visited.add(root);
    const frames = [{ nodeId: root, nextChild: 0 }];
    while (frames.length > 0) {
      const frame = frames.at(-1)!;
      const children = [...(childrenByParent.get(frame.nodeId) ?? [])].sort();
      const childId = children[frame.nextChild];
      if (childId === undefined) {
        finishOrder.push(frame.nodeId);
        frames.pop();
      } else {
        frame.nextChild += 1;
        if (!visited.has(childId)) {
          visited.add(childId);
          frames.push({ nodeId: childId, nextChild: 0 });
        }
      }
    }
  }
  return finishOrder;
}

function collectCyclicComponents(
  nodeIds: readonly string[],
  childrenByParent: ReadonlyMap<string, ReadonlySet<string>>,
): string[][] {
  const sortedNodeIds = [...nodeIds].sort();
  const finishOrder = collectHierarchyFinishOrder(
    sortedNodeIds,
    childrenByParent,
  );
  const visited = new Set<string>();
  const parentsByChild = reverseHierarchyEdges(sortedNodeIds, childrenByParent);
  const components: string[][] = [];
  for (const root of finishOrder.reverse()) {
    if (visited.has(root)) continue;
    const component = collectReverseComponent(root, parentsByChild, visited);
    if (
      component.length > 1 ||
      childrenByParent.get(component[0]!)?.has(component[0]!)
    )
      components.push(component);
  }
  return components.sort((left, right) =>
    left.join("\u0000").localeCompare(right.join("\u0000")),
  );
}

function reverseHierarchyEdges(
  nodeIds: readonly string[],
  childrenByParent: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, Set<string>> {
  const parentsByChild = new Map(
    nodeIds.map((nodeId) => [nodeId, new Set<string>()]),
  );
  for (const [parentId, childIds] of childrenByParent) {
    for (const childId of childIds) parentsByChild.get(childId)?.add(parentId);
  }
  return parentsByChild;
}

function collectReverseComponent(
  root: string,
  parentsByChild: ReadonlyMap<string, ReadonlySet<string>>,
  visited: Set<string>,
): string[] {
  const component: string[] = [];
  const pending = [root];
  visited.add(root);
  while (pending.length > 0) {
    const nodeId = pending.pop()!;
    component.push(nodeId);
    for (const parentId of [...parentsByChild.get(nodeId)!].sort()) {
      if (visited.has(parentId)) continue;
      visited.add(parentId);
      pending.push(parentId);
    }
  }
  return component.sort();
}

function collectHierarchyItems(
  items: readonly HierarchyIntegrityItem[],
): Map<string, HierarchyIntegrityItem> {
  const itemById = new Map<string, HierarchyIntegrityItem>();
  for (const item of items) {
    const itemId = normalizeItemId(item?.id);
    if (itemId && !itemById.has(itemId)) itemById.set(itemId, item);
  }
  return itemById;
}

function buildScalarHierarchyRelation(
  holderId: string,
  item: HierarchyIntegrityItem,
  itemById: ReadonlyMap<string, HierarchyIntegrityItem>,
): HierarchyRelation | undefined {
  const parentId = normalizeItemId(item.parent);
  if (!parentId || !itemById.has(parentId)) return undefined;
  return {
    parent_id: parentId,
    child_id: holderId,
    source: "scalar_parent",
    kind: "parent",
    holder_id: holderId,
    child_cardinality: "one",
  };
}

function buildDependencyHierarchyRelation(
  holderId: string,
  dependency: Dependency,
  itemById: ReadonlyMap<string, HierarchyIntegrityItem>,
  registry: RelationshipKindRegistry,
): HierarchyRelation | undefined {
  const targetId = normalizeItemId(dependency?.id);
  const definition = registry.resolve(dependency?.kind);
  if (!targetId || !itemById.has(targetId) || !definition?.hierarchy)
    return undefined;
  const sourceIsParent = definition.hierarchyDirection === "source_parent";
  return {
    parent_id: sourceIsParent ? holderId : targetId,
    child_id: sourceIsParent ? targetId : holderId,
    source: "dependency",
    kind: definition.kind,
    holder_id: holderId,
    target_id: targetId,
    child_cardinality: sourceIsParent
      ? definition.incoming
      : definition.outgoing,
  };
}

function collectHierarchyRelations(
  itemById: ReadonlyMap<string, HierarchyIntegrityItem>,
  registry: RelationshipKindRegistry,
): HierarchyRelation[] {
  const relationsByIdentity = new Map<string, HierarchyRelation>();
  for (const [holderId, item] of itemById) {
    const scalarRelation = buildScalarHierarchyRelation(
      holderId,
      item,
      itemById,
    );
    if (scalarRelation)
      relationsByIdentity.set(relationIdentity(scalarRelation), scalarRelation);
    for (const dependency of item.dependencies ?? []) {
      const relation = buildDependencyHierarchyRelation(
        holderId,
        dependency,
        itemById,
        registry,
      );
      if (!relation) continue;
      relationsByIdentity.set(relationIdentity(relation), relation);
    }
  }
  return [...relationsByIdentity.values()].sort((left, right) =>
    relationIdentity(left).localeCompare(relationIdentity(right)),
  );
}

function collectHierarchyCardinalityViolations(
  relations: readonly HierarchyRelation[],
  parentsByChild: HierarchyRelationIndexes["parents_by_child"],
  terminalIds: ReadonlySet<string>,
): HierarchyCardinalityViolation[] {
  const oneCardinalityChildren = new Set(
    relations
      .filter((relation) => relation.child_cardinality === "one")
      .map((relation) => relation.child_id),
  );
  return [...parentsByChild]
    .filter(
      ([childId, parentIds]) =>
        parentIds.length > 1 && oneCardinalityChildren.has(childId),
    )
    .map(([childId, parentIds]) => ({
      child_id: childId,
      parent_ids: [...parentIds],
      legacy_terminal:
        terminalIds.has(childId) &&
        parentIds.every((id) => terminalIds.has(id)),
    }))
    .sort((left, right) => left.child_id.localeCompare(right.child_id));
}

function collectHierarchyDivergences(
  itemById: ReadonlyMap<string, HierarchyIntegrityItem>,
  relations: readonly HierarchyRelation[],
  terminalIds: ReadonlySet<string>,
): HierarchyParentDivergence[] {
  const dependencyParentsByChild = new Map<string, Set<string>>();
  for (const relation of relations) {
    if (relation.source !== "dependency") continue;
    const parents =
      dependencyParentsByChild.get(relation.child_id) ?? new Set<string>();
    parents.add(relation.parent_id);
    dependencyParentsByChild.set(relation.child_id, parents);
  }
  const divergences: HierarchyParentDivergence[] = [];
  for (const [childId, item] of itemById) {
    const scalarParentId = normalizeItemId(item.parent);
    if (!scalarParentId || !itemById.has(scalarParentId)) continue;
    const dependencyParentIds = [
      ...(dependencyParentsByChild.get(childId) ?? []),
    ]
      .filter((parentId) => parentId !== scalarParentId)
      .sort();
    if (dependencyParentIds.length === 0) continue;
    divergences.push({
      child_id: childId,
      scalar_parent_id: scalarParentId,
      dependency_parent_ids: dependencyParentIds,
      legacy_terminal:
        terminalIds.has(childId) &&
        terminalIds.has(scalarParentId) &&
        dependencyParentIds.every((id) => terminalIds.has(id)),
    });
  }
  return divergences;
}

/**
 * Analyze all runtime-recognized hierarchy spellings as canonical parent-child
 * relations. Unknown, malformed, and dangling rows are ignored here because
 * dedicated graph-integrity checks own those diagnostics.
 */
export function analyzeHierarchyIntegrity(
  items: readonly HierarchyIntegrityItem[],
  isTerminal: (status: ItemStatus) => boolean = (status) =>
    status === "closed" || status === "canceled",
  registry: RelationshipKindRegistry = createRelationshipKindRegistry(),
): HierarchyIntegrityAnalysis {
  const itemById = collectHierarchyItems(items);
  const relations = collectHierarchyRelations(itemById, registry);
  const indexes = indexHierarchyRelations(relations);
  const terminalIds = new Set(
    [...itemById]
      .filter(([, item]) => isTerminal(item.status))
      .map(([id]) => id),
  );
  const cycles = collectCyclicComponents(
    [...itemById.keys()],
    new Map(
      [...indexes.children_by_parent].map(([id, childIds]) => [
        id,
        new Set(childIds),
      ]),
    ),
  ).map((itemIds) => ({
    item_ids: itemIds,
    legacy_terminal: itemIds.every((id) => terminalIds.has(id)),
  }));
  return {
    relations,
    cycles,
    cardinality_violations: collectHierarchyCardinalityViolations(
      relations,
      indexes.parents_by_child,
      terminalIds,
    ),
    divergences: collectHierarchyDivergences(itemById, relations, terminalIds),
  };
}

/** Render exact hierarchy evidence without losing its storage orientation. */
export function formatHierarchyRelation(relation: HierarchyRelation): string {
  if (relation.source === "scalar_parent")
    return `${relation.parent_id} -> ${relation.child_id} (scalar parent on ${relation.holder_id})`;
  return `${relation.parent_id} -> ${relation.child_id} (${relation.kind} dependency on ${relation.holder_id})`;
}

/** Index normalized hierarchy evidence for list, tree, and rollup consumers. */
export function indexHierarchyRelations(
  relations: readonly HierarchyRelation[],
): HierarchyRelationIndexes {
  const parentSets = new Map<string, Set<string>>();
  const childSets = new Map<string, Set<string>>();
  for (const relation of relations) {
    const parents = parentSets.get(relation.child_id) ?? new Set<string>();
    parents.add(relation.parent_id);
    parentSets.set(relation.child_id, parents);
    const children = childSets.get(relation.parent_id) ?? new Set<string>();
    children.add(relation.child_id);
    childSets.set(relation.parent_id, children);
  }
  return {
    parents_by_child: new Map(
      [...parentSets].map(([id, values]) => [id, [...values].sort()]),
    ),
    children_by_parent: new Map(
      [...childSets].map(([id, values]) => [id, [...values].sort()]),
    ),
  };
}

/**
 * Reject a mutation only when it introduces a new hierarchy defect involving
 * the changed item. Existing debt remains repairable without a global bypass.
 */
export function assertHierarchyMutationAllowed(
  beforeItems: readonly HierarchyIntegrityItem[],
  afterItems: readonly HierarchyIntegrityItem[],
  changedItemId: string,
  isTerminal?: (status: ItemStatus) => boolean,
  registry?: RelationshipKindRegistry,
): void {
  const holderId = normalizeItemId(changedItemId);
  if (!holderId) return;
  const before = analyzeHierarchyIntegrity(beforeItems, isTerminal, registry);
  const after = analyzeHierarchyIntegrity(afterItems, isTerminal, registry);
  const priorDivergences = new Set(
    before.divergences.map((finding) =>
      [
        finding.child_id,
        finding.scalar_parent_id,
        ...finding.dependency_parent_ids,
      ].join("\u0000"),
    ),
  );
  const divergence = after.divergences.find(
    (finding) =>
      finding.child_id === holderId &&
      !priorDivergences.has(
        [
          finding.child_id,
          finding.scalar_parent_id,
          ...finding.dependency_parent_ids,
        ].join("\u0000"),
      ),
  );
  if (divergence) {
    const parentIds = [
      divergence.scalar_parent_id,
      ...divergence.dependency_parent_ids,
    ].sort();
    throw new PmCliError(
      `Hierarchy mutation would assign ${holderId} to multiple parents: ${parentIds.join(", ")}.`,
      EXIT_CODE.CONFLICT,
      {
        code: "hierarchy_parent_divergence_created",
        source_id: holderId,
        target_id: holderId,
        verification_errors: parentIds,
      },
    );
  }
  const priorCardinality = new Set(
    before.cardinality_violations.map((finding) =>
      [finding.child_id, ...finding.parent_ids].join("\u0000"),
    ),
  );
  const cardinality = after.cardinality_violations.find(
    (finding) =>
      (finding.child_id === holderId ||
        finding.parent_ids.includes(holderId)) &&
      !priorCardinality.has(
        [finding.child_id, ...finding.parent_ids].join("\u0000"),
      ),
  );
  if (cardinality) {
    throw new PmCliError(
      `Hierarchy mutation would assign ${cardinality.child_id} to multiple parents: ${cardinality.parent_ids.join(", ")}.`,
      EXIT_CODE.CONFLICT,
      {
        code: "hierarchy_cardinality_created",
        source_id: holderId,
        target_id: cardinality.child_id,
        verification_errors: cardinality.parent_ids,
      },
    );
  }
  const priorCycles = new Set(
    before.cycles.map((finding) => finding.item_ids.join("\u0000")),
  );
  const cycle = after.cycles.find(
    (finding) =>
      finding.item_ids.includes(holderId) &&
      !priorCycles.has(finding.item_ids.join("\u0000")),
  );
  if (cycle) {
    throw new PmCliError(
      `Hierarchy mutation would create a cycle: ${cycle.item_ids.join(" -> ")}.`,
      EXIT_CODE.CONFLICT,
      {
        code: "hierarchy_cycle_created",
        source_id: holderId,
        verification_errors: cycle.item_ids,
      },
    );
  }
}
