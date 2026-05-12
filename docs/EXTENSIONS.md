# Packages and Extensions

Packages let you add or override `pm` runtime behavior without modifying core `pm-cli` sources. A package can currently contain one or more runtime extensions, and the package-first command surface is the preferred user-facing workflow.

`pm extension ...` remains supported for compatibility. New scripts and docs should prefer `pm install ...` and `pm package ...`.

This document is the canonical package/extension reference for manifest contracts, governance policy, trust and sandbox controls, reload workflows, and diagnostics.

## Quick Start

```bash
# 1) Scaffold a package extension
pm package init ./my-package-extension

# 2) Install in project scope
pm install ./my-package --project

# Or install all bundled first-party packages
pm install '*' --project

# 3) Run diagnostics
pm package doctor --project --detail summary

# 4) Plan CLI/SDK and package upgrades
pm upgrade --dry-run

# 5) Reload runtime modules after local edits
pm package reload --project
```

Compatibility equivalents:

```bash
pm extension init ./my-package
pm extension install ./my-package --project
pm extension doctor --project --detail summary
pm extension reload --project
```

## Upgrade Workflow

`pm upgrade` is the package-first update entrypoint:

```bash
pm upgrade --dry-run              # plan CLI/SDK and project package updates
pm upgrade                        # update the global pm CLI/SDK, then refresh project packages
pm upgrade --packages-only        # refresh managed packages without changing the CLI
pm upgrade todos --dry-run        # plan one managed package refresh
pm upgrade --cli-only --repair    # force a global CLI/SDK reinstall through npm
```

CLI/SDK upgrades use `npm install -g @unbrained/pm-cli@<tag>`.
Managed package upgrades reuse the source recorded at install time, including `npm:`, GitHub, local, and first-party package paths.
Use `--tag <version-or-dist-tag>` to target a registry tag such as `latest` or `next`.

## Extension Locations

- project scope: `.agents/pm/extensions/<name>/`
- global scope: `~/.pm-cli/extensions/<name>/`
- project entries override global entries for matching command paths

Runtime path overrides:

- `PM_PATH`: project tracker root override
- `PM_GLOBAL_PATH`: global profile root override

## Package Sources

`pm install` accepts these package sources:

```bash
pm install ./local-package
pm install /absolute/path/to/package
pm install npm:@scope/package
pm install npm:package@1.2.3
pm install https://github.com/org/repo
pm install --github org/repo/path --ref main
```

Package roots can expose resources with a `pm` manifest in `package.json`:

```json
{
  "name": "my-pm-package",
  "keywords": ["pm-package"],
  "pm": {
    "extensions": ["extensions/my-extension"]
  }
}
```

The SDK exposes this project-management package model through `PM_PACKAGE_RESOURCE_KINDS`, `PM_PACKAGE_CONVENTIONAL_RESOURCE_ROOTS`, and `readPmPackageManifest`. Package installation activates runtime extension resources. Agent-specific bundles such as prompts, skills, and MCP servers should live in separate agent adapter packages rather than the core `pm` package contract.

When no manifest is present, `pm` discovers conventional extension directories:

- `.agents/pm/extensions/`
- `extensions/`
- `.custom/pm-extensions/`
- `.custom/pm-extension/`

If a package contains multiple extension manifests, install the exact extension path so the managed state has one deterministic package target.

First-party optional packages are shipped as package roots under `packages/`:

```bash
pm install '*' --project
pm install all --project
pm install packages/pm-beads --project
pm install packages/pm-todos --project
```

`pm install '*'` and `pm install all` install every bundled first-party package in deterministic alias order. If your shell expands `pm install *`, pm recognizes that expansion and treats it as the same bundled-package install-all request.

Compatibility aliases remain available:

```bash
pm install beads --project
pm install todos --project
```

Those aliases install package-shipped extension sources. They are then tracked in managed package state and can be refreshed with `pm upgrade --packages-only`.

## Manifest Contract

### Manifest v1 (supported)

```json
{
  "name": "my-ext",
  "version": "0.1.0",
  "entry": "./index.js",
  "priority": 100,
  "capabilities": ["commands"]
}
```

### Manifest v2 (recommended)

```json
{
  "name": "my-ext",
  "version": "0.2.0",
  "entry": "./index.js",
  "priority": 100,
  "manifest_version": 2,
  "trusted": true,
  "provenance": {
    "source": "github://org/repo/path",
    "verified": true
  },
  "sandbox_profile": "restricted",
  "permissions": {
    "fs_read": true,
    "fs_write": false,
    "network": false,
    "env_read": true,
    "env_write": false,
    "process_spawn": false
  },
  "capabilities": ["commands", "hooks"]
}
```

### Capability values

- `commands`
- `parser`
- `preflight`
- `services`
- `renderers`
- `hooks`
- `schema`
- `importers`
- `search`

## Governance Policy (`extensions.policy`)

Policy is configured in `settings.json` under `extensions.policy`.

