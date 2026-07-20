/**
 * @module sdk/graph/assembly
 *
 * Builds the shared workspace relationship graph consumed by dependency
 * queries, bounded context packets, impact analysis, and governance audits.
 * Assembly normalizes hierarchy, legacy scalar blockers, and structured
 * dependency edges into one deterministic {@link RelationshipGraph}, classifies
 * dangling references without mutating their holders, and materializes missing
 * endpoints as placeholder nodes so bounded traversals can explain absent work
 * instead of silently dropping it.
 */
import type { Dependency, ItemStatus } from "../../types/index.js";
import { getActiveExtensionRegistrations } from "../../core/extensions/index.js";
import {
  RelationshipGraph,
  createRelationshipKindRegistry,
  type RelationshipKindRegistry,
} from "../relationships.js";

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

/** Normalize a decoded reference target and reject empty legacy placeholders. */
function normalizeDependencyReferenceTarget(
  target: unknown,
): string | undefined {
  if (typeof target !== "string") return undefined;
  const normalized = target.trim();
  if (
    !normalized ||
    ["none", "null", "n/a", "na"].includes(normalized.toLowerCase())
  )
    return undefined;
  return normalized;
}

/** Normalize a graph target while removing the historical no-blocker marker. */
export function normalizeDependencyGraphTarget(
  target: unknown,
): string | undefined {
  const normalized = normalizeDependencyReferenceTarget(target);
  return normalized?.toLowerCase() === "no-active-blocker"
    ? undefined
    : normalized;
}

/**
 * Resolve the default workspace relationship-kind registry: the built-in kinds
 * merged with every active extension-contributed relationship-kind
 * registration. Assembly, mutation advisories, and standalone graph consumers
 * share this resolution so custom ordering semantics apply identically on
 * every surface.
 */
export function resolveWorkspaceRelationshipKindRegistry(): RelationshipKindRegistry {
  const registry = createRelationshipKindRegistry();
  for (const registration of getActiveExtensionRegistrations()
    ?.relationship_kinds ?? []) {
    for (const definition of registration.definitions) {
      registry.register(definition);
    }
  }
  return registry;
}

/** One raw stored dependency row duplicated verbatim on a single holder. */
export interface DuplicateDependencyRow {
  /** Item that stores the duplicated row. */
  holder_id: string;
  /** Referenced target id in its first stored spelling. */
  target_id: string;
  /** Stored relationship kind shared by every duplicate occurrence. */
  kind: string;
  /** Total stored occurrences of the identical row (always >= 2). */
  occurrences: number;
  /** Current lifecycle status of the holder. */
  holder_status: ItemStatus;
  /** Whether the holder is terminal and the duplication is historical debt. */
  legacy_terminal: boolean;
}

/** Count one holder's dependency rows by their case-insensitive kind-plus-target identity. */
function countDependencyRowIdentities(
  item: DependencyReferenceHolder,
): Map<string, { target_id: string; kind: string; count: number }> {
  const occurrences = new Map<
    string,
    { target_id: string; kind: string; count: number }
  >();
  for (const dependency of item.dependencies ?? []) {
    if (typeof dependency !== "object" || dependency === null) continue;
    const legacyDependency = dependency as Partial<Dependency>;
    const target = normalizeDependencyReferenceTarget(legacyDependency.id);
    if (!target) continue;
    const kind =
      typeof legacyDependency.kind === "string"
        ? legacyDependency.kind
        : "related";
    const key = `${kind}\u0000${target.toLowerCase()}`;
    const existing = occurrences.get(key);
    if (existing) existing.count += 1;
    else occurrences.set(key, { target_id: target, kind, count: 1 });
  }
  return occurrences;
}

/**
 * Collect raw stored dependency rows whose exact identity — holder, kind, and
 * case-insensitive target — appears more than once on one item. Graph
 * construction deduplicates these by edge identity, so the assembled graph and
 * every projection built on it cannot see them; this pre-assembly scan is the
 * only surface that reports the storage-layer defect.
 */
