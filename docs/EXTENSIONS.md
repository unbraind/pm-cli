# Extensions

Extensions let you add or override `pm` runtime behavior without editing core `pm-cli` sources. They are loaded at runtime, gated by manifest capabilities, and now support granular governance policies for capability/surface allow/block controls.

## Quick Start

```bash
# 1) Scaffold a new extension
pm extension --init ./my-extension

# 2) Install into project scope
pm extension --install --project ./my-extension

# 3) Run extension diagnostics
pm extension --doctor --project --detail summary

# 4) Deep diagnostics with traces
pm extension --doctor --project --detail deep --trace
```

Expected summary signals from `extension --doctor`:

- `details.summary.status`: `ok` or `warn`
- `details.summary.warning_codes`: deterministic warning code list
- `details.summary.policy`: active policy mode and configured counts
- `details.triage.remediation`: actionable follow-up guidance

## Extension Locations and Precedence

- Project extensions: `.agents/pm/extensions/<name>/`
- Global extensions: `~/.pm-cli/extensions/<name>/`
- Project takes precedence when both scopes register the same command/surface.
- Discovery and activation remain deterministic across runs.

Environment overrides:

- `PM_PATH`: project tracker root override
- `PM_GLOBAL_PATH`: global profile root override

## Manifest and Capabilities

Minimal `manifest.json`:

```json
{
  "name": "pm-ext-example",
  "version": "0.1.0",
  "entry": "./index.js",
  "priority": 100,
  "capabilities": ["commands"]
}
```

Rules:

- `entry` must resolve inside extension directory (symlink-safe canonical checks apply).
- Declare only capabilities actually used.
- Unknown capabilities produce deterministic warnings with guidance.
- Legacy aliases (`migration`, `validation`) are remapped to `schema` with guidance warnings.

Supported capabilities:

- `commands`
- `parser`
- `preflight`
- `services`
- `renderers`
- `hooks`
- `schema`
- `importers`
- `search`

## Governance Policy (Granular Controls)

Extension governance policy is configured in `settings.json` under `extensions.policy`.

Policy modes:

- `off`: no policy enforcement/warnings
- `warn`: allow registrations but emit policy violation warnings
- `enforce`: block disallowed extensions/capabilities/surfaces

Example policy:

```json
{
  "extensions": {
    "policy": {
      "mode": "enforce",
      "allowed_extensions": ["release-audit-ext"],
      "blocked_extensions": [],
      "allowed_capabilities": [],
      "blocked_capabilities": ["services"],
      "allowed_surfaces": [],
      "blocked_surfaces": ["commands.override"],
      "extension_overrides": [
        {
          "name": "release-audit-ext",
          "allowed_surfaces": ["commands.handler", "hooks.beforecommand"],
          "blocked_surfaces": ["services.override"]
        }
      ]
    }
  }
}
```

### Surface Tokens

Use these exact values for `allowed_surfaces` / `blocked_surfaces`:

- `commands.override`
- `commands.handler`
- `hooks.beforecommand`
- `hooks.aftercommand`
- `hooks.onwrite`
- `hooks.onread`
- `hooks.onindex`
- `schema.flags`
- `schema.itemfields`
- `schema.itemtypes`
- `schema.migrations`
- `parser.override`
- `preflight.override`
- `services.override`
- `renderers.override`
- `importers.importer`
- `importers.exporter`
- `search.provider`
- `search.vectorstore`

Policy diagnostics use deterministic warning codes:

- `extension_policy_violation_extension`
- `extension_policy_violation_capability`
- `extension_policy_violation_registration`
- `extension_policy_blocked_extension`
- `extension_policy_blocked_capability`
- `extension_policy_blocked_registration`

## Runtime APIs (Public SDK)

Use `@unbrained/pm-cli/sdk` only (no internal imports).

- `api.registerCommand(def)` -> `commands`
- `api.registerParser(command, fn)` -> `parser`
- `api.registerPreflight(fn)` -> `preflight`
- `api.registerService(name, fn)` -> `services`
- `api.registerRenderer(format, fn)` -> `renderers`
- `api.registerFlags(command, flags)` -> `schema`
- `api.registerItemFields(fields)` -> `schema`
- `api.registerItemTypes(types)` -> `schema`
- `api.registerMigration(def)` -> `schema`
- `api.registerImporter(name, fn)` -> `importers`
- `api.registerExporter(name, fn)` -> `importers`
- `api.registerSearchProvider(provider)` -> `search`
- `api.registerVectorStoreAdapter(adapter)` -> `search`
- `api.hooks.beforeCommand/afterCommand/onWrite/onRead/onIndex(fn)` -> `hooks`

