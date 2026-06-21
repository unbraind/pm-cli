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

Related docs: [SDK](SDK.md), [Configuration](CONFIGURATION.md), [Testing](TESTING.md), [Command Reference](COMMANDS.md), [Extension Author Contracts](EXTENSION_AUTHOR_CONTRACTS.md).

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

External registry packages are installed by exact package name. If `npm:<name>` returns a registry 404, JSON error output includes `fallback_candidates` and `next_best_command`; unpublished first-party packages fall back to `pm install --project github.com/unbraind/<name>`. Install results include package-owned `command_paths`, `action_paths`, and `command_discovery`; agents should read `details.command_discovery.command_paths` and `details.command_discovery.help_commands` instead of guessing from the package name.

```bash
npm search "pm-cli pm-package"
pm install npm:pm-changelog --project
pm install npm:pm-github --project
pm package doctor --project --detail deep --trace
pm github validate --repo owner/repo
```

For `pm-github`, run `pm github validate --repo owner/repo` before mutating commands; write paths require `GITHUB_TOKEN`/`GH_TOKEN` or `gh auth login`.

For ecosystem maintenance, use the reusable external package smoke harness after building `dist/`:

```bash
pnpm build
pnpm smoke:external-packages -- --limit 10
pnpm smoke:external-packages -- --package pm-changelog
```

