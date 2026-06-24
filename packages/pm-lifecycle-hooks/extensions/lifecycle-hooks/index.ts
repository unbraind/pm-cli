import type { ExtensionApi } from "@unbrained/pm-cli/sdk";

export const manifest = {
  name: "builtin-lifecycle-hooks",
  version: "0.1.0",
  entry: "./index.js",
  priority: 0,
  capabilities: ["hooks"],
};

export function activate(api: ExtensionApi): void {
  // First-party hooks exemplar: default-inert lifecycle observation with no
  // output, writes, or command-specific behavior.
  api.hooks.afterCommand(() => undefined);
}

export default {
  manifest,
  activate,
};
