/**
 * @module cli/commands/lifecycle/update
 *
 * Compatibility export for the SDK-owned update lifecycle operation.
 */
export * from "../../../sdk/lifecycle/update.js";
import { runUpdate as runSdkUpdate, type UpdateCommandOptions } from "../../../sdk/lifecycle/update.js";
import { withCliMutationInput, type GlobalOptions } from "../../../sdk/runtime-primitives.js";

/** Decode CLI sentinel syntax only for command-adapter calls. */
export function runUpdate(id: string, options: UpdateCommandOptions, global: GlobalOptions) {
  return runSdkUpdate(id, withCliMutationInput(options), global);
}
