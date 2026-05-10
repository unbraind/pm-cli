# SDK Contracts Consumer Example

This example shows how to consume `pm` contracts programmatically in a script and validate action payload requirements before execution.

## Files

- `package.json` -> installs `@unbrained/pm-cli` and script aliases
- `inspect-contracts.mjs` -> loads contracts + SDK helpers and prints required/optional parameter metadata

## Run

```bash
cp -R docs/examples/sdk-contract-consumer /tmp/pm-sdk-contract-consumer
cd /tmp/pm-sdk-contract-consumer
# Local checkout (recommended while iterating on unreleased SDK changes):
npm install /home/steve/GITHUB_RELEASE/pm-cli

# Or use a published release once available:
# npm install @unbrained/pm-cli@latest

node inspect-contracts.mjs create
```

Expected output shape:

```json
{
  "action": "create",
  "required_parameters": ["title", "description", "type", "status", "priority", "message"],
  "optional_parameters": ["template", "createMode", "schedulePreset"],
  "any_of_required_groups": []
}
```

You can inspect any action:

```bash
node inspect-contracts.mjs update
node inspect-contracts.mjs extension
```

## Why This Pattern Works

- Uses `isPmToolAction()` for strict action validation.
- Uses `PM_TOOL_ACTION_PARAMETER_CONTRACTS` for deterministic required/optional metadata.
- Uses runtime `pm contracts --json` so extension-provided actions and command availability are reflected.