```json
{
  "extensions": {
    "policy": {
      "mode": "enforce",
      "trust_mode": "warn",
      "require_provenance": true,
      "default_sandbox_profile": "restricted",
      "allowed_extensions": [],
      "blocked_extensions": [],
      "allowed_capabilities": [],
      "blocked_capabilities": ["services"],
      "allowed_surfaces": [],
      "blocked_surfaces": ["commands.override"],
      "allowed_commands": [],
      "blocked_commands": ["dangerous command"],
      "allowed_actions": [],
      "blocked_actions": ["dangerous-command"],
      "allowed_services": [],
      "blocked_services": ["output_format"]
    }
  }
}
```

Mode semantics:

- `mode`: `off|warn|enforce` for extension/capability/surface/command/action/service checks
- `trust_mode`: `off|warn|enforce` for trust checks
- `default_sandbox_profile`: `none|restricted|strict`

Sandbox profiles:

- `none`: no sandbox permission gating
- `restricted`: blocks sensitive writes and spawn (`process_spawn`, `env_write`)
- `strict`: blocks spawn/network/write style permissions (`process_spawn`, `network`, `fs_write`, `env_write`)

If profile is non-`none` and manifest permissions are missing, policy emits a deterministic warning or block.

## Supported Surface Tokens

Use these values with `allowed_surfaces` and `blocked_surfaces`:

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

## Reload and Watch Workflows

Manual reload:

```bash
pm extension --reload --project
```

Watch-mode semantics:

```bash
pm extension --reload --project --watch
```

In non-interactive automation, `--watch` performs a deterministic single-pass reload and emits a watch-hint warning.

## Diagnostics and Management

Basic diagnostics:

```bash
pm extension --doctor --project --detail summary
```

Deep diagnostics:

```bash
pm extension --doctor --project --detail deep --trace
```

Management commands:

```bash
pm package explore
pm package manage --project
pm package manage --project --runtime-probe
pm package manage --project --fix-managed-state
pm package activate my-extension --project
pm package deactivate my-extension --project
pm package uninstall my-extension --project
```

Common warning prefixes:

- `extension_policy_violation_extension`
- `extension_policy_violation_capability`
- `extension_policy_violation_registration`
- `extension_policy_violation_trust`
- `extension_policy_blocked_extension`
- `extension_policy_blocked_capability`
- `extension_policy_blocked_registration`
- `extension_policy_blocked_trust`

## Migration Checklist (v1 -> v2)

1. Keep existing manifest fields.
2. Add `manifest_version: 2`.
3. Add `trusted`, `provenance`, `sandbox_profile`, and `permissions`.
4. Extend `extensions.policy` with trust/sandbox and command/action/service controls.
5. Run:

```bash
pm contracts --json
pm package doctor --project --detail summary --strict-exit
```

6. Resolve warnings before enforcing `mode=enforce` and `trust_mode=enforce`.

## Runnable Examples

- `docs/examples/starter-extension/`
- `docs/examples/policy-restricted-extension/`
- `docs/examples/sdk-contract-consumer/`
- `docs/examples/sdk-app-embedding/`
- `docs/examples/ci/github-actions-pm-extension-gate.yml`
- `docs/examples/ci/gitlab-ci-pm-extension-gate.yml`
- `docs/examples/ci/jenkins-pm-extension-gate.Jenkinsfile`
# Extensions

Extensions let you add or override `pm` runtime behavior without modifying core `pm-cli`.

This guide is the authoritative reference for:

- manifest `v1` and `v2` contracts
- governance policy (`extensions.policy`) controls
- trust/provenance and sandbox restrictions
- manual reload and watch-mode workflows
- migration from policy-only setups to enterprise controls

## Quick Start

```bash
# 1) Scaffold an extension
pm extension --init ./my-extension

# 2) Install in project scope
pm extension --install --project ./my-extension

# 3) Run diagnostics
pm extension --doctor --project --detail summary

# 4) Reload runtime modules after local edits
pm extension --reload --project
```

## Delta From Previous Scope

Compared to the previous policy-only extension surface, this release adds:

- **Manifest v2 metadata** for trust, provenance, sandbox profile, and runtime permission declarations.
- **Policy v2 controls** for trust mode, provenance requirement, sandbox defaults, and command/action/service allow/block maps.
- **Registration enforcement upgrades** so command/action/service restrictions are evaluated at registration boundaries.
- **Hot reload controls** via cache-busted extension reload (`pm extension --reload`) with watch-mode semantics (`--watch`).
- **Contracts metadata upgrades** for trust/sandbox compatibility information in `pm contracts`.

## Extension Locations

- Project scope: `.agents/pm/extensions/<name>/`
- Global scope: `~/.pm-cli/extensions/<name>/`
- Project entries override global entries when command paths collide.

Overrides:

- `PM_PATH`: project tracker root override
- `PM_GLOBAL_PATH`: global profile root override

## Manifest Contract

### Manifest v1 (still supported)

```json
{
  "name": "my-ext",
  "version": "0.1.0",
  "entry": "./index.js",
  "priority": 100,
  "capabilities": ["commands"]
}
```

