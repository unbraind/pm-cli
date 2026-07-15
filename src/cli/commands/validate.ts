/**
 * @module cli/commands/validate
 *
 * Compatibility adapter for the SDK-owned governance validation engine.
 */
import { runValidate as runSdkValidate } from "../../sdk/governance/validate.js";
import { runUpdate } from "./update.js";

export * from "../../sdk/governance/validate.js";

/** Run SDK validation with the CLI's canonical audited update mutation service. */
export const runValidate = (
  options: Parameters<typeof runSdkValidate>[0],
  global: Parameters<typeof runSdkValidate>[1],
) =>
  runSdkValidate(options, global, {
    runUpdate: (id, updateOptions, updateGlobal) =>
      runUpdate(id, updateOptions, updateGlobal),
  });
