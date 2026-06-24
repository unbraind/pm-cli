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
import type { ItemFrontMatter, ItemStatus } from "../../types/index.js";

/** Dependency kind that marks "this item is blocked by the referenced item". */
const BLOCKED_BY_DEPENDENCY_KIND = "blocked_by";

/**
 * Collects the blocker item ids declared by an item: the legacy scalar
 * `blocked_by` field plus every `blocked_by` dependency edge. Ids are trimmed,
 * de-duplicated, and returned in stable lexicographic order. This is the single
 * source of truth for "what must close before this item can proceed", shared by
 * `pm next` readiness classification and the close-time auto-unblock sweep.
 */
export function collectBlockedByIds(item: Pick<ItemFrontMatter, "blocked_by" | "dependencies">): string[] {
  const ids = new Set<string>();
  const scalar = typeof item.blocked_by === "string" ? item.blocked_by.trim() : "";
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
  id: string;
  title: string | null;
  status: ItemStatus | null;
  /** True when the blocker no longer gates work: its id is unknown or terminal. */
  resolved: boolean;
}

/**
 * Resolves an item's declared blockers against a corpus index, annotating each
 * with the blocker's title/status and whether it still gates work. A blocker is
 * treated as resolved when its id is unknown (a dangling reference cannot be
 * waited on) or the referenced item is terminal — mirroring the close-time
 * auto-unblock rule, which only clears a dependent once its blocker is terminal.
 */
export function resolveItemBlockers(
  item: Pick<ItemFrontMatter, "blocked_by" | "dependencies">,
  itemsById: Map<string, ItemFrontMatter>,
  statusRegistry: RuntimeStatusRegistry,
): ResolvedBlocker[] {
  return collectBlockedByIds(item).map((id) => {
    const blocker = itemsById.get(id);
    if (!blocker) {
      return { id, title: null, status: null, resolved: true };
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
  item: ItemFrontMatter;
  /** Blockers that still gate the item (resolved blockers are filtered out). */
  open_blockers: ResolvedBlocker[];
  /** Non-terminal descendants of this item; always 0 for classified entries. */
  open_children: number;
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

/**
 * Resolves the registry's active status set, falling back to just the canonical
 * open status when a custom schema declares none — the same safety net `pm
 * context` applies so the report never misclassifies every item as inactive.
 */
function resolveActiveStatusSet(statusRegistry: RuntimeStatusRegistry): Set<string> {
  /* c8 ignore start -- fallback applies only to custom schemas that intentionally define zero active statuses */
  return statusRegistry.active_statuses.size > 0 ? statusRegistry.active_statuses : new Set<string>([statusRegistry.open_status]);
  /* c8 ignore stop */
}

/**
 * Counts the non-terminal descendants of an item by walking the parent→children
 * index depth-first. A positive count marks the item as a container (its real
 * work lives in its children), so `pm next` can skip it and recommend a leaf.
 * Cycle-safe via a visited set.
 */
function countOpenDescendants(
  rootId: string,
  childrenByParent: Map<string, ItemFrontMatter[]>,
  statusRegistry: RuntimeStatusRegistry,
): number {
  let open = 0;
  const stack = [rootId];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const child of childrenByParent.get(current) ?? []) {
      if (!isTerminalStatus(child.status, statusRegistry)) {
        open += 1;
      }
      stack.push(child.id);
    }
  }
  return open;
}

/**
 * Indexes the corpus into a by-id map, a parent→children map, and a reverse
 * blocker map (blocker id → ids of items it blocks). Built once per report so
 * blocker resolution, descendant counting, and downstream "unblocks" lookups
 * share the same passes over the corpus.
 */
function indexCorpus(corpus: ItemFrontMatter[]): {
  itemsById: Map<string, ItemFrontMatter>;
  childrenByParent: Map<string, ItemFrontMatter[]>;
  blockedByReverse: Map<string, string[]>;
} {
  const itemsById = new Map<string, ItemFrontMatter>();
  const childrenByParent = new Map<string, ItemFrontMatter[]>();
  const blockedByReverse = new Map<string, string[]>();
  for (const item of corpus) {
    itemsById.set(item.id, item);
    const parent = typeof item.parent === "string" ? item.parent.trim() : "";
    if (parent.length > 0) {
      const siblings = childrenByParent.get(parent) ?? [];
      siblings.push(item);
      childrenByParent.set(parent, siblings);
    }
    for (const blockerId of collectBlockedByIds(item)) {
      const dependents = blockedByReverse.get(blockerId) ?? [];
      dependents.push(item.id);
      blockedByReverse.set(blockerId, dependents);
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
  candidates: ItemFrontMatter[],
  corpus: ItemFrontMatter[],
  statusRegistry: RuntimeStatusRegistry,
): ActionabilityReport {
  const { itemsById, childrenByParent, blockedByReverse } = indexCorpus(corpus);
  const activeStatuses = resolveActiveStatusSet(statusRegistry);
  // Ids of corpus items still in flight, used to keep only the non-terminal
  // dependents in each item's downstream "unblocks" list.
  const nonTerminalIds = new Set(
    corpus.filter((entry) => !isTerminalStatus(entry.status, statusRegistry)).map((entry) => entry.id),
  );
  const ready: ActionableEntry[] = [];
  const blocked: ActionableEntry[] = [];
  let activeCount = 0;
  let containerCount = 0;
  for (const item of candidates) {
    if (!activeStatuses.has(normalizeStatusForRegistry(item.status, statusRegistry))) continue;
    activeCount += 1;
    const openChildren = countOpenDescendants(item.id, childrenByParent, statusRegistry);
    if (openChildren > 0) {
      containerCount += 1;
      continue;
    }
    const openBlockers = resolveItemBlockers(item, itemsById, statusRegistry).filter((blocker) => !blocker.resolved);
    const unblocks = (blockedByReverse.get(item.id) ?? [])
      .filter((dependentId) => nonTerminalIds.has(dependentId))
      .sort((left, right) => left.localeCompare(right));
    const entry: ActionableEntry = { item, open_blockers: openBlockers, open_children: 0, unblocks };
    if (openBlockers.length === 0) {
      ready.push(entry);
    } else {
      blocked.push(entry);
    }
  }
  return { ready, blocked, active_count: activeCount, container_count: containerCount };
}