The harness discovers npm packages with the `keywords:pm-package` query unless explicit packages are provided, installs each package in a temporary project with isolated `PM_PATH`/`PM_GLOBAL_PATH`, then checks `pm package doctor --project --detail deep --trace` and runtime availability contracts.

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
    "assets": ["assets"],
    "prompts": ["prompts"],
    "catalog": { "display_name": "My pm Package", "category": "workflow" }
  }
}
```

Installation activates `pm.extensions`. `pm.docs`, `pm.examples`, `pm.assets`, and `pm.prompts` are catalog metadata (metadata-only — they are discovered and surfaced in the catalog but not executed). Declare agent-facing prompt/slash-command markdown under `pm.prompts` and non-code assets (images, skills, fixtures) under `pm.assets`; their conventional roots are `prompts/` (also `.agents/pm/prompts/`) and `assets/` (also `.agents/pm/assets/`).

`pm package init` emits a root extension (`"extensions": ["."]`) so local package installs can activate without dependency bootstrapping. Its starter manifest uses the same least-privilege policy metadata as pure first-party command packages: `trusted: true`, `sandbox_profile: "strict"`, and explicit `false` permissions for `fs_read`, `fs_write`, `network`, `env_read`, `env_write`, and `process_spawn`. Larger packages may point at nested extension directories after declaring runtime dependencies, relaxing only the permissions they actually need, and validating with `pm package doctor`.

Package tests can pair `readPmPackageManifest(packageRoot)` with
`assertPackageManifest(manifest, { resources: ... })` from
`@unbrained/pm-cli/sdk` to prove aliases and resource paths without duplicating
pm's manifest normalization logic.

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
  "trusted": true,
  "sandbox_profile": "strict",
  "permissions": {
    "fs_read": false,
    "fs_write": false,
    "network": false,
    "env_read": false,
    "env_write": false,
    "process_spawn": false
  },
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

Package-backed extensions can use the SDK helper after declaring `@unbrained/pm-cli` in `package.json` and installing dependencies. Registry installs satisfy that SDK import from the running host CLI instead of downloading a nested CLI copy into each project extension directory, so package authors can declare `@unbrained/pm-cli` as a peer dependency without adding the CLI's own telemetry/runtime dependencies to every workspace. Use this shape for packages published to npm or installed from a package root:

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

For package-owned governance hooks, use the `pm-governance-audit` shape: declare
`hooks` in the manifest, register `api.hooks.onRead`/`api.hooks.onWrite`, and keep
sidecar writes opt-in. Its `PM_GOVERNANCE_AUDIT_HOOK_LOG` logger records compact
JSONL read/write metadata and omits full item bodies, which keeps hook packages
useful for agents without inflating context or leaking private item content.

## Extension Manifest

Runnable manifest examples are the source of truth:

- [starter extension manifest](examples/starter-extension/manifest.json)
- [policy-restricted manifest](examples/policy-restricted-extension/manifest.json)

Schema:

- Use [extension-manifest.schema.json](schemas/extension-manifest.schema.json) as the
  `$schema` value for inline editor validation. The loader ignores `$schema` and
  tolerates future manifest fields, but the schema documents the fields pm reads.

Rules:

- `entry` must resolve inside the extension directory.
- `manifest_version` is an optional integer identifying the manifest schema generation. Runtime contracts currently support manifest versions `1` and `2`, and first-party runnable examples use `2`. First-party packages declare it; the manifest governance test requires it on every first-party package.
- `pm_min_version` is an inclusive minimum pm CLI version. If the running CLI is older, discovery emits `extension_pm_min_version_unmet:<layer>:<name>:required=<version>:current=<version>` and skips the extension before import.
- `pm_max_version` is an optional inclusive maximum pm CLI version (the upper compatibility bound). If the running CLI is newer than this value, discovery emits `extension_pm_max_version_exceeded:<layer>:<name>:allowed=<version>:current=<version>` and skips the extension before import. Use it to stop a CLI major release from loading a stale package that would crash at activation. Operators can temporarily set `extensions.policy.pm_max_version_exceeded_mode` to `"warn"` (or `{ "project": "warn" }`) during controlled upgrade windows; the default remains `"block"`.
- Both bounds share the same warning-code shapes: `*_invalid` blocks, `*_unchecked` allows with a warning, and `extension_pm_min_version_unmet` / `extension_pm_max_version_exceeded` blocks unless the max-version warn mode is enabled.
- An empty-string or non-string `pm_min_version`/`pm_max_version` makes the whole manifest malformed (`extension_manifest_invalid:<layer>:<name>`). Omit the field instead of leaving it blank.
- Optional `engines.pm` and `engines.node` metadata is accepted for tooling, but `pm_min_version`/`pm_max_version` are the loader-enforced compatibility fields.
- Declare only capabilities the extension actually uses. Declaring a capability it never registers against is over-broad: `pm package doctor` emits an advisory `extension_capability_unused:<layer>:<name>:<capability>` warning (never blocking) so you can trim the manifest, while the inverse — registering a surface whose capability is undeclared — is the blocking `extension_capability_missing` activation failure. Catch over-declaration earlier with the `assertExtensionCapabilityUsage` SDK testing helper.
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

- `pm-beads`: beads JSON/JSONL importer/exporter package with generated command contracts.
- `pm-calendar`: calendar view package for schedule/context surfaces.
- `pm-command-kit`: command capability exemplar for `registerCommand`, `registerFlags`, and `registerParser`.
- `pm-governance-audit`: governance hook exemplar for compact read/write sidecar logs.
- `pm-guide-shell`: guide-topic package for bundled workflow docs.
- `pm-lifecycle-hooks`: default-inert lifecycle hook registration.
- `pm-linked-test-adapters`: linked-test run-management adapters and reporters.
- `pm-search-advanced`: deterministic local search provider registration.
- `pm-templates`: reusable create-template package.
- `pm-todos`: todo import/export package with generated command contracts.

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

`sandbox_profile` and `permissions` are declaration-based load gates, not runtime
isolation. They let policy decide whether to load an extension; they do not stop
loaded JavaScript from using Node APIs at runtime. `pm package doctor --project`
reports the same advisory trust-model caveat in its policy summary.

`extensions.policy.pm_max_version_exceeded_mode` controls how `pm_max_version`
violations are handled. Use `"block"` (the default) for both global and project
layers, `"warn"` to allow exceeded extensions while emitting
`extension_pm_max_version_exceeded_warn`, or a per-layer object such as:

```json
{
  "extensions": {
    "policy": {
      "pm_max_version_exceeded_mode": {
        "global": "block",
        "project": "warn"
      }
    }
  }
}
```

Surface tokens include command handlers/overrides, parser/preflight/services/renderers overrides, lifecycle hooks, schema registrations, importers, and search providers. Use `pm package doctor --project --detail deep --trace` for the exact active token names and policy warning codes.

## Registration Collisions

Some extension surfaces are intentionally single-winner: command overrides, parser overrides, preflight overrides, and format renderers. If multiple packages register the same single-winner surface, the later-loaded registration wins and `pm package doctor` / `pm health` report deterministic `extension_*_collision` warnings.

Use the warning details to resolve the overlap:

```bash
pm package doctor --project --detail deep --trace
pm package deactivate <conflicting-package> --project
pm package doctor --project --strict-exit
```

Doctor JSON also includes `triage.collision_plan` with grouped surfaces, ranked deactivation candidates, and command/action feature-loss hints. For production stacks, keep broad demo/starter packages separate from packages that own real workflow behavior, or constrain registration surfaces through `extensions.policy.extension_overrides`.

## Runtime APIs

Use the public SDK barrel. Do not deep-import from `src/core` or `dist/core`.

```js
import { defineExtension } from "@unbrained/pm-cli/sdk";
```

Common APIs:

- `api.extension` is a read-only identity (`name`, `layer`, `version`, `capabilities`, `pm_min_version?`, `pm_max_version?`, `source_package?`) for self-identifying logs and version gating without re-reading the manifest.
- `api.registerCommand(definition)` adds package-owned commands.
- `api.registerFlags(command, flags)` adds runtime command flags. A flag may declare `value_type` (canonical; the legacy `type` alias is honored only when `value_type` is absent), `list: true` to accumulate repeated/comma-joined values like core `--tags`, and a `default` applied when the flag is omitted.
- `api.registerItemFields(fields)` adds custom metadata fields. Agents can set declared fields with repeatable `pm create --field name=value` and `pm update <id> --field name=value`; undeclared names are rejected. Each field `type` is validated against `string | number | boolean | array | object` at activation, with a did-you-mean hint on typos.
- `api.registerItemTypes(types)` adds custom item types.
- `api.registerMigration(definition)` adds schema migrations.
- `api.registerService("output_format", handler)` customizes output formatting through the service override API. Return `context.payload`, `null`, or `undefined` for commands the extension does not own.
- `api.registerRenderer("toon" | "json", renderer)` adds format-specific renderers. Return `null` for unrelated payloads so pm falls back to native rendering.
- `api.hooks.beforeCommand(handler)`, `api.hooks.afterCommand(handler)`, `api.hooks.onWrite(handler)`, `api.hooks.onRead(handler)`, and `api.hooks.onIndex(handler)` add lifecycle hooks.
  `afterCommand` receives command outcome fields plus optional compact `affected`
  item entries for mutations, including `previous_status`, `status`,
  `changed_fields`, and partial `previous`/`current` front matter snapshots.
  `onWrite` always includes `path`, `scope`, and `op`; item mutations also add optional `item_id`, `item_type`, `before`, `after`, and `changed_fields`.
- An optional module-level `deactivate()` export (VS Code-style) is invoked by the host on shutdown/reload — including by the long-running MCP server between native-action requests — to close connections, clear timers, and release resources opened during `activate`. Teardown is best-effort and timeout-bounded by default so it does not block other extensions, except when a host explicitly disables waiting limits with `deactivate_timeout_ms: 0` or `Infinity`, which can wait indefinitely for a hanging `deactivate()` hook.

The bundled `pm-lifecycle-hooks` package is the hook exemplar: it declares only
`hooks` and registers a default-inert `afterCommand` hook so authors can copy a
safe lifecycle pattern without changing command output.

If a package calls a `register*` API without declaring the required manifest
capability, `pm package doctor --project --detail deep --trace` reports
`extension_capability_missing:<name>:<capability>` and shows the exact capability
to add before publishing.

Inline command flags require both `commands` and `schema` capabilities. Runtime schema changes should be verified with:

```bash
pm schema list
pm schema show <Type>
pm contracts --runtime-only --schema-only --json
pm contracts --command <command> --flags-only --json
```

Detailed package-author runtime contracts live in
[Extension Author Contracts](EXTENSION_AUTHOR_CONTRACTS.md), including
`telemetry.capture_level`, create-path vs `mutateItem` write behavior, and hook
surface guarantees.


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
import { activateExtensionForTest, assertRegisteredCommandContract } from "@unbrained/pm-cli/sdk/testing";
```

Use `createPmCliExpectedError(message, { exitCode, context })` for expected user/action failures from package commands. It creates an `Error` named `PmCliError` with a structural `exitCode`, so separately installed package code still gets expected-error handling and Sentry filtering.

Use `activateExtensionForTest(module)` in package unit tests when you need an `activation.registrations` or `activation.hooks` object for assertion helpers; then `runRegisteredCommandForTest(activation.commands, { command })` invokes a registered command (or importer/exporter) handler through pm's real dispatch engine to assert behavior, not just wiring. Keep `pm package doctor --project --detail deep --trace` and runtime contracts for integration tests against installed packages.

`PM_CLI_PACKAGE_ROOT` is first-party only. Bundled packages in this repository use it to find the running CLI's `dist/sdk/runtime.js` before they are published or installed independently. External packages must not read this environment variable or import from `dist/` or `src/core`; use `@unbrained/pm-cli/sdk`, `@unbrained/pm-cli/sdk/runtime`, and `@unbrained/pm-cli/sdk/testing`. During `pm install npm:<package>`, pm links the installed package's `@unbrained/pm-cli` dependency back to the running host CLI so SDK imports resolve without a duplicate nested CLI install.

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
