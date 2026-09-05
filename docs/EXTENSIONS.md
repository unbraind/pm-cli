# Packages and Extensions

Extension flags declared with `list: true` accumulate repeated long/short alias occurrences and comma-separated values into one array. Dynamic commands preserve flag-like variadic content after `--`, and package handlers can use the public `suppressHostOutput()` protocol when they already emitted streaming, binary, or pre-rendered output. Declarative blueprints are also checked for reserved item-field collisions during SDK lint/preflight and harness activation, so a package cannot pass author-time validation and then fail only when users create or update items. Local archive installation, command ownership, MCP custom-field diagnostics, and author-manifest schema diagnostics are tracked by [pm-lw6acw](../.agents/pm/issues/pm-lw6acw.toon), [pm-6z0wzf](../.agents/pm/issues/pm-6z0wzf.toon), [pm-yfdav2](../.agents/pm/issues/pm-yfdav2.toon), and [pm-gh1091](../.agents/pm/issues/pm-gh1091.toon). Transactional mutation guards, host-bound command test SDKs, and installed custom-type lifecycle parity are tracked by [pm-hx23u5](../.agents/pm/issues/pm-hx23u5.toon), [pm-wx2lr5](../.agents/pm/issues/pm-wx2lr5.toon), and [pm-scga6k](../.agents/pm/issues/pm-scga6k.toon). Durable migration application, explicit source resolution, and composable preflight ownership are covered in [Extension Lifecycle Contracts](EXTENSION_LIFECYCLE.md).

Packages add optional `pm` workflows without changing the core CLI. A package can ship one or more runtime extensions plus metadata such as docs and examples. Prefer the package-first commands in new docs and automation:

```bash
pm package init ./my-package
pm package init ./my-hook-package --capability hooks
pm package install ./my-package --project
pm package doctor --project --detail summary
pm package reload --project
pm package upgrade --dry-run
```

Hidden `pm extension ...`, `pm install ...`, and `pm upgrade ...` aliases remain supported for compatibility. They execute the canonical package handlers, keep stdout machine-compatible, and emit one migration hint on stderr unless the public config key `ux_deprecation_hints` (stored at `ux.deprecation_hints`) is disabled. Related docs: [SDK](SDK.md), [Configuration](CONFIGURATION.md), [Testing](TESTING.md), [Command Reference](COMMANDS.md), [Extension Author Contracts](EXTENSION_AUTHOR_CONTRACTS.md).

## Package Sources

`pm package install` accepts local, registry, and GitHub sources:

```bash
pm package install ./local-package --project
pm package install /absolute/path/to/package --project
pm package install ./my-package-1.2.3.tgz --project
pm package install npm:./my-package-1.2.3.tar.gz --project
pm package install npm:@scope/package --project
pm package install npm:package@1.2.3 --project
pm package install https://github.com/org/repo --project
pm package install --github org/repo/path --ref main --project
```

Bundled first-party packages live under `packages/pm-*`:

```bash
pm package catalog --project
pm package install all --project
pm package install calendar --project
pm package install search-advanced --project
pm package install kanban --project
```

`pm package install '*'` and `pm package install all` are normalized to the same bundled install-all request. First-party package aliases come from each package manifest, with a fallback derived from the `packages/pm-*` directory name. A bare bundled alias that also names an installed npm package reports both explicit choices in `source_resolution`; see [Extension Lifecycle Contracts](EXTENSION_LIFECYCLE.md).

