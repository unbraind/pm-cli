/**
 * Runtime contracts and behavior for packages/pm lifecycle hooks/extensions/lifecycle hooks/index.
 *
 * @module packages/pm-lifecycle-hooks/extensions/lifecycle-hooks/index
 */
import type { ExtensionApi } from "@unbrained/pm-cli/sdk";

/** Declarative package manifest consumed by the extension loader. */
export const manifest = {
  name: "builtin-lifecycle-hooks",
  version: "0.1.0",
  entry: "./index.js",
  priority: 0,
  capabilities: ["hooks"],
};

/** Registers this package's commands, actions, and runtime hooks with the host. */
export function activate(api: ExtensionApi): void {
  // First-party hooks exemplar: default-inert lifecycle observation with no
  // output, writes, or command-specific behavior.
  api.hooks.afterCommand(() => undefined);
}

export default {
  manifest,
  activate,
};
