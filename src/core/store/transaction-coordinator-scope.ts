/**
 * @module core/store/transaction-coordinator-scope
 *
 * Marks the workspace-transaction coordinator's own compensation of one step,
 * so a rollback exemption is granted only to the coordinator undoing a step of
 * its journal, never to a direct call of a compensation helper (pm-wb6ktl).
 * Only the coordinator opens this scope; nothing outside the store and SDK
 * transaction modules imports it.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

interface CoordinatorCompensationIdentity {
  pmRoot: string;
  transactionId: string;
  stepId: string;
}

const coordinatorCompensation = new AsyncLocalStorage<CoordinatorCompensationIdentity>();

/** Run one step's compensation as the coordinator undoing its own journal step. */
export function runAsCoordinatorCompensation<T>(identity: CoordinatorCompensationIdentity, run: () => Promise<T>): Promise<T> {
  return coordinatorCompensation.run({ ...identity, pmRoot: path.resolve(identity.pmRoot) }, run);
}

/** True only while the coordinator compensates exactly this transaction step on this tracker. */
export function isCoordinatorCompensating(pmRoot: string, transactionId: string, stepId: string): boolean {
  const active = coordinatorCompensation.getStore();
  return active !== undefined && active.pmRoot === path.resolve(pmRoot) && active.transactionId === transactionId && active.stepId === stepId;
}
