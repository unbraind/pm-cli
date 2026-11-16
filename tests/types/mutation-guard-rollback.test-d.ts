/** Guard test helpers keep their void contract for ordinary writes and resolve overrides for rollbacks (pm-wb6ktl). */
import type { ExtensionHookRegistry } from "../../src/core/extensions/extension-types.js";
import type { ExtensionTestHarness, MutationGuardOverride, MutationGuardTestContext } from "../../src/sdk/testing.js";
import { runRegisteredMutationGuardForTest } from "../../src/sdk/testing.js";
declare const hooks: ExtensionHookRegistry;
declare const harness: ExtensionTestHarness;
declare const context: MutationGuardTestContext;
const compensation = { transaction_id: "transaction", step_id: "step" };
// A Promise<void> utility can still return the helper for an ordinary context.
async function ordinary(): Promise<void> {
  return runRegisteredMutationGuardForTest(hooks, { context });
}
async function ordinaryHarness(): Promise<void> {
  return harness.runMutationGuard({ context });
}
const rollback: Promise<MutationGuardOverride[]> = runRegisteredMutationGuardForTest(hooks, { context: { ...context, compensation } });
const harnessRollback: Promise<MutationGuardOverride[]> = harness.runMutationGuard({ context: { ...context, compensation } });
void [ordinary, ordinaryHarness, rollback, harnessRollback];
// @ts-expect-error An ordinary context resolves no override list.
const misread: Promise<MutationGuardOverride[]> = runRegisteredMutationGuardForTest(hooks, { context });
void misread;
