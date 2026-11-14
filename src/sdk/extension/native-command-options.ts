/**
 * @module sdk/extension/native-command-options
 *
 * Whether an extension command path is also a native command (pm-gh1727). An
 * extension may extend or override a native command (`list`); there the
 * native contract (aliases, negated flags, settings-dependent runtime fields)
 * owns every key the extension does not declare, so the direct-caller option
 * normalizer keeps passing those keys through instead of refusing them.
 */
import { hasSubcommandFlagContractsForCommand } from "../cli-contracts/flag-contracts.js";
import type { DirectExtensionOptionPolicy } from "./command-options.js";

/** The direct-caller undeclared-key policy for a command path: pass on a native path, refuse on an extension-created one. */
export function resolveDirectExtensionOptionPolicy(commandPath: string): DirectExtensionOptionPolicy {
  return { undeclaredKeys: hasSubcommandFlagContractsForCommand(commandPath) ? "pass" : "refuse" };
}
