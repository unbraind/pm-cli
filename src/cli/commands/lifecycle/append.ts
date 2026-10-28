/** @module cli/commands/lifecycle/append Compatibility export for the SDK-owned append lifecycle operation. */
export * from "../../../sdk/lifecycle/append.js";
import { runAppend as runSdkAppend, type AppendCommandOptions } from "../../../sdk/lifecycle/append.js";
import { withCliMutationInput, type GlobalOptions } from "../../../sdk/runtime-primitives.js";

/** Decode CLI sentinel syntax only for command-adapter calls. */
export function runAppend(id: string, options: AppendCommandOptions, global: GlobalOptions) {
  return runSdkAppend(id, withCliMutationInput(options), global);
}
