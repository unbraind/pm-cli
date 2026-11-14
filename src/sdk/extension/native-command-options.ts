/**
 * @module sdk/extension/native-command-options
 *
 * Whether an extension command path is also a native command (pm-gh1727). An
 * extension may extend or override a native command (`list`); there the
 * native contract (aliases, negated flags, settings-dependent runtime fields)
 * owns every key the extension does not declare, so the direct-caller option
 * normalizer keeps passing those keys through instead of refusing them.
 */
import { isCoreCommandPath } from "../cli-contracts/runtime-contracts.js";
import type { DirectExtensionOptionPolicy } from "./command-options.js";

/**
 * The direct-caller undeclared-key policy for a command path: pass on a path
 * core itself registers, refuse on an extension-created one. Package-owned
 * compatibility paths (`calendar`, `guide`, `completion`) carry legacy flag
 * contracts but are created by packages, so they refuse (Codex review round 8).
 */
export function resolveDirectExtensionOptionPolicy(commandPath: string): DirectExtensionOptionPolicy {
  return { undeclaredKeys: isCoreCommandPath(commandPath) ? "pass" : "refuse" };
}
