# Policy-Restricted Extension Example

This example demonstrates governance policy behavior with real registrations.

It is authored **and loaded** as TypeScript (ADR pm-2c28 / pm-m1uz): `index.ts` is
both the source and the manifest `entry`, imported directly via Node's native type
stripping — there is no compile step and no committed `index.js`. Edit `index.ts`
and the change takes effect on the next install/reload; run `npx tsc --noEmit` to
type-check.

The extension declares:

- `commands` (handler registration)
- `hooks` (beforeCommand)
- `services` (output_format override)

You can enforce policy so command/hooks remain allowed while service override is blocked.

## Run It

From repository root:

```bash
mkdir -p .agents/pm/extensions
cp -R docs/examples/policy-restricted-extension .agents/pm/extensions/policy-restricted-extension
cd .agents/pm/extensions/policy-restricted-extension
npm install
cd -
pm extension --install --project .agents/pm/extensions/policy-restricted-extension
```

Add policy in `.agents/pm/settings.json`:

```json
{
  "extensions": {
    "policy": {
      "mode": "enforce",
      "trust_mode": "enforce",
      "require_provenance": true,
      "trusted_extensions": ["policy-restricted-extension"],
      "default_sandbox_profile": "restricted",
      "allowed_extensions": ["policy-restricted-extension"],
      "blocked_extensions": [],
      "allowed_capabilities": [],
      "blocked_capabilities": [],
      "allowed_surfaces": [],
      "blocked_surfaces": ["services.override"],
      "allowed_commands": [],
      "blocked_commands": [],
      "allowed_actions": [],
      "blocked_actions": [],
      "allowed_services": [],
      "blocked_services": ["output_format"],
      "extension_overrides": [
        {
          "name": "policy-restricted-extension",
          "require_trusted": true,
          "require_provenance": true,
          "sandbox_profile": "strict"
        }
      ]
    }
  }
}
```

Then validate:

```bash
pm extension --doctor --project --detail summary
pm policy demo
```

Expected behavior:

- `pm policy demo` still works (command handler allowed).
- `extension --doctor` includes `extension_policy_blocked_registration`.
- `details.triage.policy_blocked_count` is greater than `0`.
- trust/provenance contract fields are visible in `pm contracts --json` metadata.
