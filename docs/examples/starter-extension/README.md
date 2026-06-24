# Starter Extension (Runnable Example)

This example is a full capability reference extension. It intentionally demonstrates every extension capability surface, including parser/preflight/services/search/schema hooks.

Use it to learn APIs, then narrow capabilities for production extensions.

## Contents

- `manifest.json` -> extension metadata/capabilities (the `entry` points at `index.ts`)
- `package.json` -> local dependency metadata
- `index.ts` -> TypeScript source AND the manifest entry the loader imports directly

## Authoring (TypeScript-first)

Per ADR pm-2c28 / pm-m1uz, pm extensions are authored **and loaded** as TypeScript:
`index.ts` is both the source and the manifest `entry`, and pm imports it directly
via Node's native type stripping (Node >=22.18) — there is no compile step and no
committed `index.js`, exactly like the first-party `packages/pm-*` extensions. Copy
this example and run it as-is; after editing `index.ts` the change takes effect on
the next install/reload. Run `npx tsc --noEmit` to type-check, or scaffold a new
extension via `pm extension init`. Typing only `activate(api: ExtensionApi)` is
enough for every nested handler's `context` to be inferred from the SDK
registration contracts.

## End-to-End Run

From repository root:

```bash
# 1) Copy into project extension root
mkdir -p .agents/pm/extensions
cp -R docs/examples/starter-extension .agents/pm/extensions/starter-extension

# 2) Install dependencies for the copied extension
cd .agents/pm/extensions/starter-extension
npm install
cd -

# 3) Install/activate in project scope
pm extension --install --project .agents/pm/extensions/starter-extension

# 4) Run a starter command
pm starter ping --name "agent"

# 5) Reload extension modules after edits
pm extension --reload --project

# 6) Optional watch-mode semantics
pm extension --reload --project --watch

# 7) Verify runtime health
pm extension --doctor --project --detail summary
```

Expected outcomes:

- `pm starter ping` returns deterministic output (plain text when starter service overrides output formatting).
- `extension --doctor` shows `details.summary.status` as `ok` or `warn`.
- If `warn`, inspect `details.summary.warning_codes` and `details.triage.remediation`.
- `extension --reload` returns deterministic load/activation diagnostics for cache-busted imports.

## Policy-Restricted Variant

To test governance controls with this extension:

1. Set `settings.extensions.policy.mode` to `warn` or `enforce`.
2. Block one surface (for example `commands.override`).
3. Re-run `pm extension --doctor --detail summary`.

You should see `extension_policy_*` warnings and policy counters in `details.triage`.

## CI-Friendly Verification Commands

```bash
pm contracts --command extension --flags-only --json
pm extension --doctor --project --detail summary --strict-exit
node scripts/run-tests.mjs test -- tests/unit/extension-loader.spec.ts tests/unit/extension-command.spec.ts
```

## Notes

- Keep production manifests minimal: only declare capabilities you need.
- Prefer command metadata (`action`, `examples`, `failure_hints`) for machine+human diagnostics.
- Keep parser/preflight/service overrides narrow and deterministic.

## Related Examples

- `docs/examples/policy-restricted-extension/README.md`
- `docs/examples/sdk-contract-consumer/README.md`