## Lifecycle Commands

```bash
# Explore
pm extension --explore --project

# Manage (update checks + managed state diagnostics)
pm extension --manage --project

# Optional runtime probe parity in manage mode
pm extension --manage --project --runtime-probe

# Auto-adopt unmanaged extensions into managed state
pm extension --manage --project --fix-managed-state

# Activation/deactivation
pm extension --activate my-extension --project
pm extension --deactivate my-extension --project

# Uninstall
pm extension --uninstall my-extension --project
```

## Non-Interactive Automation Patterns

For CI/CD and agents:

- Prefer `--json` outputs.
- Use `pm contracts --schema-only --json` before invoking action payloads.
- Run `pm extension --doctor --detail summary --strict-exit` as a gate.
- Add `--detail deep --trace` on failure paths for remediation payloads.
- Use `--no-extensions` as a deterministic fallback for core-only triage.

## Runnable Examples

- Full starter extension: `docs/examples/starter-extension/`
- Capability-restricted policy example: `docs/examples/policy-restricted-extension/`
- Programmatic contracts consumer: `docs/examples/sdk-contract-consumer/`
- CI gating workflow: `docs/examples/ci/github-actions-pm-extension-gate.yml`

## Troubleshooting

- Manifest/entry failures: run `pm extension --explore --project`
- Activation failures: run `pm extension --doctor --detail deep --trace`
- Policy blocks: review `settings.extensions.policy` and `details.summary.policy`
- Runtime drift suspicion: compare with `pm --no-extensions <command>`
- Managed-state update-check gaps: run `pm extension --manage --fix-managed-state`

## Related Docs

- `docs/SDK.md`
- `docs/examples/starter-extension/README.md`
- `docs/CLAUDE_CODE_PLUGIN.md`
# Extensions

Extensions add commands, schema, renderers, importers/exporters, search adapters, lifecycle hooks, and selected runtime overrides without modifying core `pm-cli`.

## Agent Quick Context

- Use `pm extension init ./my-extension` for a starter scaffold.
- Use `@unbrained/pm-cli/sdk` for public extension APIs.
- Declare only the capabilities your extension uses.
- Run `pm extension doctor --detail deep --trace` for activation failures.
- Use `--no-extensions` to isolate core behavior during incident triage.
- Use `pm guide extensions --depth standard` for local docs routing.

Tracked documentation work: [pm-1sb2](../.agents/pm/tasks/pm-1sb2.toon).

## Extension Locations

| Scope | Path |
|-------|------|
| Project | `.agents/pm/extensions/<name>/` |
| Global | `~/.pm-cli/extensions/<name>/` |

Environment overrides:

- `PM_PATH` changes project tracker root.
- `PM_GLOBAL_PATH` changes global profile root.

Load order is global, then project. Project extensions take precedence when keys collide.

## Lifecycle Manager

Scaffold:

```bash
pm extension init ./my-extension
pm extension scaffold ./my-extension
```

Install:

```bash
pm extension install ./my-extension --project
pm extension install github.com/unbraind/pm-cli/.agents/pm/extensions/todos --project
pm extension --install --project todos
```

Inspect and manage:

```bash
pm extension explore --project
pm extension manage --project
pm extension doctor --detail summary
pm extension doctor --detail deep --trace
```

Activate and deactivate:

```bash
pm extension activate my-extension --project
pm extension deactivate my-extension --project
```

Adopt unmanaged extensions:

```bash
pm extension adopt my-extension --project
pm extension adopt-all --project
```

## Install Sources

`pm extension install` accepts:

- local directories
- GitHub HTTPS URLs
- `github.com/<owner>/<repo>[/path]`
- `--gh <owner>/<repo>[/path]`
- optional `--ref <branch|tag|sha>`

When a GitHub source omits a subpath, the installer accepts a repository root containing one extension manifest or exactly one extension under known extension roots.

## Manifest

Every extension has `manifest.json`:

```json
{
  "name": "pm-ext-example",
  "version": "0.1.0",
  "entry": "./index.js",
  "priority": 100,
  "capabilities": ["commands"]
}
```

