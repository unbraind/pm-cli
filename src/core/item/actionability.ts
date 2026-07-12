/**
 * @module core/item/actionability
 *
 * Pure, dependency-aware actionability model shared by the `pm next` command and
 * the close-time auto-unblock sweep. It answers "what is ready to work on now?"
 * without any I/O: given a candidate set and the surrounding corpus it partitions
 * work into READY items (active, leaf, no open blockers) and BLOCKED items (active
 * leaf waiting on at least one open blocker). Keeping the logic here — rather than
 * inside a CLI command — makes it trivially testable and reusable, and gives the
 * `blocked_by` resolution a single source of truth.
 */
import { isTerminalStatus, normalizeStatusForRegistry } from "./status.js";
import type { RuntimeStatusRegistry } from "../schema/runtime-schema.js";
import type { ItemMetadata, ItemStatus } from "../../types/index.js";

/** Dependency kind that marks "this item is blocked by the referenced item". */
const BLOCKED_BY_DEPENDENCY_KIND = "blocked_by";

/**
 * Normalizes an item id / parent reference / blocker id to its canonical
 * comparison key (trimmed, lowercased). pm ids are canonically lowercase, but
 * resolving case-insensitively — as {@link collectSubtreeIds} does — keeps a
 * hand-edited mixed-case reference from being silently treated as missing.
 */
function normalizeItemId(id: string): string {
  return id.trim().toLowerCase();
}

/** Collects the blocker item ids declared by an item: the legacy scalar `blocked_by` field plus every `blocked_by` dependency edge. Ids are trimmed, de-duplicated, and returned in stable lexicographic order. This is the single source of truth for "what must close before this item can proceed", shared by `pm next` readiness classification and the close-time auto-unblock sweep. */
export function collectBlockedByIds(
  item: Pick<ItemMetadata, "blocked_by" | "dependencies">,
): string[] {
  const ids = new Set<string>();
  const scalar =
    typeof item.blocked_by === "string" ? item.blocked_by.trim() : "";
  if (scalar.length > 0) {
    ids.add(scalar);
  }
  for (const dependency of item.dependencies ?? []) {
    if (
      dependency.kind === BLOCKED_BY_DEPENDENCY_KIND &&
      typeof dependency.id === "string" &&
      dependency.id.trim().length > 0
    ) {
      ids.add(dependency.id.trim());
    }
  }
  return [...ids].sort((left, right) => left.localeCompare(right));
}

/** A blocker reference resolved against the corpus and annotated with its state. */
export interface ResolvedBlocker {
  /** Stable identifier used to reference this record across commands and storage. */
  id: string;
  /** Value that configures or reports title for this contract. */
  title: string | null;
  /** Lifecycle state reported for status. */
  status: ItemStatus | null;
  /** True when the blocker no longer gates work because the referenced item is terminal. */
  resolved: boolean;
}

/** Resolves an item's declared blockers against a corpus index, annotating each with the blocker's title/status and whether it still gates work. Unknown ids remain unresolved: silently treating a typo as satisfied would dispatch work whose prerequisite was never completed. Terminal referenced items alone are resolved. */
export function resolveItemBlockers(
  item: Pick<ItemMetadata, "blocked_by" | "dependencies">,
  itemsById: Map<string, ItemMetadata>,
  statusRegistry: RuntimeStatusRegistry,
): ResolvedBlocker[] {
  return collectBlockedByIds(item).map((id) => {
    const blocker = itemsById.get(normalizeItemId(id));
    if (!blocker) {
      return { id, title: null, status: null, resolved: false };
    }
    return {
      id,
      title: blocker.title,
      status: blocker.status,
      resolved: isTerminalStatus(blocker.status, statusRegistry),
    };
  });
}

/** A classified actionable item plus the context an agent needs to act on it. */
export interface ActionableEntry {
  /** Value that configures or reports item for this contract. */
  item: ItemMetadata;
  /** Blockers that still gate the item (resolved blockers are filtered out). */
  open_blockers: ResolvedBlocker[];
  /** Ids of non-terminal items whose `blocked_by` points at this item. */
  unblocks: string[];
}

/** Result of partitioning a candidate set into ready vs blocked leaf work. */
export interface ActionabilityReport {
  /** Active leaves with no open blockers — ready to work on now. */
  ready: ActionableEntry[];
  /** Active leaves with at least one open blocker — waiting to become ready. */
  blocked: ActionableEntry[];
  /** Active candidates considered before the leaf/blocker split. */
  active_count: number;
  /** Active candidates skipped because they still have open descendants. */
  container_count: number;
}

/** Resolves the registry's active status set, falling back to just the canonical open status when a custom schema declares none — the same safety net `pm context` applies so the report never misclassifies every item as inactive. */
function resolveActiveStatusSet(
  statusRegistry: RuntimeStatusRegistry,
): Set<string> {
  /* c8 ignore start -- fallback applies only to custom schemas that intentionally define zero active statuses */
  return statusRegistry.active_statuses.size > 0
    ? statusRegistry.active_statuses
    : new Set<string>([statusRegistry.open_status]);
  /* c8 ignore stop */
}

