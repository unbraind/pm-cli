# Packages and Extensions

Packages add optional `pm` workflows without changing the core CLI. A package can ship one or more runtime extensions plus metadata such as docs and examples. Prefer the package-first commands in new docs and automation:

```bash
pm package init ./my-package
pm install ./my-package --project
pm package doctor --project --detail summary
pm package reload --project
pm upgrade --dry-run
```

`pm extension ...` remains supported for compatibility and low-level runtime debugging.

Related docs:

- [SDK](SDK.md)
- [Configuration](CONFIGURATION.md)
- [Testing](TESTING.md)
- [Command Reference](COMMANDS.md)

## Package Sources

`pm install` accepts local, registry, and GitHub sources:

```bash
pm install ./local-package --project
pm install /absolute/path/to/package --project
pm install npm:@scope/package --project
pm install npm:package@1.2.3 --project
pm install https://github.com/org/repo --project
pm install --github org/repo/path --ref main --project
```

Bundled first-party packages live under `packages/pm-*`:

```bash
pm package catalog --project
pm install '*' --project
pm install all --project
pm install calendar --project
pm install search-advanced --project
pm install governance-audit --project
```

`pm install '*'`, `pm install all`, and shell-expanded `pm install *` are normalized to the same bundled install-all request. First-party package aliases come from each package manifest, with a fallback derived from the `packages/pm-*` directory name.

External registry packages are installed by exact package name:

```bash
npm search "pm-cli pm-package"
pm install npm:pm-changelog --project
pm install npm:pm-github --project
pm package doctor --project --detail deep --trace
```

Prefer package-specific docs before invoking commands that require service credentials, such as GitHub, Jira, Linear, or Slack sync packages.

## Package Manifest

Package roots declare resources in `package.json` under `pm`:

```json
{
  "name": "my-pm-package",
  "keywords": ["pm-package"],
  "pm": {
    "aliases": ["my-workflow"],
    "extensions": ["."],
    "docs": ["README.md"],
    "examples": ["examples/basic.md"],
    "catalog": {
      "display_name": "My pm Package",
      "category": "workflow",
      "summary": "Adds a custom workflow to pm.",
      "tags": ["workflow"],
      "links": {
        "docs": "https://example.com/docs",
        "repository": "https://github.com/org/my-pm-package",
        "report": "https://github.com/org/my-pm-package/issues"
      }
    }
  }
}
```

Current resource kinds are:

- `extensions`
- `docs`
- `examples`

Installation activates `pm.extensions`. `pm.docs` and `pm.examples` are catalog metadata. Agent-specific assets such as prompts, skills, or MCP servers should live in agent adapter packages, not in the core `pm` package contract.

`pm package init` emits a root extension (`"extensions": ["."]`) so local package installs can activate without dependency bootstrapping. Larger packages may point at nested extension directories after declaring runtime dependencies and validating with `pm package doctor`.

When no package manifest is present, `pm` discovers conventional extension directories:

- `.agents/pm/extensions/`
- `extensions/`
- `.custom/pm-extensions/`
- `.custom/pm-extension/`

If a source contains multiple extension manifests, install the exact extension path so managed state has one deterministic target.

## Extension Layout

Project extensions are stored under `.agents/pm/extensions/<name>/`. Global extensions are stored under `~/.pm-cli/extensions/<name>/`. Project entries override global entries when they register the same command path or runtime surface.

Runtime path overrides:

- `PM_PATH`: project tracker root
- `PM_GLOBAL_PATH`: global profile root

A minimal standalone extension has a `manifest.json` and an import-free entrypoint. Standalone entries are loaded by file URL from the extension directory, so they should not import `@unbrained/pm-cli` unless the extension is installed as a package with its own dependencies.

```json
{
  "name": "hello",
  "version": "0.1.0",
  "entry": "./index.js",
  "manifest_version": 1,
  "pm_min_version": "2026.5.0",
  "pm_max_version": "2027.0.0",
  "capabilities": ["commands"]
}
```

```js
/** @param {import("@unbrained/pm-cli/sdk").ExtensionApi} api */
export function activate(api) {
  api.registerCommand({
    name: "hello",
    description: "Print a deterministic hello payload.",
    intent: "verify extension command activation",
    examples: ["pm hello"],
    run() {
      return { ok: true, message: "hello" };
    },
  });
}
```

Package-backed extensions can use the SDK helper after declaring `@unbrained/pm-cli` in `package.json` and installing dependencies. Use this shape for packages published to npm or installed from a package root:

