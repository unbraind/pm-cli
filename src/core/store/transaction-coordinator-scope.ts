/**
 * @module core/store/transaction-coordinator-scope
 *
 * Marks the workspace-transaction coordinator's own compensation of one step,
 * carrying the step object it is compensating. A rollback exemption is granted
 * only when that object is a step the SDK built for the item, operation and
 * transaction being undone, so neither a direct call of a compensation helper
 * nor a caller-supplied step can claim it (pm-wb6ktl). Only the coordinator
 * opens this scope.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

interface CoordinatorCompensation {
  pmRoot: string;
  transactionId: string;
  step: object;
}

const coordinatorCompensation = new AsyncLocalStorage<CoordinatorCompensation>();

/** Run one step's compensation as the coordinator undoing that step of its journal. */
export function runAsCoordinatorCompensation<T>(compensation: CoordinatorCompensation, run: () => Promise<T>): Promise<T> {
  return coordinatorCompensation.run({ ...compensation, pmRoot: path.resolve(compensation.pmRoot) }, run);
}

/** The step the coordinator is compensating for this tracker and transaction, if any. */
export function activeCoordinatorStep(pmRoot: string, transactionId: string): object | undefined {
  const active = coordinatorCompensation.getStore();
  return active !== undefined && active.pmRoot === path.resolve(pmRoot) && active.transactionId === transactionId ? active.step : undefined;
}
