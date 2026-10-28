/**
 * @module cli/commands/lifecycle/create
 *
 * Compatibility export for the SDK-owned create lifecycle operation.
 */
export * from "../../../sdk/lifecycle/create.js";
import { runCreate as runSdkCreate, type CreateCommandOptions } from "../../../sdk/lifecycle/create.js";
import { withCliMutationInput, type GlobalOptions } from "../../../sdk/runtime-primitives.js";

/** Decode CLI sentinel syntax only for command-adapter calls. */
export function runCreate(options: CreateCommandOptions, global: GlobalOptions) {
  return runSdkCreate(withCliMutationInput(options), global);
}
