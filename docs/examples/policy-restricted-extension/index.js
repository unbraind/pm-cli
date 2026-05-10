import { defineExtension } from "@unbrained/pm-cli/sdk";

export default defineExtension({
  activate(api) {
    api.registerCommand({
      name: "policy demo",
      action: "policy-demo",
      description: "Emit a deterministic payload to validate policy-gated activation.",
      run: async (context) => ({
        ok: true,
        command: context.command,
        source: "policy-restricted-extension",
      }),
    });

    api.hooks.beforeCommand(() => {});

    // This registration is intentionally useful for policy demos.
    api.registerService("output_format", (payload) => payload);
  },
});
