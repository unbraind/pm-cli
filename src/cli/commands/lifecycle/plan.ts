/**
 * @module cli/commands/lifecycle/plan
 *
 * Compatibility export for the SDK-owned planning lifecycle operation.
 */
export * from "../../../sdk/lifecycle/plan.js";
import { runPlan as runSdkPlan, type PlanDispatchInput } from "../../../sdk/lifecycle/plan.js";
import { withCliMutationInput } from "../../../sdk/runtime-primitives.js";

/** Retain CLI sentinel compatibility when plans compose the SDK create operation. */
export function runPlan(input: PlanDispatchInput) {
  const options = withCliMutationInput(input.options);
  return runSdkPlan({ ...input, options });
}