External registry packages are installed by exact package name. If `npm:<name>` returns a registry 404, JSON error output includes `fallback_candidates` and `next_best_command`; unpublished first-party packages fall back to `pm package install --project github.com/unbraind/<name>`. Install results include package-owned `command_paths`, `action_paths`, `contributions`, `command_discovery`, and a light `verification` block covering the target tracker, activation status, registered commands/actions/item types, and health verdict. Agents should consume those fields instead of guessing from the package name or immediately spending another invocation on doctor. A successful activation persists the versioned contribution inventory in `.managed-extensions.json`; subsequent discovery can enumerate command handlers, hooks, parser/renderer targets, schema names, and the other registered surfaces without importing the package module. A failed runtime activation returns `ok: false`, `activated: false`, a non-zero CLI exit, and actionable diagnostics; missing SDK resolution adds an explicit dependency recovery step. Local installs are containment-safe when the extension destination is nested inside the source checkout: pm stages the package outside the source and prunes the destination, `.agents`, `node_modules`, and install-backup directories before copying, so reinstalling cannot recursively copy tracker history, host dependencies, or prior backups.
Local `.tgz` and `.tar.gz` npm archives are inspected and extracted in an isolated temporary directory without invoking a shell. Archives must contain one `package/package.json` root, regular files/directories only, and bounded entry and expanded-byte totals. Absolute paths, traversal, alternate roots, links, device entries, oversized entries, and decompression-ratio abuse fail before installation. The managed source remains the original archive path, so reload and upgrade provenance do not point at a temporary extraction directory.
Registry dependency names and versions are parsed as npm package specs before the install subprocess starts. Leading-option names and shell control syntax are rejected. npm reads those validated dependencies from an isolated runtime-only manifest; no caller-controlled spec is forwarded through the Windows command shell, and the fixed invocation still ends option parsing with `--`. Runtime verification then activates a temporary snapshot of the complete installed extension directory, so an upgrade cannot silently reuse stale transitive ESM dependencies from the current process. Successful install details expose `module_graph_verification: "fresh_snapshot"` for this check.
pm-owned npm subprocesses clear any inherited, case-insensitive `npm_config_allow_scripts` value while retaining registry, auth, proxy, and executable-path environment; `--ignore-scripts` remains authoritative. Tracked by [pm-gh1072](../.agents/pm/issues/pm-gh1072.toon).
An explicit `--pm-path` scopes project installs to that tracker root, including extension files, managed state, settings, type-folder scaffolding, and verification output. This is the safe form for temporary package testing from inside another repository checkout.