export function collectDuplicateDependencyRows(
  items: readonly DependencyReferenceHolder[],
  isTerminal: (status: ItemStatus) => boolean = (status) =>
    status === "closed" || status === "canceled",
): DuplicateDependencyRow[] {
  const rows: DuplicateDependencyRow[] = [];
  for (const item of items) {
    if (typeof item?.id !== "string" || item.id.trim().length === 0) continue;
    for (const entry of countDependencyRowIdentities(item).values()) {
      if (entry.count < 2) continue;
      rows.push({
        holder_id: item.id.trim(),
        target_id: entry.target_id,
        kind: entry.kind,
        occurrences: entry.count,
        holder_status: item.status,
        legacy_terminal: isTerminal(item.status),
      });
    }
  }
  return rows.sort((left, right) =>
    JSON.stringify([left.holder_id, left.target_id, left.kind]) <
    JSON.stringify([right.holder_id, right.target_id, right.kind])
      ? -1
      : 1,
  );
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
  const safeItems = items.filter(
    (item) => typeof item?.id === "string" && item.id.trim().length > 0,
  );
  const knownIds = new Set(
    safeItems.map((item) => item.id.trim().toLowerCase()),
  );
  const rows = new Map<string, DanglingDependencyReference>();
  const addReference = (
    item: DependencyReferenceHolder,
    target: unknown,
    kind: string,
    source: DependencyReferenceSource,
  ): void => {
    const normalized = normalizeDependencyReferenceTarget(target);
    if (!normalized || knownIds.has(normalized.toLowerCase())) {
      return;
    }
    const row: DanglingDependencyReference = {
      holder_id: item.id.trim(),
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
  for (const item of safeItems) {
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

/** Return unique real missing targets while excluding the legacy no-blocker sentinel. */
export function collectMissingDependencyTargetIds(
  dangling: DanglingDependencyReferenceSummary,
): string[] {
  const targets = new Map<string, string>();
  for (const reference of [...dangling.active, ...dangling.legacy_terminal]) {
    if (reference.no_active_blocker_sentinel) continue;
    const target = reference.target_id.trim();
    const key = target.toLowerCase();
    if (!targets.has(key)) targets.set(key, target);
  }
  return [...targets.values()].sort((left, right) => left.localeCompare(right));
}

/** Item shape accepted by workspace relationship-graph assembly. */
export interface WorkspaceRelationshipItem extends DependencyReferenceHolder {
  /** Human-readable title projected into per-node details. */
  title: string;
  /** Optional item type powering per-type coverage profiles and policies. */
  type?: string;
}

/** Compact node projection paired with the assembled graph. */
export interface WorkspaceRelationshipNodeDetails {
  /** Stable node identifier. */
  id: string;
  /** Human-readable node title, or a `[missing]` marker for absent endpoints. */
  title: string;
  /** Lifecycle status, or the `missing` marker status for absent endpoints. */
  status: string;
  /** Item type when the source item declared one; absent on missing placeholders. */
  type?: string;
}

/** Assembled workspace relationship graph with governance side-products. */
export interface WorkspaceRelationshipAssembly {
  /** Deterministic relationship graph including missing placeholder nodes. */
  graph: RelationshipGraph;
  /** Per-node compact details covering real and missing nodes. */
  details: WorkspaceRelationshipNodeDetails[];
  /** Lowercased identifiers of materialized missing endpoints. */
  missingIdSet: Set<string>;
  /** Dangling-reference classification computed during assembly. */
  dangling: DanglingDependencyReferenceSummary;
  /** Raw same-identity duplicated dependency rows found before graph dedup. */
  duplicateRows: DuplicateDependencyRow[];
}

/**
 * Build the shared workspace relationship graph including missing placeholder
 * nodes. One assembly serves every bounded query in an invocation — dependency
 * trees, context packets, impact analysis, path enumeration, and governance
 * audits — so the full-workspace normalization cost is paid once instead of
 * once per query surface.
 */
export function assembleWorkspaceRelationshipGraph(
  items: readonly WorkspaceRelationshipItem[],
  isTerminal?: (status: ItemStatus) => boolean,
  registry?: RelationshipKindRegistry,
): WorkspaceRelationshipAssembly {
  const relationshipRegistry =
    registry ?? resolveWorkspaceRelationshipKindRegistry();
  const safeItems = items.filter(
    (item) => typeof item?.id === "string" && item.id.trim().length > 0,
  );
  const canonicalIds = new Map(
    safeItems.map((item) => [item.id.trim().toLowerCase(), item.id.trim()]),
  );
  const dangling = collectDanglingDependencyReferences(safeItems, isTerminal);
  const missingIds = collectMissingDependencyTargetIds(dangling);
  for (const id of missingIds) canonicalIds.set(id.toLowerCase(), id);
  const graphItems = safeItems.map((item) => {
    const parent = normalizeDependencyGraphTarget(item.parent);
    const blocker = normalizeDependencyGraphTarget(item.blocked_by);
    const dependencies = (item.dependencies ?? []).flatMap((rawDependency) => {
      if (typeof rawDependency !== "object" || rawDependency === null)
        return [];
      const dependency = rawDependency as Partial<Dependency>;
      const target = normalizeDependencyGraphTarget(dependency.id);
      if (!target) return [];
      return [
        {
          id: canonicalIds.get(target.toLowerCase())!,
          kind:
            typeof dependency.kind === "string" ? dependency.kind : "related",
        },
      ];
    });
    return {
      id: item.id.trim(),
      ...(parent ? { parent: canonicalIds.get(parent.toLowerCase())! } : {}),
      ...(blocker
        ? { blocked_by: canonicalIds.get(blocker.toLowerCase())! }
        : {}),
      dependencies,
    };
  });
  return {
    graph: RelationshipGraph.fromItems(
      [...graphItems, ...missingIds.map((id) => ({ id }))],
      relationshipRegistry,
    ),
    details: [
      ...safeItems.map((item) => ({
        id: item.id.trim(),
        title: item.title,
        status: item.status,
        ...(typeof item.type === "string" && item.type.trim().length > 0
          ? { type: item.type }
          : {}),
      })),
      ...missingIds.map((id) => ({
        id,
        title: `[missing] ${id}`,
        status: "missing",
      })),
    ],
    missingIdSet: new Set(missingIds.map((id) => id.toLowerCase())),
    dangling,
    duplicateRows: collectDuplicateDependencyRows(safeItems, isTerminal),
  };
}
