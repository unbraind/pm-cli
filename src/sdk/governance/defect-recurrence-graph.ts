/**
 * @module sdk/governance/defect-recurrence-graph
 *
 * Derives recurrence families from local recorded edges. Association, hierarchy,
 * external references, and matching file globs never establish family coverage.
 */
import {
  isExternalDependencyReference,
  isExternalDependencySourceKind,
} from "../../core/item/dependency-reference.js";
import type { AssuranceItemRecord } from "./assurance.js";
import type { DefectRecurrenceFamily } from "./defect-recurrence.js";

/** Sparse item evidence retained so incremental graph edits can be reversed. */
export interface DefectRecurrenceRecord {
  /** Unique local predecessors named by recurs_from edges. */
  targets: string[];
  /** Project file paths used as exact change-risk triggers after lineage registration. */
  files: string[];
  /** Recorded classification, never inferred from a registered family's label. */
  escape_class?: string;
}

/** One weakly connected recurrence component, traversed without a depth ceiling. */
export interface DefectRecurrenceLineage {
  /** Lexically first member, used as a stable identifier for the current component. */
  id: string;
  /** Every member, in deterministic code-point order. */
  item_ids: string[];
  /** Families explicitly seeded anywhere in this component. */
  family_ids: string[];
}

/** Complete sparse graph used internally by the bounded public coverage report. */
export interface DefectRecurrenceGraph {
  /** Components sorted by their current stable id. */
  lineages: DefectRecurrenceLineage[];
  /** Sparse lookup from every recurrence member to its component. */
  membership: Map<string, DefectRecurrenceLineage>;
  /** Number of distinct directed local recurrence edges. */
  edge_count: number;
}

/** Extract local recurrence targets while rejecting malformed and external edges. */
function recurrenceTargets(item: AssuranceItemRecord): string[] {
  const targets = new Set<string>();
  for (const edge of Array.isArray(item.dependencies)
    ? item.dependencies
    : []) {
    if (typeof edge !== "object" || edge === null || Array.isArray(edge))
      continue;
    if (edge.kind !== "recurs_from") continue;
    if (typeof edge.id !== "string" || !edge.id.trim()) continue;
    if (
      isExternalDependencyReference(edge.id) ||
      isExternalDependencySourceKind(
        typeof edge.source_kind === "string" ? edge.source_kind : undefined,
      )
    )
      continue;
    targets.add(edge.id.trim());
  }
  return [...targets].sort();
}

/** Extract project-scoped exact file triggers from untrusted linked-file records. */
function recurrenceFiles(item: AssuranceItemRecord): string[] {
  const files = new Set<string>();
  for (const file of Array.isArray(item.files) ? item.files : []) {
    if (typeof file !== "object" || file === null || Array.isArray(file))
      continue;
    const entry = file as Record<string, unknown>;
    if (entry.scope !== undefined && entry.scope !== "project") continue;
    if (typeof entry.path === "string" && entry.path.trim())
      files.add(entry.path.trim());
  }
  return [...files].sort();
}

/** Read a sparse projection without retaining full item bodies or history. */
export function readDefectRecurrenceRecord(
  item: AssuranceItemRecord,
): DefectRecurrenceRecord | undefined {
  const targets = recurrenceTargets(item);
  const files = recurrenceFiles(item);
  const escapeClass =
    typeof item.escape_class === "string" ? item.escape_class : undefined;
  if (targets.length === 0 && files.length === 0 && escapeClass === undefined)
    return undefined;
  return {
    targets,
    files,
    ...(escapeClass === undefined ? {} : { escape_class: escapeClass }),
  };
}

/** Traverse one component iteratively and collect only explicitly seeded families. */
function traverseLineage(
  start: string,
  adjacency: ReadonlyMap<string, Set<string>>,
  seeds: ReadonlyMap<string, Set<string>>,
  membership: Map<string, DefectRecurrenceLineage>,
): DefectRecurrenceLineage {
  const lineage: DefectRecurrenceLineage = {
    id: start,
    item_ids: [],
    family_ids: [],
  };
  const pending = [start];
  const familyIds = new Set<string>();
  membership.set(start, lineage);
  while (pending.length > 0) {
    const id = pending.pop()!;
    lineage.item_ids.push(id);
    for (const familyId of seeds.get(id) ?? []) familyIds.add(familyId);
    for (const target of adjacency.get(id)!) {
      if (membership.has(target)) continue;
      membership.set(target, lineage);
      pending.push(target);
    }
  }
  lineage.item_ids.sort();
  lineage.id = lineage.item_ids[0]!;
  lineage.family_ids = [...familyIds].sort();
  return lineage;
}

/** Build iterative undirected connectivity from directed recurrence evidence. */
export function buildDefectRecurrenceGraph(
  families: readonly DefectRecurrenceFamily[],
  records: ReadonlyMap<string, DefectRecurrenceRecord>,
): DefectRecurrenceGraph {
  const adjacency = new Map<string, Set<string>>();
  let edgeCount = 0;
  for (const [id, record] of records) {
    for (const target of record.targets) {
      const outgoing = adjacency.get(id) ?? new Set<string>();
      outgoing.add(target);
      adjacency.set(id, outgoing);
      const incoming = adjacency.get(target) ?? new Set<string>();
      incoming.add(id);
      adjacency.set(target, incoming);
      edgeCount += 1;
    }
  }
  const seeds = new Map<string, Set<string>>();
  for (const family of families) {
    for (const id of [
      family.owner_item_id,
      ...family.historical_item_ids,
      ...(family.triggers.item_ids ?? []),
    ]) {
      const ids = seeds.get(id) ?? new Set<string>();
      ids.add(family.id);
      seeds.set(id, ids);
    }
  }
  const membership = new Map<string, DefectRecurrenceLineage>();
  const lineages: DefectRecurrenceLineage[] = [];
  for (const start of adjacency.keys()) {
    if (membership.has(start)) continue;
    lineages.push(traverseLineage(start, adjacency, seeds, membership));
  }
  lineages.sort((left, right) => (left.id < right.id ? -1 : 1));
  return { lineages, membership, edge_count: edgeCount };
}
