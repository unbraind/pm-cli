/** @module cli/commands/lifecycle/update-many Compatibility export for the SDK-owned bulk update operation. */
export * from "../../../sdk/lifecycle/update-many.js";
import { runUpdateMany as runSdkUpdateMany, type UpdateManyCommandOptions } from "../../../sdk/lifecycle/update-many.js";
import { withCliMutationInput, type GlobalOptions } from "../../../sdk/runtime-primitives.js";

/** Retain the CLI mutation grammar for each bulk update's shared options. */
export function runUpdateMany(options: UpdateManyCommandOptions, global: GlobalOptions) {
  const update = withCliMutationInput(options.update);
  return runSdkUpdateMany({ ...options, update }, global);
}