### Manifest v2 (recommended)

```json
{
  "name": "my-ext",
  "version": "0.2.0",
  "entry": "./index.js",
  "priority": 100,
  "manifest_version": 2,
  "trusted": true,
  "provenance": {
    "source": "github://org/repo/path",
    "verified": true
  },
  "sandbox_profile": "restricted",
  "permissions": {
    "fs_read": true,
    "fs_write": false,
    "network": false,
    "env_read": true,
    "env_write": false,
    "process_spawn": false
  },
  "capabilities": ["commands", "hooks"]
}
```

### Capability Values

- `commands`
- `parser`
- `preflight`
- `services`
- `renderers`
- `hooks`
- `schema`
- `importers`
- `search`

## Governance Policy v2

Policy is configured under `settings.json` -> `extensions.policy`.

```json
{
  "extensions": {
    "policy": {
      "mode": "enforce",
      "trust_mode": "warn",
      "require_provenance": true,
      "trusted_extensions": ["policy-restricted-extension"],
      "default_sandbox_profile": "restricted",
      "allowed_extensions": [],
      "blocked_extensions": [],
      "allowed_capabilities": [],
      "blocked_capabilities": ["services"],
      "allowed_surfaces": [],
      "blocked_surfaces": ["commands.override"],
      "allowed_commands": [],
      "blocked_commands": ["dangerous command"],
      "allowed_actions": [],
      "blocked_actions": ["dangerous-command"],
      "allowed_services": [],
      "blocked_services": ["output_format"],
      "extension_overrides": [
        {
          "name": "policy-restricted-extension",
          "require_trusted": true,
          "require_provenance": true,
          "sandbox_profile": "strict",
          "allowed_surfaces": ["commands.handler", "hooks.beforecommand"],
          "blocked_surfaces": ["services.override"]
        }
      ]
    }
  }
}
```

### Mode Semantics

- `mode`: `off|warn|enforce` for extension/capability/surface/command/action/service restrictions
- `trust_mode`: `off|warn|enforce` for trust checks
- `default_sandbox_profile`: `none|restricted|strict`

### Sandbox Profiles

Sandbox profiles are policy-driven gates evaluated against manifest permission declarations:

- `none`: no sandbox permission gating
- `restricted`: blocks sensitive writes/spawn (`process_spawn`, `env_write`)
- `strict`: blocks spawn/network/write-style permissions (`process_spawn`, `network`, `fs_write`, `env_write`)

If a non-`none` profile is active and manifest permissions are missing, a deterministic policy warning/block is emitted.

### Surface Tokens

Supported `allowed_surfaces` / `blocked_surfaces` values:

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

## Hot Reload

### Manual reload

```bash
pm extension --reload --project
```

This runs extension discovery/load with cache-busted import URLs and returns deterministic load/activation diagnostics.

### Watch mode

```bash
pm extension --reload --project --watch
```

`--watch` enables watch-mode semantics for reload workflows. In non-interactive automation, it executes a deterministic single-pass reload and emits a watch hint warning.

## Diagnostics and Warning Codes

Common warning prefixes:

- `extension_policy_violation_extension`
- `extension_policy_violation_capability`
- `extension_policy_violation_registration`
- `extension_policy_violation_trust`
- `extension_policy_blocked_extension`
- `extension_policy_blocked_capability`
- `extension_policy_blocked_registration`
- `extension_policy_blocked_trust`

Use:

```bash
pm extension --doctor --project --detail deep --trace
```

for full activation traces.

## Migration (v1 -> v2)

1. Keep existing manifest fields unchanged.
2. Add `manifest_version: 2`.
3. Add `trusted`, `provenance`, `sandbox_profile`, and `permissions`.
4. Extend `extensions.policy` with trust/sandbox/command-action-service fields.
5. Run:

```bash
pm contracts --json
pm extension --doctor --project --detail summary --strict-exit
```

6. Fix any policy warnings before enforcing (`mode=enforce`, `trust_mode=enforce`).

## Runnable Examples

- `docs/examples/starter-extension/`
- `docs/examples/policy-restricted-extension/`
- `docs/examples/sdk-contract-consumer/`
- `docs/examples/sdk-app-embedding/`
- `docs/examples/ci/github-actions-pm-extension-gate.yml`
- `docs/examples/ci/gitlab-ci-pm-extension-gate.yml`
- `docs/examples/ci/jenkins-pm-extension-gate.Jenkinsfile`
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
pm package install ./my-package --project
pm package install github.com/unbraind/pm-cli/packages/pm-todos --project
pm install todos --project
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

`pm-cli` ships optional first-party package roots that are not auto-installed:

| Alias | Commands after install | Purpose |
|-------|------------------------|---------|
| `beads` | `pm beads import` | import Beads JSONL records |
| `todos` | `pm todos import`, `pm todos export` | round-trip todos markdown format |

Install:

```bash
pm install beads --project
pm install todos --project
```

## Starter Extension

See [examples/starter-extension](examples/starter-extension/README.md) for a compact extension that demonstrates all capability categories through the public SDK.