```bash
npm search "pm-cli pm-package"
pm package install npm:pm-changelog --project
pm package install npm:pm-github --project
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
`pm package init` (and compatible `pm extension init`) creates a publishable root extension (`"extensions": ["."]`):

- The artifact includes package metadata, typed `index.ts`, a colocated `node:test` suite, strict type-check-only `tsconfig.json`, and `typecheck`/`test` scripts. Results report canonical `package_name` and exact `invocation_command`; an existing `pm-` prefix is retained once.
- The manifest points to `./index.ts`, loaded by native TypeScript stripping on Node >=22.18 ([pm-2c28](../.agents/pm/decisions/pm-2c28.toon), [pm-m1uz](../.agents/pm/decisions/pm-m1uz.toon)). Run `npm install` for the peer SDK and type checking before package installation; no build step is required. The README demonstrates the SDK [define* builders](../.agents/pm/decisions/pm-3mph.toon).
- `--capability` selects `commands`, `hooks`, `search`, `importers`, `schema`, `profile`, `renderers`, `parser`, `preflight`, or `services`. Every starter keeps a runnable command and adds matching SDK `assertRegistered*`/`runRegistered*ForTest` tests. Repeating one selection is idempotent; distinct selections fail with an actionable usage error.
- Scaffold selectors and manifest capabilities differ: `profile` registers a profile under `schema`. The [capability matrix](SDK.md#minimal-command-extension) explains each registration, schema-governed flags, and why `schema`/`profile` omit narrow `activation.commands` so their contributions stay globally available.
- Starter manifests declare `trusted: true`, `sandbox_profile: "strict"`, and explicit false permissions for filesystem, network, environment, and subprocess access. Declarative tests import `manifest.json` and call `assertExtensionManifestMatchesBlueprint`, detecting capability drift before publication.
- Larger packages may use nested extension directories and declare required runtime dependencies and permissions. Validate with `pm package doctor`; its advisory `extension_schema_narrow_activation` finding recommends removing narrow activation when custom item types or fields need global availability.
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

Extensions are authored and loaded as TypeScript ([pm-2c28](../.agents/pm/decisions/pm-2c28.toon), [pm-m1uz](../.agents/pm/decisions/pm-m1uz.toon)):

- A minimal standalone extension has `manifest.json` and `index.ts`. Node >=22.18 loads that entry directly with native type stripping; no compilation or `index.js` is required.
- Use `import type { ExtensionApi }` for erased SDK types. Standalone entries outside `node_modules` need the host SDK link described below before using runtime SDK imports.
- Install `typescript` and `@unbrained/pm-cli`, then run `npx tsc --noEmit` to check authoring types.

```json
{
  "name": "hello",
  "version": "0.1.0",
  "entry": "./index.ts",
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
  "capabilities": ["commands"],
  "contributions": {
    "schema_version": 1,
    "commands": ["hello"],
    "command_handlers": ["hello"]
  },
  "activation": { "commands": ["hello"] }
}
```

```ts
// index.ts — the manifest entry; `import type` is erased on load (native type stripping), so it has no runtime import.
import type { ExtensionApi } from "@unbrained/pm-cli/sdk";
export function activate(api: ExtensionApi): void {
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

Package-backed extensions can also import the SDK's runtime helpers (e.g. `defineExtension`, `composeExtension`) after declaring `@unbrained/pm-cli` in `package.json`. Every copied extension receives a local `node_modules/@unbrained/pm-cli` link to the exact running host, regardless of whether its source was npm, GitHub, bundled, or local. Package authors can therefore use ordinary public SDK imports and a peer dependency without absolute `dist/` paths or a duplicate CLI install. Use this shape for packages published to npm or installed from a package root:

```ts
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

Runnable manifest examples are the source of truth: [starter extension manifest](examples/starter-extension/manifest.json) and [policy-restricted manifest](examples/policy-restricted-extension/manifest.json).

Use [extension-manifest.schema.json](schemas/extension-manifest.schema.json) as the `$schema` value for inline editor validation. The loader ignores `$schema` and tolerates future manifest fields, but the schema documents the fields pm reads. Rules:

- `manifest.json` is the runtime declaration; package catalog metadata belongs in `package.json#pm`, and a top-level `compatibility` object is ignored. Use the public `inspectExtensionManifestSchema` / `lintExtensionManifestSchema` helpers for schema-only checks. In author workspaces, `pm health --full`, `pm package doctor`, and `pm extension --doctor` expose the same read-only `author_manifest` findings without activating the extension.
- `entry` must resolve inside the extension directory.
- `manifest_version` is an optional integer identifying the manifest schema generation. Runtime contracts currently support manifest versions `1` and `2`, and first-party runnable examples use `2`. First-party packages declare it; the manifest governance test requires it on every first-party package.
- `pm_min_version` is an inclusive minimum pm CLI version. If the running CLI is older, discovery emits `extension_pm_min_version_unmet:<layer>:<name>:required=<version>:current=<version>` and skips the extension before import.
- `pm_max_version` is an optional inclusive maximum pm CLI version (the upper compatibility bound). If the running CLI is newer than this value, discovery emits `extension_pm_max_version_exceeded:<layer>:<name>:allowed=<version>:current=<version>` and skips the extension before import. Use it to stop a CLI major release from loading a stale package that would crash at activation. Operators can temporarily set `extensions.policy.pm_max_version_exceeded_mode` to `"warn"` (or `{ "project": "warn" }`) during controlled upgrade windows; the default remains `"block"`.
- Both bounds share the same warning-code shapes: `*_invalid` blocks, `*_unchecked` allows with a warning, and `extension_pm_min_version_unmet` / `extension_pm_max_version_exceeded` blocks unless the max-version warn mode is enabled. Verify the supported window at author time — before publishing — with the `checkExtensionManifestCompatibility` SDK helper (or its throwing `assertExtensionManifestCompatible` test guard), which mirrors these exact outcomes against a target pm version. To check the version window, the blueprint lint, and the synthesized manifest in one call, use the `preflightExtension` capstone (or its throwing `assertExtensionPreflight` CI guard).
- An empty-string or non-string `pm_min_version`/`pm_max_version` makes the whole manifest malformed (`extension_manifest_invalid:<layer>:<name>`). Omit the field instead of leaving it blank.
- Optional `engines.pm` and `engines.node` metadata is accepted for tooling, but `pm_min_version`/`pm_max_version` are the loader-enforced compatibility fields.
- Declare only capabilities the extension actually uses. Declaring a capability it never registers against is over-broad: `pm package doctor` emits an advisory `extension_capability_unused:<layer>:<name>:<capability>` warning (never blocking) so you can trim the manifest, while the inverse — registering a surface whose capability is undeclared — is the blocking `extension_capability_missing` activation failure. Catch over-declaration earlier with the `assertExtensionCapabilityUsage` SDK testing helper.
- `contributions` is the versioned, serializable surface inventory. `schema_version: 1` supports command definitions/handlers/overrides, hook phases, flag/parser targets, item types and fields, relationship kinds, migrations, profiles, importers/exporters, search/vector providers, service/renderer targets, renderer command ownership, and the preflight count. `pm package install` derives and persists this block mechanically from the real activation result; authors may also declare it in `manifest.json` for build-time/static discovery.
- `activation.commands` is an optional array of the command paths on which the extension may activate (e.g. `["hello", "tickets import"]`). An explicit list is authoritative for every capability, including hooks and parser/preflight/renderer packages: when no declared path matches, pm does not import the module. Omit it and pm first uses the static contribution inventory, then falls back to conservative capability heuristics for legacy packages whose contributions are unknown.
- Unknown capabilities emit deterministic warnings; legacy aliases such as `migration` and `validation` are normalized to `schema` with warnings.

Supported manifest capabilities (the `profile` scaffold selector emits a profile registration under `schema`; it is not a manifest capability):

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

- [`pm-beads`](../packages/pm-beads/README.md): beads JSON/JSONL importer/exporter package with generated command contracts.
- [`pm-calendar`](../packages/pm-calendar/README.md): calendar view package for schedule/context surfaces.
- [`pm-command-kit`](../packages/pm-command-kit/README.md): command capability exemplar for `registerCommand`, `registerFlags`, and `registerParser`.
- [`pm-digital-twin`](../packages/pm-digital-twin/README.md): deliberately non-PM temporal facility exemplar using custom schema and relationship semantics, event-time replay, invariants, offline replica merge, and tamper-evident exports entirely through public SDK contracts.
- [`pm-governance-audit`](../packages/pm-governance-audit/README.md): governance hook exemplar for compact read/write sidecar logs.
- [`pm-guide-shell`](../packages/pm-guide-shell/README.md): guide-topic package for bundled workflow docs.
- [`pm-kanban`](../packages/pm-kanban/README.md): archetype exemplar shipping a complete Kanban continuous-flow profile (Card type, flow fields, and a `ProjectProfileDefinition`) on public SDK primitives.
- [`pm-lifecycle-hooks`](../packages/pm-lifecycle-hooks/README.md): default-inert lifecycle hook registration.
- [`pm-linked-test-adapters`](../packages/pm-linked-test-adapters/README.md): linked-test run-management adapters and reporters.
- [`pm-search-advanced`](../packages/pm-search-advanced/README.md): deterministic local search provider registration.
- [`pm-templates`](../packages/pm-templates/README.md): reusable create-template package.
- [`pm-todos`](../packages/pm-todos/README.md): todo import/export package with generated command contracts.
- [`pm-vcs`](../packages/pm-vcs/README.md): deliberately non-PM VCS exemplar using custom schema, lifecycle commands, point-in-time reads, and durable relationship projections entirely through public SDK contracts.

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

Some extension surfaces are intentionally single-winner: command handlers and overrides, parser overrides, preflight overrides, and format renderers. Activation is deterministic: lower manifest `priority` values load first, omitted priority defaults to `100`, equal priorities sort by package identity/path, and the last registration wins. If multiple packages register the same single-winner surface, `pm package doctor` / `pm health` report deterministic `extension_*_collision` warnings whose suffix names the winning layer/package before the displaced layer/package. `pm package describe --json` also exposes `command_ownership`: every claimant in activation order, the effective winner, collision state, and the explicit `last_activated_wins` policy. SDK hosts can build the identical table with `buildExtensionDescribeResult` and the exported `ExtensionCommandOwnership` contracts. Renderer ownership is evaluated per command: same-format renderers with disjoint `commands` lists safely coexist, while an unscoped or overlapping claim still warns; runtime `resultDiscriminator` predicates alone cannot prove static disjointness. Tracked by [pm-6mjxgq](../.agents/pm/issues/pm-6mjxgq.toon).

For definition-based commands, validation is isolated per command: a malformed definition is recorded as `extension_command_quarantined:*` with a registration trace while valid siblings continue to activate. Unknown-command recovery reports that failure without recommending reinstallation.
Use the warning details to resolve the overlap:

```bash
pm package doctor --project --detail deep --trace
pm package deactivate <conflicting-package> --project
pm package doctor --project --strict-exit
```

Doctor JSON also includes `triage.collision_plan` with grouped surfaces, ranked deactivation candidates, and command/action feature-loss hints. For production stacks, keep broad demo/starter packages separate from packages that own real workflow behavior, or constrain registration surfaces through `extensions.policy.extension_overrides`.

## Runtime APIs

Use the public SDK barrel. Do not deep-import from `src/core` or `dist/core`.

- `api.extension` is a read-only identity (`name`, `layer`, `version`, `capabilities`, `pm_min_version?`, `pm_max_version?`, `source_package?`) for self-identifying logs and version gating without re-reading the manifest.
- `api.registerCommand(definition)` adds package-owned commands.
- `api.registerFlags(command, flags)` adds runtime command flags. A flag may declare `value_type` (canonical; the legacy `type` alias is honored only when `value_type` is absent), `list: true` to accumulate repeated/comma-joined values like core `--tags`, and a `default` applied when the flag is omitted.
- `api.registerItemFields(fields)` adds custom metadata fields. Agents can set declared fields with repeatable `pm create --field name=value` and `pm update <id> --field name=value`; undeclared names are rejected. `SchemaFieldDefinition.type` is the same closed union used by `pm schema add-field`: `string | number | boolean | string_array | array | object`. Unsupported values fail at compile time for TypeScript authors and at activation for JavaScript packages, with a did-you-mean hint on typos. `string_array` is the repeatable string collection; `array` and `object` require JSON containers.
- Custom fields whose camel-case option name is already owned by a canonical MCP input remain usable through `options.<name>`, but authoring surfaces report the collision instead of allowing silent top-level shadowing. `pm schema add-field`, `pm profile lint`, and `pm package doctor` name the field, canonical `mcp_tool_input` owner, and nested recovery path. SDK authors can preflight the same rule with `resolvePmToolCustomFieldCollision`.
- `api.registerItemTypes(types)` adds custom item types.
- `api.registerRelationshipKinds(definitions)` adds validated graph semantics. Definitions declare direction, inverse spelling, ordering/precedence, hierarchy, cardinality, lifecycle, aliases, payload schema, compatibility version, and self-edge policy. Active definitions are merged into native CLI, MCP, and SDK workspace graph assembly. Requires the `schema` capability and is governed by the `schema.relationshipkinds` policy surface.
- `api.registerMigration(definition)` adds schema migrations.
- `api.registerProfile(profile)` contributes a project profile — a declarative archetype bundling item types, statuses, fields, per-type workflows, config, templates, and package recommendations. Once active it resolves by name through `pm profile list/show/apply` alongside the core `agile`/`ops`/`research` archetypes (built-in names are reserved; a colliding registration is ignored with a warning). Requires the `schema` capability.
- `api.registerAssuranceMeasurementProvider(provider)` contributes typed measurements to assurance. It requires `services`; network providers also require manifest `permissions.network: true`. Gates allow providers and cost/network limits per trigger. See [Project Assurance Primitives](ASSURANCE.md#extension-measurement-providers) for examples.
- `api.registerService("output_format", handler, ownership?)` customizes output formatting through the service override API. Use `handleServiceOverride(result)` to claim a payload and return the scaffold-compatible literal `{ handled: false }` (or `declineServiceOverride()`) for commands the extension does not own. An override that is unconditionally inert can declare `{ passThrough: true }`; the host then ignores and diagnoses any handled result, and package doctor treats the registration as statically safe. Legacy `null`/`undefined` declines remain supported; returning the original payload is now an unambiguous handled result. Tracked by [pm-gh1074](../.agents/pm/issues/pm-gh1074.toon).
- `api.registerRenderer("toon" | "json", renderer, ownership?)` adds format-specific renderers. Scope ownership with `commands` and/or a `resultDiscriminator`; the host checks both before invoking the renderer and falls back to native rendering for unrelated output. The legacy unscoped callback remains supported, but doctor warns because package ownership cannot be proven statically.
- `suppressHostOutput(result?)` from `@unbrained/pm-cli/sdk` marks commands that already wrote output, preventing a second CLI payload while retaining the optional result for hooks, telemetry, and embedded hosts.
- `api.hooks.beforeCommand(handler)`, `api.hooks.beforeMutation(handler)`, `api.hooks.afterCommand(handler)`, `api.hooks.onWrite(handler)`, `api.hooks.onRead(handler)`, and `api.hooks.onIndex(handler)` add lifecycle hooks.
  `beforeMutation` is a fail-closed invariant boundary inside the item lock and before item or history persistence. It receives canonical `before`/`after` snapshots, `operation`, `changed_fields`, and a host-bound read-only `sdk` with `get`/`list`. Return `{ allow: true }` (or nothing) to continue, or `{ allow: false, code, message?, remediation }` to deny with stable structured guidance. A thrown error or malformed denial blocks the write. The boundary covers create, update, close, delete, restore, annotations, and structured/bulk mutations because those surfaces share the same lifecycle primitives.
  `afterCommand` receives command outcome fields plus optional compact `affected` item entries for mutations, including `previous_status`, `status`, `changed_fields`, and partial `previous`/`current` item metadata snapshots.
  `onWrite` always includes `path`, `scope`, and `op`; item mutations also add optional `item_id`, `item_type`, `before`, `after`, and `changed_fields`.
- Registered command, importer, and exporter handlers receive `context.sdk`, a host-bound service bundle containing a native-action `PmClient`, `getItemAt`, and `openRelationshipEventStore`, alongside portable workspace coordinates. The client reuses the already-active extension schema context without recursively loading extensions, so package commands and data adapters can compose core lifecycle operations safely in CLI and SDK hosts.
- An optional module-level `deactivate()` export (VS Code-style) is invoked by the host on shutdown/reload — including by the long-running MCP server between native-action requests — to close connections, clear timers, and release resources opened during `activate`. Teardown is best-effort and timeout-bounded by default so it does not block other extensions, except when a host explicitly disables waiting limits with `deactivate_timeout_ms: 0` or `Infinity`, which can wait indefinitely for a hanging `deactivate()` hook.

The bundled `pm-lifecycle-hooks` package is the hook exemplar: it declares only `hooks` and registers a default-inert `afterCommand` hook so authors can copy a safe lifecycle pattern without changing command output.
If a package calls a `register*` API without declaring the required manifest capability, `pm package doctor --project --detail deep --trace` reports `extension_capability_missing:<name>:<capability>` and shows the exact capability to add before publishing.
Inline command flags require both `commands` and `schema` capabilities. Runtime schema changes should be verified with:

```bash
pm schema list
pm schema show <Type>
pm contracts --runtime-only --schema-only --json
pm contracts --command <command> --flags-only --json
```

List-valued inline flags and `registerFlags` entries share one ordered
accumulator across their long and short aliases. For a variadic positional that
must receive values such as `-h` or `--json`, put the end-of-options separator
before the content: `pm <package-command> -- RETURN -h --json`.

Detailed package-author runtime contracts live in
[Extension Author Contracts](EXTENSION_AUTHOR_CONTRACTS.md), including
`telemetry.capture_level`, create-path vs `mutateItem` write behavior, and hook
surface guarantees.

## Lifecycle Commands

Explore installed runtime entries, or describe exactly what each loaded package registers (commands, hooks, item types, providers, overrides) as a by-name surface map:

```bash
pm package explore --project
pm package describe --project                 # surfaces plus deterministic command ownership
pm package describe my-extension --markdown --output docs/my-extension-reference.md
```

Run diagnostics:

```bash
pm package doctor --project --detail summary
pm package doctor --project --detail deep --trace
pm package doctor --project --isolated --detail deep --trace
pm package doctor --project --strict-exit
```

Use `--isolated` (alias `--ignore-global`) when a package smoke test must inspect only the project install. Non-isolated project diagnostics include global registrations and emit an isolation remediation hint when global package state can affect the result; subprocess-based test suites can also set `PM_GLOBAL_PATH` to a temporary directory for the whole run.

Manage state and update checks:

```bash
pm package manage --project
pm package manage --project --fix-managed-state
pm package adopt my-extension --project
pm package adopt-all --project
```

Activate, deactivate, uninstall, and reload:

```bash
pm package activate my-extension --project
pm package deactivate my-extension --project
pm package uninstall my-extension --project
pm package reload --project
pm package reload --project --watch
```

## Upgrade Workflow

`pm package upgrade` is the package-first update entrypoint:

```bash
pm package upgrade --dry-run
pm package upgrade
pm package upgrade --packages-only
pm package upgrade todos --dry-run
pm package upgrade --cli-only --repair
```

CLI/SDK upgrades use `npm install -g @unbrained/pm-cli@<tag>`. Managed package upgrades reuse the source recorded at install time, including registry, GitHub, local, and first-party package sources.

## Automation Patterns

Use non-interactive commands with explicit project scope:

```bash
pm init --defaults --author codex-agent
pm package install '*' --project
pm package doctor --project --detail summary --json
pm contracts --flags-only --json
pm health --check-only --json
```

For package-owned commands, install the package before assuming the command is available. Runtime contracts expose installed package actions; static SDK contracts intentionally expose only core actions.
If a package-owned command is invoked before installation, usage guidance includes the recovery install command when `pm` can map the command to a bundled package.

## Package Authoring Notes

Third-party packages should import only stable public SDK subpaths:

```ts
import { defineExtension } from "@unbrained/pm-cli/sdk/authoring";
import { createPmCliExpectedError } from "@unbrained/pm-cli/sdk/contracts";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import { activateExtensionForTest } from "@unbrained/pm-cli/sdk/testing";
```

Runtime modules use static SDK imports; installed copies receive a host SDK link. Use `createPmCliExpectedError(message, { exitCode, context })` for expected user/action failures from package commands. It creates an `Error` named `PmCliError` with a structural `exitCode`, so separately installed package code still gets expected-error handling and Sentry filtering. Commands that need to render a structured gate report and still fail CI may instead return an object with `exit_code` from `1` through `255`; optional string `code` and `remediation` fields are preserved by the host. The result is rendered normally, and the CLI exits with the declared status. Thrown plain objects also preserve bounded `code` and `remediation` fields in the host error contract.
Prefer the `define*` builders for exported registration definitions (`defineCommand`, `defineFlag`, `defineSearchProvider`, `defineAfterCommandHook`, and the matching override/import/export/hook helpers; see ADR [pm-3mph](../.agents/pm/decisions/pm-3mph.toon)). They are zero-cost identity functions that preserve object literal types and contextually type function parameters before the definitions reach `api.register*`; runtime validation remains in the loader, and behavior validation remains in `sdk/testing`.
Packages that extend core list or search behavior should import `LIST_FILTER_EXTENSION_FLAG_DEFINITIONS`, `SEARCH_EXTENSION_FLAG_DEFINITIONS`, or `toExtensionFlagDefinitions` from `@unbrained/pm-cli/sdk/authoring` instead of copying CLI option tables. For example: `api.registerFlags("my search", SEARCH_EXTENSION_FLAG_DEFINITIONS)`.
The adapter expands aliases into registration-ready definitions and preserves string/boolean behavior, list accumulation, repeatability, requiredness, descriptions, and value names from the canonical CLI contracts. Use `toExtensionFlagDefinitions` with another exported CLI flag contract for a narrower baseline.
Prefer `createExtensionTestHarness(module, { capabilities })` in package unit tests: it activates the module once and returns a fluent fixture whose `assert*`/`run*` methods are already bound to the right activation sub-registry (so you never thread `activation.registrations` vs `activation.commands` vs `activation.hooks` by hand), plus a `deactivate()` that runs the real teardown engine — e.g. `harness.assertCommandContract({ name: command })`, `await harness.runCommand({ command, pmRoot })`, `await harness.deactivate()`. Command dispatch with a non-empty `pmRoot` injects the same host-bound `context.sdk` shape as production; use the typed `sdk` or `sdkFactory` override only for a deliberate seam. Mutation-guard packages can call `await harness.runMutationGuard({ context })` to exercise fail-closed decisions through the real runtime. Named assertion expectations consistently accept `name`; the older surface-specific keys (`command`, `provider`, `field`, and the rest) remain compatibility aliases. The methods do not use `this`, so they are safe to destructure. For finer control, the standalone helpers remain public: `activateExtensionForTest(module)` returns the raw `activation`, then `runRegisteredCommandForTest(activation.commands, { command, pmRoot })` invokes a registered command handler through pm's real dispatch engine to assert behavior, not just wiring; `runRegisteredMutationGuardForTest` invokes the transactional guard surface; the matching `runRegisteredHookForTest` (best-effort lifecycle hooks), `runRegistered{Parser,Preflight,Command,Renderer,Service}OverrideForTest` (override surfaces), and `runRegistered{SearchProvider,VectorStoreAdapter,Migration,Importer,Exporter}ForTest` (executable registrations — the importer/exporter helpers take the whole `activation` and resolve by name, deriving the command path internally) helpers extend that invoke verb to every other runtime surface. Keep `pm package doctor --project --detail deep --trace` and runtime contracts for integration tests against installed packages.

`PM_CLI_PACKAGE_ROOT` is first-party only. External packages must not read this environment variable or import from `dist/` or `src/core`; use `@unbrained/pm-cli/sdk`, `@unbrained/pm-cli/sdk/runtime`, and `@unbrained/pm-cli/sdk/testing`. The installer links every copied extension back to the running host CLI so those public imports resolve consistently for npm, GitHub, bundled, and local sources.

## Troubleshooting

- Manifest or entry failure: run `pm package explore --project`.
- Activation failure: run `pm package doctor --detail deep --trace`.
- Machine-dependent package diagnostics: run `pm package doctor --project --isolated --detail deep --trace` or set `PM_GLOBAL_PATH` to a temp directory.
- Policy block: inspect `settings.extensions.policy` and `details.summary.policy`.
- Runtime drift: compare with `pm --no-extensions <command>`.
- Managed-state update-check gap: run `pm package manage --fix-managed-state`.
- Unknown package command: run `pm package catalog --project` and install the owning package.

## Runnable Examples

See the [starter](examples/starter-extension/README.md), [policy-restricted](examples/policy-restricted-extension/README.md), [SDK contract consumer](examples/sdk-contract-consumer/README.md), and [SDK application](examples/sdk-app-embedding/README.md) examples.
