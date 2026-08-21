/**
 * @module sdk/lifecycle/hierarchy-mutation-lock
 *
 * Serializes hierarchy-affecting create and update transactions so each
 * before/after integrity decision is made from a fresh workspace snapshot.
 */
import { acquireLock } from "../../core/lock/lock.js";

const HIERARCHY_MUTATION_LOCK_ID = "hierarchy-integrity";

/** Inputs for the internal workspace-wide hierarchy mutation lock. */
export interface HierarchyMutationLockOptions {
  /** Tracker root whose hierarchy is being changed. */
  pmRoot: string;
  /** Principal recorded as the lock owner. */
  author: string;
  /** Tracker-configured stale-lock lifetime. */
  ttlSeconds: number;
  /** Tracker-configured bounded lock wait. */
  waitMs: number;
  /** Whether this mutation can add hierarchy evidence. */
  required: boolean;
}

/** Acquire the shared hierarchy writer lock, or return a no-op release. */
export async function acquireHierarchyMutationLock(
  options: HierarchyMutationLockOptions,
): Promise<() => Promise<void>> {
  const release = options.required
    ? await acquireLock(
        options.pmRoot,
        HIERARCHY_MUTATION_LOCK_ID,
        options.ttlSeconds,
        options.author,
        false,
        false,
        options.waitMs,
      )
    : async () => {};
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await release();
  };
}
