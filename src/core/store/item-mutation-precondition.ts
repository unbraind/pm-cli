/**
 * @module core/store/item-mutation-precondition
 *
 * Carries transaction preconditions into the item store so checks observe the
 * same locked document that will be mutated.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import type { ItemDocument } from "../../types/index.js";

interface ItemMutationPrecondition {
  pmRoot: string;
  id: string;
  validate: (document: ItemDocument) => void;
  /** Advance the guard only after this operation durably commits under the item lock. */
  committed?: (document: ItemDocument) => void;
  /** Immutable attribution for every internal write to this target. */
  historyContext?: Record<string, unknown>;
}

const preconditions = new AsyncLocalStorage<readonly ItemMutationPrecondition[]>();

/** Scope a target-specific precondition to an awaited mutation without affecting concurrent callers. */
export function runWithItemMutationPrecondition<T>(
  condition: ItemMutationPrecondition,
  operation: () => Promise<T>,
): Promise<T> {
  return preconditions.run(
    [...(preconditions.getStore() ?? []), { ...condition, pmRoot: path.resolve(condition.pmRoot) }],
    operation,
  );
}

/** Evaluate matching preconditions only after the item lock has been acquired and its document read. */
export function assertItemMutationPreconditions(pmRoot: string, document: ItemDocument): void {
  for (const condition of preconditions.getStore() ?? []) {
    if (condition.pmRoot === path.resolve(pmRoot) && condition.id === document.metadata.id) {
      condition.validate(document);
    }
  }
}

/** Notify matching scoped guards of their own committed document before releasing the item lock. */
export function advanceItemMutationPreconditions(pmRoot: string, document: ItemDocument): void {
  for (const condition of preconditions.getStore() ?? []) {
    if (condition.pmRoot === path.resolve(pmRoot) && condition.id === document.metadata.id) {
      condition.committed?.(document);
    }
  }
}

/** Collect target-scoped immutable attribution without attributing another caller's writes. */
export function itemMutationPreconditionHistoryContext(pmRoot: string, document: ItemDocument): Record<string, unknown> {
  return Object.assign({}, ...(preconditions.getStore() ?? [])
    .filter((condition) => condition.pmRoot === path.resolve(pmRoot) && condition.id === document.metadata.id)
    .map((condition) => condition.historyContext));
}
