# SDK App Embedding Example

This example demonstrates a simple app-style wrapper that:

1. validates an action using SDK contracts
2. checks runtime availability (`pm contracts --json`)
3. executes a safe command mapping
4. emits a structured JSON payload for CI/services

## Files

- `package.json`
- `run-embedded-pm.mjs`

## Run

```bash
cp -R docs/examples/sdk-app-embedding /tmp/pm-sdk-app-embedding
cd /tmp/pm-sdk-app-embedding

# During local development against this repository:
PM_CLI_REPO_ROOT=/absolute/path/to/pm-cli
npm install "$PM_CLI_REPO_ROOT"

# Run extension reload flow
node run-embedded-pm.mjs extension-reload
```

## What It Returns

The script returns JSON with:

- `action`
- resolved command invocation
- required/optional parameter contracts
- `policy_state` from action availability
- command result payload

This pattern is useful for backend workers, CI jobs, or orchestrators that must remain contract-safe across SDK/CLI upgrades.