```js
import { defineExtension } from "@unbrained/pm-cli/sdk";

export default defineExtension({
  activate(api) {
    api.registerCommand({
      name: "hello",
      description: "Print a deterministic hello payload.",
      intent: "verify extension command activation",
      examples: ["pm hello"],
      run() {
        return { ok: true, message: "hello" };
      },
    });
  },
});
```

## Extension Manifest

Runnable manifest examples are the source of truth:

- [starter extension manifest](examples/starter-extension/manifest.json)
- [policy-restricted manifest](examples/policy-restricted-extension/manifest.json)

Rules:

- `entry` must resolve inside the extension directory.
- `manifest_version` is an optional integer identifying the manifest schema generation. Runtime contracts currently support manifest versions `1` and `2`, and first-party runnable examples use `2`. First-party packages declare it; the manifest governance test requires it on every first-party package.
- `pm_min_version` is an inclusive minimum pm CLI version. If the running CLI is older, discovery emits `extension_pm_min_version_unmet:<layer>:<name>:required=<version>:current=<version>` and skips the extension before import.
- `pm_max_version` is an optional inclusive maximum pm CLI version (the upper compatibility bound). If the running CLI is newer than this value, discovery emits `extension_pm_max_version_exceeded:<layer>:<name>:allowed=<version>:current=<version>` and skips the extension before import. Use it to stop a CLI major release from loading a stale package that would crash at activation.
- Both bounds share the same blocking semantics and warning-code shapes:
  - `*_invalid` (`required=`/`allowed=` only): the declared version is unparseable; the extension is **blocked**.
  - `*_unchecked` (`...:current=unknown` or an uncomparable current version): the bound could not be compared against the running CLI; the extension is **allowed** but a warning is recorded.
  - `extension_pm_min_version_unmet` / `extension_pm_max_version_exceeded`: the running CLI is outside the declared bound; the extension is **blocked**.
- An empty-string or non-string `pm_min_version`/`pm_max_version` makes the whole manifest malformed (`extension_manifest_invalid:<layer>:<name>`). Omit the field instead of leaving it blank.
- Optional `engines.pm` and `engines.node` metadata is accepted for tooling, but `pm_min_version`/`pm_max_version` are the loader-enforced compatibility fields.
- Declare only capabilities the extension actually uses.
- Unknown capabilities emit deterministic warnings.
- Legacy aliases such as `migration` and `validation` are normalized to `schema` with warnings.

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

First-party package exemplars:

- `pm-beads` and `pm-todos`: importer/exporter registration and generated command contracts.
- `pm-lifecycle-hooks`: default-inert lifecycle hook registration.
- `pm-search-advanced`: deterministic local search provider registration.

## Governance Policy

Governance policy is configured in `settings.json` under `extensions.policy`. The runnable [policy-restricted example](examples/policy-restricted-extension/README.md) owns the complete policy snippet and expected behavior.

Policy modes:

- `off`: no policy enforcement or warnings
- `warn`: allow registrations but emit policy warnings
- `enforce`: block disallowed extensions, capabilities, commands, actions, services, or surfaces

Sandbox profiles:

- `none`: no extra sandbox restriction
- `restricted`: safe default for normal package workflows
- `strict`: most restrictive policy profile

Surface tokens include:

- `commands.handler`
- `commands.override`
- `parser.override`
- `preflight.override`
- `services.override`
- `renderers.override`
- `hooks.beforecommand`
- `hooks.aftercommand`
- `hooks.onwrite`
- `hooks.onread`
- `hooks.onindex`
- `schema.flags`
- `schema.itemfields`
- `schema.itemtypes`
- `schema.migrations`
- `importers`
- `search.provider`

Use `pm package doctor --project --detail deep --trace` to inspect active policy state and warning codes.

## Registration Collisions

Some extension surfaces are intentionally single-winner: command overrides, parser overrides, preflight overrides, and format renderers. If multiple packages register the same single-winner surface, the later-loaded registration wins and `pm package doctor` / `pm health` report deterministic `extension_*_collision` warnings.

Use the warning details to resolve the overlap:

```bash
pm package doctor --project --detail deep --trace
pm package deactivate <conflicting-package> --project
pm package doctor --project --strict-exit
```

For production stacks, keep broad demo/starter packages separate from packages that own real workflow behavior, or constrain registration surfaces through `extensions.policy.extension_overrides`.

## Runtime APIs

Use the public SDK barrel. Do not deep-import from `src/core` or `dist/core`.

```js
import { defineExtension } from "@unbrained/pm-cli/sdk";
```

Common APIs:

