/**
 * @module docs/examples/policy-restricted-extension
 *
 * Minimal TypeScript-first reference extension for governance-policy demos. It
 * registers exactly three surfaces — a command handler, a `beforeCommand` hook,
 * and an `output_format` service override — so an operator can enforce policy
 * that keeps the command and hook allowed while blocking the service override
 * (see the accompanying README).
 *
 * As with the starter example, the source is authored in TypeScript against the
 * published SDK types and is itself the `./index.ts` manifest entry the loader
 * imports directly via Node's native type stripping (ADR pm-2c28 / pm-m1uz) — no
 * compile step and no committed `.js`. Typing `activate(api: ExtensionApi)` is
 * enough for the service override's `context` parameter to be inferred as a
 * `ServiceOverrideContext`, which is why this handler returns `context.payload`
 * (the value to format) rather than the whole context object.
 */
import { defineExtension } from "@unbrained/pm-cli/sdk";
import type { ExtensionApi } from "@unbrained/pm-cli/sdk";

export default defineExtension({
  activate(api: ExtensionApi): void {
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

    // This registration is intentionally useful for policy demos: an identity
    // output_format override that returns the formatting payload unchanged.
    api.registerService("output_format", (context) => context.payload);
  },
});
