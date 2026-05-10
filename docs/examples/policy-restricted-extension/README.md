# Policy-Restricted Extension Example

This example demonstrates governance policy behavior with real registrations.

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
      "allowed_extensions": ["policy-restricted-extension"],
      "blocked_extensions": [],
      "allowed_capabilities": [],
      "blocked_capabilities": [],
      "allowed_surfaces": [],
      "blocked_surfaces": ["services.override"],
      "extension_overrides": []
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