/** Returns whether an item has any non-terminal descendant by walking the parent→children index depth-first, short-circuiting on the first one found. Such an item is a container (its real work lives in its children), so `pm next` skips it and recommends a leaf instead. Cycle-safe via a visited set. */
function hasOpenDescendant(
  rootId: string,
  childrenByParent: Map<string, ItemMetadata[]>,
  statusRegistry: RuntimeStatusRegistry,
): boolean {
  const stack = [normalizeItemId(rootId)];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop() as string;
    /* c8 ignore start -- defensive cycle-guard: unreachable for active roots (an open child returns before any node is revisited, and single-parent graphs cannot form a root-reachable cycle excluding the root), retained for safety */
    if (visited.has(current)) continue;
    /* c8 ignore stop */
    visited.add(current);
    for (const child of childrenByParent.get(current) ?? []) {
      if (!isTerminalStatus(child.status, statusRegistry)) {
        return true;
      }
      stack.push(normalizeItemId(child.id));
    }
  }
  return false;
}

/** Indexes the corpus into a by-id map, a parent→children map, and a reverse blocker map (blocker id → ids of items it blocks). Built once per report so blocker resolution, descendant counting, and downstream "unblocks" lookups share the same passes over the corpus. */
function indexCorpus(corpus: ItemMetadata[]): {
  itemsById: Map<string, ItemMetadata>;
  childrenByParent: Map<string, ItemMetadata[]>;
  blockedByReverse: Map<string, string[]>;
} {
  const itemsById = new Map<string, ItemMetadata>();
  const childrenByParent = new Map<string, ItemMetadata[]>();
  const blockedByReverse = new Map<string, string[]>();
  for (const item of corpus) {
    // Index keys are normalized (lowercased) for case-insensitive resolution;
    // stored values keep the item's original-case id for display.
    itemsById.set(normalizeItemId(item.id), item);
    const parent = typeof item.parent === "string" ? item.parent.trim() : "";
    if (parent.length > 0) {
      const parentKey = normalizeItemId(parent);
      const siblings = childrenByParent.get(parentKey) ?? [];
      siblings.push(item);
      childrenByParent.set(parentKey, siblings);
    }
    for (const blockerId of collectBlockedByIds(item)) {
      const blockerKey = normalizeItemId(blockerId);
      const dependents = blockedByReverse.get(blockerKey) ?? [];
      dependents.push(item.id);
      blockedByReverse.set(blockerKey, dependents);
    }
  }
  return { itemsById, childrenByParent, blockedByReverse };
}

/**
 * Partitions a candidate set into ready vs blocked leaf work using the corpus to
 * resolve blockers, descendants, and downstream dependents.
 *
 * An item qualifies when its status is active. Containers — items with at least
 * one non-terminal descendant — are excluded from both lists because the real
 * work is the leaf beneath them. A leaf with no open blockers is READY; a leaf
 * with one or more open blockers is BLOCKED, annotated with the unresolved
 * blockers and the non-terminal items it would unblock. Returned lists preserve
 * the candidate order so the caller can apply its own ranking.
 */
export function computeActionabilityReport(
  candidates: ItemMetadata[],
  corpus: ItemMetadata[],
  statusRegistry: RuntimeStatusRegistry,
): ActionabilityReport {
  const { itemsById, childrenByParent, blockedByReverse } = indexCorpus(corpus);
  const activeStatuses = new Set([
    ...resolveActiveStatusSet(statusRegistry),
    ...statusRegistry.blocked_statuses,
  ]);
  // Ids of corpus items still in flight, used to keep only the non-terminal
  // dependents in each item's downstream "unblocks" list.
  const nonTerminalIds = new Set(
    corpus
      .filter((entry) => !isTerminalStatus(entry.status, statusRegistry))
      .map((entry) => normalizeItemId(entry.id)),
  );
  const ready: ActionableEntry[] = [];
  const blocked: ActionableEntry[] = [];
  let activeCount = 0;
  let containerCount = 0;
  for (const item of candidates) {
    if (
      !activeStatuses.has(
        normalizeStatusForRegistry(item.status, statusRegistry),
      )
    )
      continue;
    activeCount += 1;
    if (hasOpenDescendant(item.id, childrenByParent, statusRegistry)) {
      containerCount += 1;
      continue;
    }
    const openBlockers = resolveItemBlockers(
      item,
      itemsById,
      statusRegistry,
    ).filter((blocker) => !blocker.resolved);
    const unblocks = (blockedByReverse.get(normalizeItemId(item.id)) ?? [])
      .filter((dependentId) => nonTerminalIds.has(normalizeItemId(dependentId)))
      .sort((left, right) => left.localeCompare(right));
    const entry: ActionableEntry = {
      item,
      open_blockers: openBlockers,
      unblocks,
    };
    const lifecycleBlocked = statusRegistry.blocked_statuses.has(
      normalizeStatusForRegistry(item.status, statusRegistry),
    );
    if (openBlockers.length === 0 && !lifecycleBlocked) {
      ready.push(entry);
    } else {
      blocked.push(entry);
    }
  }
  return {
    ready,
    blocked,
    active_count: activeCount,
    container_count: containerCount,
  };
}
