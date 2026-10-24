/**
 * @module core/checkpoint/mutation-context
 *
 * Binds committed item effects to their bulk checkpoint without changing
 * user-provided history messages or attributing another item's side effects.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

interface CheckpointMutationContext {
  pmRoot: string;
  itemId: string;
  checkpointId: string;
}

const checkpointContext = new AsyncLocalStorage<CheckpointMutationContext>();

/** Carry checkpoint identity through nested lifecycle writers in this async operation only. */
export function withCheckpointMutation<T>(context: CheckpointMutationContext, operation: () => Promise<T>): Promise<T> {
  return checkpointContext.run({ ...context, pmRoot: path.resolve(context.pmRoot) }, operation);
}

/** Read checkpoint attribution only for the matching tracker and item at commit time. */
export function checkpointMutationHistoryContext(pmRoot: string, itemId: string): Record<string, unknown> | undefined {
  const context = checkpointContext.getStore();
  return context?.pmRoot === path.resolve(pmRoot) && context.itemId === itemId
    ? { bulk_checkpoint: context.checkpointId }
    : undefined;
}