Rules:

- `entry` must stay inside the extension directory.
- `capabilities` gates what the extension can register.
- Unknown capabilities emit guidance.
- Legacy capability aliases are normalized for compatibility with warnings.

Capability names:

- `commands`
- `parser`
- `preflight`
- `services`
- `renderers`
- `hooks`
- `schema`
- `importers`
- `search`

## Minimal Extension

`manifest.json`:

```json
{
  "name": "hello",
  "version": "0.1.0",
  "entry": "./index.js",
  "capabilities": ["commands"]
}
```

`index.js`:

```js
import { defineExtension } from "@unbrained/pm-cli/sdk";

export default defineExtension({
  activate(api) {
    api.registerCommand({
      name: "hello",
      description: "Print a deterministic hello payload.",
      intent: "verify extension command activation",
      examples: ["pm hello"],
      run: async () => ({ message: "hello" }),
    });
  },
});
```

Run:

```bash
pm extension install ./hello --project
pm hello
```

## API Reference

Use [SDK](SDK.md) for typed examples. Runtime APIs include:

| API | Capability | Purpose |
|-----|------------|---------|
| `api.registerCommand(def)` | `commands` | add or replace command handlers |
| `api.registerParser(command, fn)` | `parser` | normalize args/options before dispatch |
| `api.registerPreflight(fn)` | `preflight` | influence mutation gate decisions |
| `api.registerService(name, fn)` | `services` | replace selected runtime services |
| `api.registerRenderer(format, fn)` | `renderers` | override TOON or JSON output |
| `api.registerImporter(name, fn)` | `importers` | add `<name> import` |
| `api.registerExporter(name, fn)` | `importers` | add `<name> export` |
| `api.registerFlags(command, flags)` | `schema` | describe dynamic command flags |
| `api.registerItemFields(fields)` | `schema` | add item metadata fields |
| `api.registerItemTypes(types)` | `schema` | add custom item types |
| `api.registerMigration(def)` | `schema` | add schema migrations |
| `api.registerSearchProvider(provider)` | `search` | add search provider |
| `api.registerVectorStoreAdapter(adapter)` | `search` | add vector adapter |
| `api.hooks.beforeCommand(fn)` | `hooks` | run before commands |
| `api.hooks.afterCommand(fn)` | `hooks` | run after commands |
| `api.hooks.onWrite(fn)` | `hooks` | observe writes |
| `api.hooks.onRead(fn)` | `hooks` | observe reads |
| `api.hooks.onIndex(fn)` | `hooks` | observe index operations |

## Command Metadata

Dynamic commands should include human and machine metadata:

```js
api.registerCommand({
  name: "acme sync",
  action: "acme-sync",
  description: "Synchronize ACME records into pm items.",
  intent: "run deterministic import before release prep",
  examples: ["pm acme sync --source ./records.json --dry-run"],
  failure_hints: ["Ensure --source points to readable JSON."],
  flags: [
    { long: "--source", value_name: "path", description: "Input file path", required: true },
    { long: "--dry-run", description: "Preview without writing", type: "boolean" }
  ],
  run: async (context) => ({ ok: true, args: context.args }),
});
```

Inline command flags require both `commands` and `schema` capabilities.

## Service and Preflight Safety

`parser`, `preflight`, and `services` are powerful. They can change command input, mutation gates, output formatting, lock behavior, history appends, and item-store writes. Only enable these capabilities for reviewed extensions.

For troubleshooting:

```bash
pm --no-extensions list-open
pm extension doctor --detail deep --trace
pm health --check-only
```

## Bundled Managed Extensions

`pm-cli` ships bundled extension sources that are not auto-installed:

| Alias | Commands after install | Purpose |
|-------|------------------------|---------|
| `beads` | `pm beads import` | import Beads JSONL records |
| `todos` | `pm todos import`, `pm todos export` | round-trip todos markdown format |

Install:

```bash
pm extension --install --project beads
pm extension --install --project todos
```

## Starter Extension

See [examples/starter-extension](examples/starter-extension/README.md) for a compact extension that demonstrates all capability categories through the public SDK.

## Pi Wrapper

The Pi wrapper source is `.pi/extensions/pm-cli/index.ts`. It is an agent wrapper, not a runtime extension managed by `pm extension`.

Use [AGENTS.md](../AGENTS.md) for repository-specific Pi wrapper operating rules.