- `api.registerCommand(definition)` adds package-owned commands.
- `api.registerFlags(command, flags)` adds runtime command flags.
- `api.registerItemFields(fields)` adds custom metadata fields. Agents can set declared fields with repeatable `pm create --field name=value` and `pm update <id> --field name=value`; undeclared names are rejected.
- `api.registerItemTypes(types)` adds custom item types.
- `api.registerMigration(definition)` adds schema migrations.
- `api.registerService("output_format", handler)` customizes output formatting through the service override API. Return `context.payload`, `null`, or `undefined` for commands the extension does not own.
- `api.registerRenderer("toon" | "json", renderer)` adds format-specific renderers. Return `null` for unrelated payloads so pm falls back to native rendering.
- `api.hooks.beforeCommand(handler)`, `api.hooks.afterCommand(handler)`, `api.hooks.onWrite(handler)`, `api.hooks.onRead(handler)`, and `api.hooks.onIndex(handler)` add lifecycle hooks.

The bundled `pm-lifecycle-hooks` package is the hook exemplar: it declares only
`hooks` and registers a default-inert `afterCommand` hook so authors can copy a
safe lifecycle pattern without changing command output.

Inline command flags require both `commands` and `schema` capabilities. Runtime schema changes should be verified with:

```bash
pm schema list
pm schema show <Type>
pm contracts --runtime-only --schema-only --json
pm contracts --command <command> --flags-only --json
```

## Lifecycle Commands

Explore installed runtime entries:

```bash
pm package explore --project
pm package explore --project --json
```

Run diagnostics:

```bash
pm package doctor --project --detail summary
pm package doctor --project --detail deep --trace
pm package doctor --project --strict-exit
```

Manage state and update checks:

```bash
pm package manage --project
pm package manage --project --fix-managed-state
pm package adopt my-extension --project
pm package adopt-all --project
```

Activate or deactivate:

```bash
pm package activate my-extension --project
pm package deactivate my-extension --project
```

Uninstall:

```bash
pm package uninstall my-extension --project
```

Reload local edits:

```bash
pm package reload --project
pm package reload --project --watch
```

Compatibility equivalents remain available through `pm extension ...` for existing automation.

## Upgrade Workflow

`pm upgrade` is the package-first update entrypoint:

```bash
pm upgrade --dry-run
pm upgrade
pm upgrade --packages-only
pm upgrade todos --dry-run
pm upgrade --cli-only --repair
```

CLI/SDK upgrades use `npm install -g @unbrained/pm-cli@<tag>`. Managed package upgrades reuse the source recorded at install time, including registry, GitHub, local, and first-party package sources.

## Automation Patterns

Use non-interactive commands with explicit project scope:

```bash
pm init --defaults --author codex-agent
pm install '*' --project
pm package doctor --project --detail summary --json
pm contracts --flags-only --json
pm health --check-only --json
```

For package-owned commands, install the package before assuming the command is available. Runtime contracts expose installed package actions; static SDK contracts intentionally expose only core actions.

If a package-owned command is invoked before installation, usage guidance includes the recovery install command when `pm` can map the command to a bundled package.

## Package Authoring Notes

Third-party packages should import only stable public SDK subpaths:

```js
import { defineExtension, createPmCliExpectedError } from "@unbrained/pm-cli/sdk";
import { assertRegisteredCommandContract } from "@unbrained/pm-cli/sdk/testing";
```

Use `createPmCliExpectedError(message, { exitCode, context })` for expected user/action failures from package commands. It creates an `Error` named `PmCliError` with a structural `exitCode`, so separately installed package code still gets expected-error handling and Sentry filtering.

`PM_CLI_PACKAGE_ROOT` is first-party only. Bundled packages in this repository use it to find the running CLI's `dist/sdk/runtime.js` before they are published or installed independently. External packages must not read this environment variable or import from `dist/` or `src/core`; use `@unbrained/pm-cli/sdk`, `@unbrained/pm-cli/sdk/runtime`, and `@unbrained/pm-cli/sdk/testing`.

## Troubleshooting

- Manifest or entry failure: run `pm package explore --project`.
- Activation failure: run `pm package doctor --detail deep --trace`.
- Policy block: inspect `settings.extensions.policy` and `details.summary.policy`.
- Runtime drift: compare with `pm --no-extensions <command>`.
- Managed-state update-check gap: run `pm package manage --fix-managed-state`.
- Unknown package command: run `pm package catalog --project` and install the owning package.

## Runnable Examples

- `docs/examples/starter-extension/`
- `docs/examples/policy-restricted-extension/`
- `docs/examples/sdk-contract-consumer/`
- `docs/examples/sdk-app-embedding/`
- `docs/examples/ci/github-actions-pm-extension-gate.yml`
- `docs/examples/ci/gitlab-ci-pm-extension-gate.yml`
- `docs/examples/ci/jenkins-pm-extension-gate.Jenkinsfile`
