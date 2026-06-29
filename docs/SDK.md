# SDK

The supported programmatic surface is `@unbrained/pm-cli/sdk`.

Use it for extension authoring, package authoring, command/action contract discovery, and deterministic app or CI automation. Do not import private `src/core/...` modules from external integrations or packages.

## Install

```bash
npm install @unbrained/pm-cli
```

## Import Surfaces

```ts
import { defineExtension } from "@unbrained/pm-cli/sdk";
```

Supported package exports:

- `@unbrained/pm-cli/sdk` - stable extension and package authoring API plus CLI contract exports.
- `@unbrained/pm-cli/sdk/runtime` - runtime helpers for packages that need command implementations without private imports.
- `@unbrained/pm-cli/sdk/testing` - lightweight assertion helpers for package/extension tests.
- `@unbrained/pm-cli/cli` - runtime CLI module entrypoint for package resolution, not a typed library API.

## Public Exports

Source of truth:

- [`src/sdk/index.ts`](../src/sdk/index.ts)
- [`src/sdk/runtime.ts`](../src/sdk/runtime.ts)
- [`src/sdk/cli-contracts.ts`](../src/sdk/cli-contracts.ts)
- [`src/sdk/cli-contracts/commander-types.ts`](../src/sdk/cli-contracts/commander-types.ts)
- [`src/sdk/cli-contracts/commander-mutation-options.ts`](../src/sdk/cli-contracts/commander-mutation-options.ts)

Common authoring exports:

- `defineExtension`
- `composeExtension` / `deriveExtensionCapabilities`
- `mergeExtensionBlueprints` (combine partial blueprints into one for modular authoring)
- `composeExtensionPackage` (author-once capstone: returns both the module and its synthesized manifest)
- `synthesizeExtensionManifest` (generate a complete least-privilege manifest from a blueprint)
- `describeExtensionBlueprint` (static surface map of a blueprint) / `lintExtensionBlueprint` (author-time preflight)
- `renderExtensionSurfaceMarkdown` (render a describe summary to a drift-free Markdown reference doc for a package README)
- `checkExtensionManifestCompatibility` (author-time `pm_min_version`/`pm_max_version` check against a target pm version)
- `preflightExtension` (one-call capstone: lint + manifest synthesis + version-compat in a single consolidated report)
- `EXTENSION_CAPABILITIES`
- `EXTENSION_CAPABILITY_CONTRACT`
- `EXTENSION_CAPABILITY_CONTRACT_VERSION`
- `EXTENSION_CAPABILITY_LEGACY_ALIASES`
- `EXTENSION_POLICY_MODES`
- `EXTENSION_POLICY_SURFACES`
- `EXTENSION_TRUST_MODES`
- `EXTENSION_SANDBOX_PROFILES`
- `PM_CLI_EXPECTED_ERROR_NAME`
- `createPmCliExpectedError`
- `isPmCliExpectedError`

Registration builders (`define*`, zero-cost identity — see [Authoring Builders](#authoring-builders)):

- `defineCommand` / `defineFlag` / `defineItemType` / `defineItemField` / `defineMigration`
- `defineProjectProfile` (archetype bundle of types/statuses/fields/workflows/config/templates/packages — powers `pm profile`)
- `defineSearchProvider` / `defineVectorStoreAdapter`
- `defineCommandOverride` / `defineParserOverride` / `definePreflightOverride` / `defineServiceOverride` / `defineRendererOverride`
- `defineImporter` / `defineExporter`
- `defineBeforeCommandHook` / `defineAfterCommandHook` / `defineOnWriteHook` / `defineOnReadHook` / `defineOnIndexHook`

Project profiles:

- `defineProjectProfile` / `BUILTIN_PROFILES` / `PROFILE_NAMES` / `resolveProfile` / `listProfiles` / `normalizeProfileName`
- `planProfileApplication` (pure, idempotent diff of a profile against the current tracker state) and its `ProfileApplicationPlan` / `ProfileCurrentState` types
- The bundled [pm-kanban exemplar](../packages/pm-kanban/README.md) ships a complete archetype as an installable package: it registers the live schema (`Card` type + flow fields) and exports a `ProjectProfileDefinition` the planner can stage, all on public SDK primitives.

Package manifest exports:

- `PM_PACKAGE_RESOURCE_KINDS` (`extensions`, `docs`, `examples`, `assets`, `prompts`)
- `PM_PACKAGE_CONVENTIONAL_RESOURCE_ROOTS`
- `readPmPackageManifest`
- `collectPackageExtensionDirectories`

Storage format-version exports (under `@unbrained/pm-cli/sdk/runtime`):

- `CURRENT_ITEM_FORMAT_VERSION` / `BASELINE_ITEM_FORMAT_VERSION`
- `effectiveItemFormatVersion` (resolve an item's stored version; absent means the baseline)
- `normalizeItemFormatVersion` (persisted form; the baseline is dropped so it is never serialized)
- `classifyItemFormatVersion` (`current` / `outdated` / `ahead`)
- `scanItemFormatVersions` (partition items into outdated/ahead reference lists)

Command/action contract exports:

- `PM_CORE_COMMAND_NAMES`
- `PM_TOOL_ACTIONS`
- `PM_TOOL_PARAMETERS_SCHEMA`
- `PM_PROVIDER_TOOL_PARAMETERS_SCHEMA`
- `PM_TOOL_ACTION_PARAMETER_CONTRACTS`

Testing helper exports (also under `@unbrained/pm-cli/sdk/testing`):

- `createExtensionTestHarness`
- `activateExtensionForTest`
- `deactivateExtensionForTest`
- `runRegisteredCommandForTest`
- `runRegisteredHookForTest`
- `runRegisteredParserOverrideForTest`
- `runRegisteredPreflightOverrideForTest`
- `runRegisteredCommandOverrideForTest`
- `runRegisteredRendererOverrideForTest`
- `runRegisteredServiceOverrideForTest`
- `runRegisteredSearchProviderForTest`
- `runRegisteredVectorStoreAdapterForTest`
- `runRegisteredMigrationForTest`
- `runRegisteredImporterForTest`
- `runRegisteredExporterForTest`
- `assertExtensionDeactivated`
- `assertPackageManifest`
- `assertRegisteredCommandContract`
- `assertRegisteredFlags`
- `assertRegisteredCommandOverride`
- `assertRegisteredParserOverride`
- `assertRegisteredPreflightOverride`
- `assertRegisteredRendererOverride`
- `assertRegisteredHook`
- `assertRegisteredSearchProvider`
- `assertRegisteredImporter`
- `assertRegisteredExporter`
- `assertRegisteredVectorStoreAdapter`
- `assertRegisteredItemField`
- `assertRegisteredItemType`
- `assertRegisteredProfile`
- `assertRegisteredServiceOverride`
- `assertRegisteredMigration`
- `assertExtensionCapabilityUsage`
- `assertExtensionBlueprint` (throwing preflight; pairs with `lintExtensionBlueprint`)
- `assertExtensionManifestMatchesBlueprint` (strict manifest↔blueprint capability guard)
- `assertExtensionManifestCompatible` (throwing version-bound guard; pairs with `checkExtensionManifestCompatibility`)
- `assertExtensionPreflight` (one-line throwing capstone over `preflightExtension`; replaces chaining the three asserts above)
- `describeExtensionActivation`
- `describeExtensionBlueprint` / `lintExtensionBlueprint` (also surfaced here for the full author → describe → preflight → test loop)
- `renderExtensionSurfaceMarkdown` (render the describe summary to a drift-free Markdown reference; powers `describe --markdown`)

`createExtensionTestHarness(module, options)` is the recommended entry point and
the ergonomic capstone over every standalone helper below: it activates the
module once and returns a fluent `ExtensionTestHarness` whose `assert*`/`run*`
methods are pre-bound to the correct activation sub-registry, so a package author
never threads `activation.registrations` vs `activation.commands` vs
`activation.hooks` (etc.) by hand — picking the wrong one is a common footgun that
surfaces as a confusing `available: (none)` error. Write
`const ext = await createExtensionTestHarness(module, { capabilities: ["commands"] })`,
then `ext.assertCommandContract({ command })`, `await ext.runCommand({ command })`,
`ext.activationSummary()`, `ext.renderMarkdown({ title: "My package" })`, and
`await ext.deactivate()`. `activationSummary()` returns the same
`ExtensionActivationSummary` as `describeExtensionActivation(ext.activation)`;
`renderMarkdown()` feeds that summary through `renderExtensionSurfaceMarkdown`,
with an optional `extensionName` filter for scoped package docs. The methods do
not use `this`, so they remain safe to destructure
(`const { runCommand, renderMarkdown } = ext;`), and the raw `ext.activation`
stays public as an escape hatch to the standalone helpers for any surface a
convenience method does not cover.

`assertExtensionCapabilityUsage(activation, { declared })` is the least-privilege
counterpart of the per-surface `assertRegistered*` helpers: pass the same
capabilities as your `manifest.capabilities` and it fails the test when the
manifest grants a capability the extension never registers against. Use
`allowUnused` for capabilities a runtime registers only behind a config flag.

`deactivateExtensionForTest(module, options)` is the teardown counterpart to
`activateExtensionForTest`: it runs pm's real `deactivateExtensions` engine
(including the bounded per-hook timeout and best-effort failure capture) over the
module and returns the `ExtensionDeactivationResult`, so a package can prove its
`deactivate` releases the resources `activate` opened. `assertExtensionDeactivated(result)`
asserts the single-extension happy path (one extension deactivated, none failed)
by default; pass `{ deactivated, failed }` to assert other counts. Forward the
`activation` result and `deactivateTimeoutMs` to mirror real host teardown.

`runRegisteredCommandForTest(activation.commands, { command, args, options, global, pmRoot })`
is the "invoke" verb that completes the package-author testing loop —
`activateExtensionForTest` → `assertRegisteredCommandContract` → **run** →
`deactivateExtensionForTest`. It dispatches a registered command handler through
pm's real engine and returns the `CommandHandlerResult`, so a test can assert
*behavior* (`result.result`) rather than only that the command is wired. The
`CommandHandlerContext` is built with agent-safe global defaults
(`{ json: true, quiet: true, noPager: true }`) that callers may override. A clean
run yields `{ handled: true, result, warnings: [] }`; a handler that throws a
non-exit error yields `{ handled: false, warnings: [code], errorMessage }` so the
failure can be asserted, while one that throws an error carrying a numeric
`exitCode` propagates the throw. An unregistered command throws a descriptive
error listing the available handler command paths. Because
`registerImporter`/`registerExporter` register handlers under `"<name> import"` /
`"<name> export"`, the same helper exercises importer and exporter handlers too.

The remaining runtime surfaces an extension can register have matching invoke
helpers, so the "invoke" verb covers the whole command pipeline — not just
command handlers:

- `runRegisteredHookForTest(activation.hooks, { kind, context })` fires every
  registered lifecycle hook of a `kind` (`before_command` | `after_command` |
  `on_read` | `on_write` | `on_index`) through pm's real hook runner and returns
  the warnings array (`[]` = clean; a thrown hook contributes one
  `extension_hook_failed:*` warning while the others still run). The `context` is
  type-safe per `kind`.
- `runRegisteredParserOverrideForTest(activation.parsers, context)` returns the
  rewritten `ParserOverrideResult` (args/options/global the override produces
  before dispatch).
- `runRegisteredPreflightOverrideForTest(activation.preflight, context)` returns
  the `PreflightOverrideResult` (the migration/format gate decision).
- `runRegisteredCommandOverrideForTest(activation.commands, context)` returns the
  `CommandOverrideResult` (the transformed command result payload).
- `runRegisteredRendererOverrideForTest(activation.renderers, context)` returns
  the `RendererOverrideResult` (the custom string rendered for an output format).
- `runRegisteredServiceOverrideForTest(activation.services, context)` returns the
  `ServiceOverrideResult` (how the override handles an internal service payload).

Each override helper guards that a matching override is registered for the target
(command / format / service), so a typo surfaces as a descriptive error rather
than a silent `overridden: false` / `handled: false`.

The *executable registration* surfaces — search providers, vector store
adapters, schema migrations, importers, and exporters — also have invoke helpers,
so every executable register\* method has both an `assertRegistered*` and a
`runRegistered*ForTest` counterpart. Each exercises the real registered behavior,
not a re-implementation, but along two execution paths that mirror how the host
runs them. Providers, adapters, and migrations are resolved through the same
runtime resolver the host uses and invoked via their `runtime_definition` (the
clone that preserves live functions). Importers and exporters have no standalone
`runtime_definition` — `registerImporter`/`registerExporter` wrap their handler
into a command path, so their helpers resolve by name and dispatch through the
command runner instead, returning a `CommandHandlerResult`:

- `runRegisteredSearchProviderForTest(activation.registrations, { provider, operation, context })`
  resolves a registered provider by name (case-insensitive, last registration
  wins) and invokes one `operation` — `query`, `embed`, `embedBatch`,
  `queryExpansion`, or `rerank` — returning that operation's result. The
  `context` and return type are inferred from `operation`, and the camelCase /
  snake_case spellings the host accepts (`embedBatch`/`embed_batch`,
  `queryExpansion`/`query_expansion`) both resolve.
- `runRegisteredVectorStoreAdapterForTest(activation.registrations, { adapter, operation, context })`
  resolves a registered adapter by name and invokes `query` (returns
  `VectorStoreQueryHit[]`), `upsert`, or `delete`.
- `runRegisteredMigrationForTest(activation.registrations, { migration, extensionName?, pmRoot? })`
  resolves a registered migration by id and invokes its `run` with a context
  mirroring the host's (`command: "migration"`, the registering extension's
  layer/name, the supplied `pmRoot`, and the migration's normalized status),
  returning whatever `run` returns. Unlike the host — which skips applied
  migrations and folds a throw into a warning — it always invokes `run` and lets a
  throw propagate, so both success and failure are assertable.
- `runRegisteredImporterForTest(activation, { importer, extensionName?, args?, options?, global?, pmRoot? })`
  and `runRegisteredExporterForTest(activation, { exporter, ... })` resolve a
  registered importer/exporter by name, derive the `"<name> import"` /
  `"<name> export"` command path internally — so authors never hand-build it — and
  validate that the name is genuinely a registered importer/exporter before
  dispatching. They take the whole `activation` because resolution spans two
  sub-registries (`registrations` proves it exists, `commands` holds the wrapped
  handler), and they return the command runner's `CommandHandlerResult` verbatim,
  so `handled`/`warnings`/`errorMessage` semantics and `exitCode` propagation match
  invoking the importer/exporter as a command.

Each surface helper guards that the named provider / adapter / migration /
importer / exporter is registered (and, for providers and adapters, implements the
requested operation), so a typo surfaces as a descriptive error rather than a
silent no-op. All invoke helpers are `async`, so a test always `await`s them.

`describeExtensionActivation(activation, { extensionName })` is the **describe**
(enumerate-all) verb that complements the `assertRegistered*` (verify-one) and
`runRegistered*ForTest` (invoke-one) helpers. The activation result already
carries per-surface *counts*; this returns the *names*. It walks every
sub-registry once and returns a flat `ExtensionActivationSummary` whose arrays
are de-duplicated and locale-sorted (except `hooks`, emitted in canonical
lifecycle order to mirror `hook_counts`) of every registered surface's
identifiers — command paths, hook kinds, item-type /
field names, migration ids, importer / exporter / provider / adapter names,
overridden service names and renderer formats, flag target-commands, and the
preflight-override count — plus the `capabilities` those surfaces exercise. Two
uses:

```ts
import { describeExtensionActivation } from "@unbrained/pm-cli/sdk/testing";

const summary = describeExtensionActivation(activation);
// Least-privilege check: assert the WHOLE registration surface in one deepEqual.
assert.deepEqual(summary.commands, ["greet hello"]);
assert.deepEqual(summary.hooks, ["after_command"]);
assert.deepEqual(summary.capabilities, ["commands", "hooks"]);
```

Without `extensionName` the summary unions every extension in the activation;
with it (matched case-insensitively after trimming, like
`collectUsedExtensionCapabilities`) only that extension's registrations
contribute. The three command fields capture distinct dimensions and can
overlap: `commands` lists definitions declared via `registerCommand(definition)`,
`command_handlers` lists every command path backed by an extension handler (a
superset that also includes the synthesized `"<name> import"` / `"<name> export"`
importer/exporter paths), and `command_overrides` lists built-in commands
replaced via `registerCommand(name, override)`. For agents, one call returns the
entire surface instead of traversing fifteen-plus sub-registries — keeping the context
window lean ("project management = context management").

The same verb is reachable from the CLI and MCP without writing a test:
`pm extension describe [name]` / `pm package describe [name]` (and `pm_run` with
`action: "extension"`/`"package"` and `describe: true`) activate the workspace's
extensions and return each loaded extension's `ExtensionActivationSummary` under
`details.extensions[].surfaces`, plus a deduplicated `details.union`. Omit the name
to map every loaded package; pass one to scope to it. This is the agent-facing answer
to "what does this installed package add to my context?" — distinct from
`pm package doctor` (errors/policy) and `pm package manage` (update metadata), which
report only command/action paths, not the full registration surface.

`renderExtensionSurfaceMarkdown(summary, options?)` is the **render** leg of the
describe verb: it projects any `ExtensionActivationSummary` to a deterministic
Markdown reference document — a title heading, a one-line capabilities summary,
and a section per registered surface. Pipe `describeExtensionBlueprint(blueprint)`
straight into it during a build or test step and embed the result in your
README, and the "commands & capabilities" reference can never drift from the
surface the loader actually registers ("project management = context
management"). `options.title` / `options.headingLevel` (an integer in `[1, 6]`,
default `2`; section headings render one level deeper) control nesting, and
`options.includeEmpty` renders every section (as `_None._`) rather than omitting
empty ones.

```ts
import { describeExtensionBlueprint, renderExtensionSurfaceMarkdown } from "@unbrained/pm-cli/sdk";

const reference = renderExtensionSurfaceMarkdown(describeExtensionBlueprint(blueprint), { title: "my-pkg", headingLevel: 2 });
// → "## my-pkg\n\nCapabilities: `commands`, `schema`\n\n### Commands\n\n- `greet hello`\n…"
```

The same renderer powers `pm extension describe --markdown` / `pm package
describe --markdown`, which compose a per-extension section plus a union section
across every loaded extension. Add `--output docs/package-reference.md` to write
the generated Markdown directly to a file for README/reference-doc refreshes.
`--markdown` is a presentation format (it cannot be combined with `--json`);
MCP `describe` keeps returning the structured summary, which a caller can hand to
`renderExtensionSurfaceMarkdown` itself.

Commander option contract exports:

- `CREATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS`
- `UPDATE_COMMANDER_OPTION_REGISTRATION_CONTRACTS`
- `CREATE_COMMANDER_STRING_OPTION_CONTRACTS`
- `CREATE_COMMANDER_REPEATABLE_OPTION_CONTRACTS`
- `UPDATE_COMMANDER_STRING_OPTION_CONTRACTS`
- `UPDATE_COMMANDER_REPEATABLE_OPTION_CONTRACTS`
- `LIST_COMMANDER_STRING_OPTION_CONTRACTS`
- `SEARCH_COMMANDER_STRING_OPTION_CONTRACTS`
- `CALENDAR_COMMANDER_STRING_OPTION_CONTRACTS`
- `CONTEXT_COMMANDER_STRING_OPTION_CONTRACTS`
- `ACTIVITY_COMMANDER_STRING_OPTION_CONTRACTS`
- `readFirstStringFromCommanderOptions`
- `readStringArrayFromCommanderOptions`

Extension runtime contract exports:

- `PM_EXTENSION_CAPABILITY_CONTRACTS`
- `PM_EXTENSION_SERVICE_NAME_CONTRACTS`
- `PM_EXTENSION_POLICY_MODE_CONTRACTS`
- `PM_EXTENSION_POLICY_SURFACE_CONTRACTS`
- `PM_EXTENSION_TRUST_MODE_CONTRACTS`
- `PM_EXTENSION_SANDBOX_PROFILE_CONTRACTS`

Least-privilege capability reconciliation exports (map declared capabilities to
the registration surfaces a package actually exercises at activation):

- `EXTENSION_CAPABILITY_REGISTRATION_SURFACES`
- `collectUsedExtensionCapabilities`
- `reconcileExtensionCapabilityUsage`

Common types:

- `ExtensionApi`
- `ExtensionActivationSummary`
- `ExtensionManifest`
- `ExtensionManifestEngines`
- `CommandDefinition`
- `FlagDefinition`
- `ImportExportRegistrationOptions`
- `ServiceOverrideContext`
- `PmCliExpectedError`
- `CreatePmCliExpectedErrorOptions`
- `SchemaFieldDefinition`
- `SchemaItemTypeDefinition`
- `SearchProviderDefinition`
- `VectorStoreAdapterDefinition`
- `GlobalOptions`
- `ItemDocument`
- `PmSettings`

## Static And Runtime Contracts

`PM_TOOL_ACTIONS` and `PM_TOOL_PARAMETERS_SCHEMA` describe the always-on static core action surface. They include core project-management primitives, package lifecycle actions, and `upgrade`.

Package-owned actions such as `beads-import`, `todos-export`, `calendar`, and `templates-save` are intentionally not advertised as static core actions. Discover installed package actions with runtime contracts:

```bash
pm contracts --runtime-only --json
pm contracts --action calendar --runtime-only --schema-only --json
pm contracts --command templates --runtime-only --flags-only --json
```

Use static SDK contracts for baseline validation, then use runtime contracts in the target project before invoking package-provided commands or actions. Embedded SDK consumers can avoid subprocesses:

```ts
import { getContracts } from "@unbrained/pm-cli/sdk";

const contracts = await getContracts("/path/to/project/.agents/pm", {
  runtimeOnly: true,
  flagsOnly: true,
});
```

For item-type context, use the CLI inspection primitives before issuing custom-domain mutations:

```bash
pm schema list --json
pm schema show Experiment --json
```

`schema list/show` include built-in, persisted custom, and extension-provided item types. Extension-provided types include provenance (`layer` and package/extension name) in `show --json`, which helps agents decide whether a missing type should be registered persistently with `pm schema add-type`, added through `pm init --type-preset`, or provided by an installed package.

When a package-owned command is missing at runtime, CLI usage guidance now includes a deterministic install hint (for example `pm install calendar` or `pm install search-advanced`) so agents can recover in one retry.

Package installs currently activate only extension resources. Additional package resource kinds (`docs`, `examples`, `assets`, `prompts`) are metadata-first and available through package manifest/catalog inspection.

Package tests can assert the normalized manifest through the SDK without
reimplementing resource sorting, alias normalization, or package.json parsing:

```ts
import {
  assertPackageManifest,
  readPmPackageManifest,
} from "@unbrained/pm-cli/sdk";

const manifest = await readPmPackageManifest(packageRoot);

assertPackageManifest(manifest, {
  packageName: "@acme/pm-incident-workflow",
  aliases: ["incident-workflow"],
  resources: {
    extensions: ["extensions/incident-workflow"],
    docs: ["README.md"],
    examples: ["examples/basic.md"],
    assets: ["assets/workflow-diagram.png"],
    prompts: ["prompts/triage.md"],
  },
});
```

Package tests can also assert extension registrations without importing private
loader internals. Prefer `createExtensionTestHarness` — its `assert*`/`run*`
methods bind to the right sub-registry for you:

```ts
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

const ext = await createExtensionTestHarness(extensionModule, { capabilities: ["commands", "schema"] });

ext.assertCommandContract({ command: "incident triage", flags: ["--severity"] });
ext.assertFlags({ targetCommand: "list", flags: ["--incident-filter"] });
const { result } = await ext.runCommand({ command: "incident triage", options: { severity: "high" } });
const summary = ext.activationSummary();
const reference = ext.renderMarkdown({ title: "incident package surfaces" });
await ext.deactivate();
```

For provider-safe schemas, use `PM_PROVIDER_TOOL_PARAMETERS_SCHEMA`. It is flat and avoids advanced schema constructs such as root `oneOf`.

## Capability Requirements

| Registration | Manifest capability |
|--------------|---------------------|
| `registerCommand` | `commands` |
| inline command flags | `schema` |
| `registerFlags` | `schema` |
| `registerItemFields` | `schema` |
| `registerItemTypes` | `schema` |
| `registerMigration` | `schema` |
| `registerProfile` | `schema` |
| `registerImporter` | `importers` |
| `registerExporter` | `importers` |
| `registerParser` | `parser` |
| `registerPreflight` | `preflight` |
| `registerService` | `services` |
| `registerRenderer` | `renderers` |
| lifecycle hooks | `hooks` |
| `registerSearchProvider` | `search` |
| `registerVectorStoreAdapter` | `search` |

Some override surfaces are single-winner: command overrides, parser overrides, preflight overrides, and output renderers. Keep those handlers narrowly scoped and verify package combinations with:

```bash
pm package doctor --project --detail deep --trace
pm health --check-only --brief
```

Collision warnings are deterministic and include package names plus deactivation guidance.
If extension code calls a `register*` API without declaring the matching
manifest capability, activation fails with
`extension_capability_missing:<name>:<capability>` in doctor triage. Run doctor
with `--trace` to see the exact method, `missing_capability`, and manifest
capability entry to add before publishing.

## Minimal Command Extension

```ts
import { defineExtension } from "@unbrained/pm-cli/sdk";

export default defineExtension({
  activate(api) {
    api.registerCommand({
      name: "hello",
      action: "hello",
      description: "Return a deterministic hello payload.",
      intent: "verify SDK extension activation",
      examples: ["pm hello"],
      failure_hints: ["Run pm package doctor --detail deep --trace on activation failures."],
      run: async () => ({ ok: true, message: "hello" }),
    });
  },
});
```

Manifest:

```json
{
  "name": "hello",
  "version": "0.1.0",
  "entry": "./index.ts",
  "pm_min_version": "2026.5.31",
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

`pm_min_version` is an inclusive minimum pm CLI version. When the installed CLI is older than the manifest requires, discovery emits `extension_pm_min_version_unmet:<layer>:<name>:required=<version>:current=<version>` and does not load the extension. Use a plain numeric version such as `2026.5.31`; `>=2026.5.31` is accepted for compatibility with `engines.pm`, but ranges beyond an inclusive minimum are not interpreted.

Manifest typing also accepts optional `engines` metadata:

```json
{
  "engines": {
    "pm": ">=2026.5.31",
    "node": ">=22.18"
  }
}
```

Use `pm_min_version` for the loader gate. Keep `engines` as package-manager and tooling metadata.
For pure command packages, keep `trusted: true`, `sandbox_profile: "strict"`, and all six permissions set to `false`; relax only the permission keys the package actually needs and verify the result with `pm package doctor --project --detail deep --trace`.

For a complete commands-capability package that combines `registerCommand`,
`registerFlags`, and `registerParser`, see the first-party
[pm-command-kit exemplar](../packages/pm-command-kit/README.md).

For a generated starter, use `pm package init ./my-package`. Pass
`--capability hooks` to scaffold a command plus an `afterCommand` lifecycle
reactor and a runnable `node:test` file that exercises
`activateExtensionForTest`, `assertRegisteredHook`, `runRegisteredHookForTest`,
and `deactivateExtensionForTest`. Pass `--capability search` to scaffold a
command plus a deterministic search provider/vector-store adapter pair and a
runnable `node:test` file that exercises `assertRegisteredSearchProvider`,
`assertRegisteredVectorStoreAdapter`, `runRegisteredSearchProviderForTest`, and
`runRegisteredVectorStoreAdapterForTest`. Pass `--capability importers` to
scaffold paired import/export commands with example flag metadata and a runnable
`node:test` file that exercises `assertRegisteredImporter`,
`assertRegisteredExporter`, `runRegisteredImporterForTest`, and
`runRegisteredExporterForTest`; the generated manifest declares both `importers`
and `schema` because extension flag metadata is schema-governed. Pass
`--capability schema` to scaffold a command plus a custom item type, item field,
and migration (via `registerItemTypes`/`registerItemFields`/`registerMigration`)
and a runnable `node:test` file that exercises `assertRegisteredItemType`,
`assertRegisteredItemField`, `assertRegisteredMigration`, and
`runRegisteredMigrationForTest` — a copyable starting point for modeling a
project domain. Pass `--capability profile` to scaffold a command plus a complete
project-profile archetype (item types, statuses, fields, a per-type workflow,
config, a create template, and package recommendations via `registerProfile`) and
a `node:test` file exercising `assertRegisteredProfile`; it omits
`activation.commands` (granted by the same `schema` capability) so the contributed
profile resolves through `pm profile list/show/apply` and `pm profile apply <name>`
tailors a fresh tracker in one shot — the broadest customization primitive in one
copyable starter.

The four override surfaces complete the matrix to one starter per SDK
registration capability. Pass `--capability renderers` to scaffold a `toon`
output renderer override (via `registerRenderer`, scoped to its own command so
other output passes through) with a `node:test` file exercising
`assertRegisteredRendererOverride` and `runRegisteredRendererOverrideForTest`;
`--capability parser` for a parser override (via `registerParser`) that rewrites
the command's parsed options — the starter command declares matching
`--shout`/`--upper` flags (so the manifest also declares `schema`) and surfaces
the normalized value, making the override runnable through `pm <command> --shout`
— exercising `assertRegisteredParserOverride` and
`runRegisteredParserOverrideForTest`; `--capability preflight` for a preflight
override (via `registerPreflight`) over pm's pre-run migration/format gate
decision, exercising `assertRegisteredPreflightOverride` and
`runRegisteredPreflightOverrideForTest`; and `--capability services` for an
`output_format` service override (via `registerService`, scoped to its own
command), exercising `assertRegisteredServiceOverride` and
`runRegisteredServiceOverrideForTest`.

Every command-bearing variant's generated `manifest.json` also declares
`activation.commands` — the exact command paths the starter registers — so pm
activates the package lazily, importing and running `activate` only when an
invoked command matches. This mirrors every first-party bundled package and is
the contract authors keep in sync with their registrations: an omitted or stale
entry means the matching command will not dispatch from the CLI (globally-scoped
surfaces such as hooks and search providers for built-in search commands still
activate regardless). The `schema` starter is the deliberate exception: it omits
`activation.commands` so its custom item type — a global contribution that
built-in commands like `pm create <type>` must see — activates conservatively for
every command rather than gating on the package's own commands.

Each `--capability` starter authors an imperative `activate` body. To scaffold the
declarative `composeExtension` form instead, pass `--declarative` to
`pm package init` / `pm package scaffold` (it is an init/scaffold flag, package-mode
only — every `--capability` variant emits its blueprint form, since `composeExtension`
is a runtime SDK value import that only package-mode authoring links) — see
[Declarative Authoring](#declarative-authoring). See [EXTENSIONS.md](EXTENSIONS.md)
for the manifest-field reference.

## Self-Identity and Lifecycle

`activate(api)` receives a read-only `api.extension` describing the extension it
was created for, so authors can emit self-identifying logs, gate on their own
version, and build better error messages without re-reading the manifest:

```ts
export default defineExtension({
  activate(api) {
    // api.extension: { name, layer, version, capabilities, pm_min_version?, pm_max_version?, source_package? }
    if (api.extension.version.startsWith("0.")) {
      api.hooks.afterCommand(() => {
        // ...pre-1.0 behaviour, labelled with api.extension.name
      });
    }
  },
});
```

`api.extension.capabilities` is filtered to the canonical capability set, and both
the object and its `capabilities` array are frozen.

Modules may also export an optional VS Code-style `deactivate` teardown hook. The
host runs it on shutdown/reload — the long-running MCP server invokes it between
native-action requests — so an extension can close connections, clear timers, and
release buffers opened during `activate`. `deactivate` runs only for extensions
that activated successfully (a failed `activate` never fully initialized), and
teardowns run concurrently. Teardown is best-effort: a throwing `deactivate` is
recorded as a warning, never propagated, and each hook is bounded by a host
timeout so one extension cannot block another's cleanup or a host reload. Hosts
that call `deactivateExtensions` directly may pass `deactivate_timeout_ms: 0` or
`Infinity` only when they intentionally want to wait indefinitely.

```ts
export default defineExtension({
  activate(api) {
    /* open resources */
  },
  async deactivate() {
    /* close connections, flush sinks, clear timers */
  },
});
```

## Flag Contracts

`FlagDefinition` (used by `registerFlags` and inline command `flags`) supports the
same list/default semantics as core flags:

- `value_type` is the canonical coercion kind (`string` | `number` | `boolean`;
  the aliases `int`/`integer`/`float` and `bool` are also accepted). The
  deprecated `type` alias is still read, but `value_type` wins when both are set
  (`value_type ?? type`). An unrecognized value type is rejected at registration.
- `list: true` makes a repeated, comma-joined flag accumulate into an array —
  parity with core list flags such as `--tags`. `--scope a,b --scope c` resolves
  to `["a", "b", "c"]`, with each element coerced by `value_type`.
- `default` (a scalar, or an array of scalars for a `list` flag) is applied when
  the flag is omitted; for a `list` flag the default is flattened into the
  accumulated array exactly like a provided value — comma-joined strings (e.g.
  `default: "a,b"` or `default: ["a,b", "c"]`) are split into elements. A default
  that would not cleanly coerce under the declared `value_type` (e.g.
  `value_type: "number", default: "abc"`) is rejected at registration.

```ts
api.registerFlags("report", [
  { long: "--scope", value_type: "string", list: true, default: "all" },
  { long: "--limit", value_type: "number", default: 20 },
]);
```

`registerItemFields` validates each declared field `type` against the canonical
coercion kinds (`string`, `number`, `boolean`, `array`, `object`) at activation.
A typo fails activation with a did-you-mean hint (e.g. `type: "strnig"` →
`Did you mean "string"?`) instead of silently passing and failing opaquely at use
time.

## Expected CLI Errors

Package commands should throw expected user/action errors with the public SDK shape so the CLI can preserve exit codes and Sentry can filter expected retry failures:

```ts
import { EXIT_CODE, createPmCliExpectedError } from "@unbrained/pm-cli/sdk";

throw createPmCliExpectedError("hello requires --name", {
  exitCode: EXIT_CODE.USAGE,
  context: {
    code: "missing_name",
    why: "The command needs a target name.",
  },
});
```

The helper returns an `Error` whose public name is `PmCliError` and whose `exitCode` is structural. That makes it safe for bundled, linked, and separately installed package code even when class identity is not shared with the running CLI.

## Package Runtime Imports

Third-party packages should import from stable public SDK subpaths:

```ts
import { defineExtension } from "@unbrained/pm-cli/sdk";
import { createPmCliExpectedError } from "@unbrained/pm-cli/sdk/runtime";
```

`PM_CLI_PACKAGE_ROOT` is reserved for first-party packages bundled inside this repository. Those packages use it to locate the running CLI's `dist/sdk/runtime.js` before they are installed as independent npm packages. External packages must not depend on `PM_CLI_PACKAGE_ROOT`, `dist/` paths, or `src/core/...`; declare `@unbrained/pm-cli` as a dependency or peer dependency and import the public SDK subpaths instead. When pm installs a registry package, it links that dependency to the running host CLI so the package gets the active SDK without downloading a second CLI copy into the project.

## Authoring Builders

Tracked: [pm-12tj](../.agents/pm/features/pm-12tj.toon) (design rationale: ADR [pm-3mph](../.agents/pm/decisions/pm-3mph.toon)).

The `define*` builders are the authoring half of the `author → register → test`
loop: they type a registration definition where you write it, before it ever
reaches `api.register*`. Each is a zero-cost identity function (it returns its
argument unchanged), exactly like `defineExtension` and the wider
`defineConfig`/`defineComponent` ecosystem convention — the value is entirely at
the type level.

pm packages are authored **and loaded** as TypeScript (ADR
[pm-2c28](../.agents/pm/decisions/pm-2c28.toon) / [pm-m1uz](../.agents/pm/decisions/pm-m1uz.toon)). A bare `const cmd = { ... }`
satisfies the registration types only structurally and widens its literals;
wrapping it in a builder checks the object against the contract *and* preserves
the narrow literal types, while inferring the nested handler's `context`
parameter from the builder signature — the same ergonomics `defineConfig` gives a
Vite config. It also lets you colocate, export, reuse, and unit-test a definition
apart from `activate`:

```ts
import { defineCommand, defineAfterCommandHook } from "@unbrained/pm-cli/sdk";
import type { ExtensionApi } from "@unbrained/pm-cli/sdk";

// `context` is inferred from the builder signature; the literal name/action are preserved.
export const greetCommand = defineCommand({
  name: "greet hello",
  action: "greet-hello",
  description: "Say hello.",
  run: (context) => ({ greeting: `hi ${context.args[0] ?? "world"}` }),
});

export const auditHook = defineAfterCommandHook((context) => {
  if (!context.ok) return;
  // react to context.affected — "project management = context management"
});

export function activate(api: ExtensionApi): void {
  api.registerCommand(greetCommand);
  api.hooks.afterCommand(auditHook);
}
```

Object-definition builders (`defineExtensionManifest`, `defineCommand`,
`defineFlag`, `defineItemType`, `defineItemField`, `defineMigration`,
`defineSearchProvider`, `defineVectorStoreAdapter`) preserve the narrow literal
type. `defineExtensionManifest` additionally contract-checks the in-module
manifest mirror where it is authored and pairs with `deriveExtensionCapabilities`
(see [Declarative Authoring](#declarative-authoring)). Function-definition
builders (`defineCommandOverride`, `defineParserOverride`,
`definePreflightOverride`, `defineServiceOverride`, `defineRendererOverride`,
`defineImporter`, `defineExporter`, and the five hook builders
`defineBeforeCommandHook` / `defineAfterCommandHook` / `defineOnWriteHook` /
`defineOnReadHook` / `defineOnIndexHook`) are non-generic so a bare arrow's
parameter is contextually typed instead of falling back to `any`. The
[`assertRegistered*`](#testing-helpers) helpers below verify these same
definitions once registered.

## Declarative Authoring

Tracked: [pm-iqq0](../.agents/pm/features/pm-iqq0.toon).

`composeExtension` is the capstone of the `author → register → test` loop. Instead
of hand-wiring each `api.register*` call inside an imperative `activate(api)`
body — calling the right method, in the right order, without forgetting one —
describe **what** to register as a plain `ExtensionBlueprint` object and let the
SDK generate the `activate` for you. Every field is optional; populate the
surfaces you use (ideally with `define*`-authored definitions) and leave the rest
out:

```ts
import { composeExtension, defineCommand, deriveExtensionCapabilities } from "@unbrained/pm-cli/sdk";
import type { ExtensionBlueprint } from "@unbrained/pm-cli/sdk";

const echo = defineCommand({
  name: "command-kit echo",
  action: "command-kit-echo",
  description: "Echo a message as structured output.",
  run: (context) => ({ message: context.args.join(" ") }),
});

const blueprint: ExtensionBlueprint = {
  commands: [echo],
  parsers: { "command-kit echo": (context) => ({ options: context.options }) },
  flags: { list: [{ long: "--kit-note", value_type: "string", value_name: "text" }] },
};

// The generated `activate` registers commands → overrides → flags → parsers →
// renderers → services → preflights → item types → item fields → migrations →
// search providers → vector store adapters → importers → exporters → hooks, then
// awaits any imperative `activate` you also pass (an escape hatch run last).
export default composeExtension(blueprint);
```

`deriveExtensionCapabilities(blueprint)` returns the exact least-privilege
capability set the blueprint exercises (sorted, de-duplicated), so you can author
`manifest.json` `capabilities` with zero declared-but-unused or used-but-undeclared
drift. It is the author-time inverse of the runtime
[`reconcileExtensionCapabilityUsage`](#capability-requirements) check, and the set
it returns is the set `composeExtension`'s generated `activate` requires — they
agree by construction:

```ts
deriveExtensionCapabilities(blueprint); // ["commands", "parser", "schema"]
```

The blueprint's record-keyed fields (`commandOverrides`, `flags`, `parsers`,
`renderers`, `services`) map a routing key to its handler, mirroring the
two-argument `api.register*` overloads; `hooks` groups the five lifecycle kinds.
`composeExtension` is a pure assembler: it does not validate definitions —
per-surface contract enforcement stays in `api.register*` and the loader, so a
malformed definition surfaces the same activation diagnostic as a hand-written
`activate`. The bundled first-party packages intentionally keep import-free
hand-written `activate` bodies so they load in extension-only installs; reach for
`composeExtension` in npm package-mode authoring where the SDK is a dependency.

For a generated starting point, `pm package init <path> --declarative` scaffolds
this loop end to end for any `--capability`: an `index.ts` that authors a
`defineExtensionBlueprint` blueprint (the capability's surfaces wired through the
`define*` builders) and exports `composeExtension(blueprint)`, plus an
`index.test.ts` that guards it with the author-time `assertExtensionPreflight`
capstone and exercises the composed module through `createExtensionTestHarness`. It
is package-mode only (`composeExtension` is a runtime SDK value import, so it belongs
in package-mode authoring where the SDK is a linked dependency, not the import-free
extension-only starters).

### Modular blueprints

Tracked: [pm-high](../.agents/pm/tasks/pm-high.toon),
[pm-nvgy](../.agents/pm/tasks/pm-nvgy.toon).

A large extension's surface does not have to live in one object. `mergeExtensionBlueprints(...blueprints)`
combines several partial blueprints into one — a commands module, a search module,
a hooks module — so each concern is authored (and tested) in its own file and
assembled at the entry point. Wrap each fragment in `defineExtensionBlueprint(...)`
so it is contract-checked at its own definition site (with editor completion) —
the blueprint-level companion to `defineExtension` (a whole module) and
`defineExtensionManifest` (a manifest):

```ts
// commands.ts
import { defineExtensionBlueprint } from "@unbrained/pm-cli/sdk";
export const commandsModule = defineExtensionBlueprint({
  commands: [{ name: "kit run", action: "kit-run", run: () => ({ ok: true }) }],
});
```

```ts
// index.ts — the manifest entry; import sibling .ts modules by their real extension (loaded directly via native type stripping).
import { composeExtension, mergeExtensionBlueprints } from "@unbrained/pm-cli/sdk";
import { commandsModule } from "./commands.ts";
import { searchModule } from "./search.ts";

export default composeExtension(mergeExtensionBlueprints(commandsModule, searchModule));
```

The merge is pure, deterministic, and never mutates an input. Each surface combines
the way its `api.register*` call composes: array surfaces (`commands`, `itemTypes`,
`migrations`, `searchProviders`, `importers`, …) concatenate in order; `flags`
concatenates the flag arrays of a shared target command; single-handler records
(`commandOverrides`, `parsers`, `renderers`, `services`) take last-defined-wins
precedence on a key collision; `hooks` concatenate per lifecycle kind; imperative
`activate` hatches chain forward (acquisition order) while `deactivate` hooks chain
in reverse (LIFO teardown); the `manifest` mirror is last-defined-wins. Because the
result is an ordinary blueprint, every downstream helper (`deriveExtensionCapabilities`,
`describeExtensionBlueprint`, `lintExtensionBlueprint`, `preflightExtension`) reads it
exactly as it would a hand-written one — a command two modules both define survives
as a duplicate and `lintExtensionBlueprint` flags it. Merging zero blueprints returns
an empty blueprint (`{}`).

### Generate the manifest (author once)

Tracked: [pm-u5le](../.agents/pm/features/pm-u5le.toon).

`deriveExtensionCapabilities` gives you only the capability set; every other
manifest field is still yours to hand-write. `synthesizeExtensionManifest(blueprint, identity)`
closes that gap — it is the **generate** verb that completes the declarative loop
(`compose → derive → describe/lint → synthesize`). Supply the identity fields a
blueprint cannot determine (`name`, `version`, `entry`, `priority`, plus any
optional `engines`/`permissions`/version floors/etc.) and it returns a complete
`ExtensionManifest` with `capabilities` derived, sorted, and de-duplicated. Write
the blueprint once; never hand-sync `capabilities` again:

```ts
import { synthesizeExtensionManifest } from "@unbrained/pm-cli/sdk";

const manifest = synthesizeExtensionManifest(blueprint, {
  name: "command-kit",
  version: "1.0.0",
  entry: "./index.ts",
  priority: 0,
});
manifest.capabilities; // ["commands", "parser", "schema"] — derived, not hand-written
```

Where `defineExtensionManifest` only *types* a manifest you wrote by hand, this
*generates* it. For the rare surface registered through the imperative `activate`
escape hatch (invisible to static derivation — e.g. a renderer wired in
`activate`), pass `additionalCapabilities` and they are unioned in (legacy-alias
resolved, unknown names dropped). Use the result as the on-disk `manifest.json`
content or the in-module `manifest` mirror; guard a hand-maintained manifest
against drift with `assertExtensionManifestMatchesBlueprint` (below).

### Ship both halves (author once)

Tracked: [pm-cn0c](../.agents/pm/tasks/pm-cn0c.toon).

`composeExtension` produces the runtime module; `synthesizeExtensionManifest`
produces the manifest. `composeExtensionPackage(blueprint, identity)` is the
author-once capstone that returns both halves of a shippable package from one call,
with the synthesized manifest set as the module's authoritative in-module mirror —
so the runtime module and the on-disk `manifest.json` are generated from one source
and cannot drift:

```ts
import { composeExtensionPackage } from "@unbrained/pm-cli/sdk";

const { module, manifest } = composeExtensionPackage(blueprint, {
  name: "command-kit",
  version: "1.0.0",
  entry: "./index.ts",
  priority: 0,
});
export default module;          // the package entry's default export
// write `manifest` verbatim as manifest.json — capabilities derived, never hand-synced
```

It is a pure assembler (no validation, loading, or filesystem access), exactly like
the two functions it composes; pair it with `preflightExtension` /
`assertExtensionPreflight` for the author-time verify step. Combined with
`mergeExtensionBlueprints`, the full declarative loop is: author each concern with
`define*`, assemble them modularly with `mergeExtensionBlueprints`, then ship both
halves with `composeExtensionPackage`.

### Author-time introspection and preflight

Tracked: [pm-tlpv](../.agents/pm/features/pm-tlpv.toon),
[pm-9ect](../.agents/pm/features/pm-9ect.toon),
[pm-4oio](../.agents/pm/decisions/pm-4oio.toon).

Two pure, no-activation helpers complete the loop, so a blueprint is fully
inspectable and verifiable before it is ever loaded — the author-time inverse of
the runtime guardrails (the same discipline as `deriveExtensionCapabilities`
inverting [`reconcileExtensionCapabilityUsage`](#capability-requirements)):

```ts
import { describeExtensionBlueprint, lintExtensionBlueprint } from "@unbrained/pm-cli/sdk";

// describeExtensionBlueprint returns the same ExtensionActivationSummary shape as
// the runtime describeExtensionActivation — but from the blueprint data alone, no
// activation. It is to the named surfaces what deriveExtensionCapabilities is to
// the capability set.
describeExtensionBlueprint(blueprint).command_handlers; // ["command-kit echo", ...]

// lintExtensionBlueprint preflights for the footguns activation would otherwise
// surface late: a capability a surface exercises but the manifest omits is an
// `error` (the loader throws extension_capability_missing); a declared-but-unused
// capability, a duplicate command, a command/override conflict, and a present-but-
// empty surface are `warning`s. Pass declaredCapabilities or set manifest.capabilities.
const report = lintExtensionBlueprint(blueprint, { declaredCapabilities: ["commands", "parser", "schema"] });
report.ok;       // false if any error-severity finding
report.findings; // [{ code, severity, message, capability?/command?/field? }, ...]
```

Both read only the declarative data, so the imperative `activate` escape hatch is
invisible to them — a blueprint that registers everything through that hatch
summarizes as empty and lints clean. In a package test, `assertExtensionBlueprint`
(below) turns the lint into a one-line CI guard.

## Testing Helpers

Package tests can assert registration contracts without depending on Vitest-specific
helpers. Every assertion normalizes the expected name, returns the matched registration
entry, and throws an `Error` that lists what _is_ available when the expectation is
missing. They are exported from both `@unbrained/pm-cli/sdk/testing` and the main
`@unbrained/pm-cli/sdk` barrel.

Activate an in-memory extension module without private loader imports:

```ts
import {
  activateExtensionForTest,
  assertRegisteredCommandContract,
} from "@unbrained/pm-cli/sdk/testing";

const activation = await activateExtensionForTest({
  manifest: {
    name: "hello-ext",
    version: "0.1.0",
    entry: "./index.ts",
    priority: 0,
    capabilities: ["commands", "schema"],
  },
  activate(api) {
    api.registerCommand({
      name: "hello",
      action: "hello",
      description: "Return a deterministic hello payload.",
      flags: [{ long: "--name", value_type: "string" }],
      run: async () => ({ ok: true }),
    });
  },
});

assertRegisteredCommandContract(activation.registrations, {
  command: "hello",
  action: "hello",
  flags: ["--name"],
});
```

`activateExtensionForTest` uses the real pm activation engine and capability
guardrails, but it does not discover files or install packages. Use it for unit
tests of extension registration shape; keep `pm package doctor` and runtime
contracts in integration tests.

For declarative (`composeExtension`) packages, `assertExtensionBlueprint(blueprint, options?)`
is the `assert*` family member that preflights the blueprint *without* activating
it — it runs `lintExtensionBlueprint` and throws if any finding is error-severity
(today: a capability a surface exercises but the declared set omits, which would
fail activation with `extension_capability_missing`). It returns the full
`ExtensionBlueprintLintResult` on success so a test can still inspect advisory
warnings:

```ts
import { assertExtensionBlueprint } from "@unbrained/pm-cli/sdk/testing";

// Throws if the blueprint and its declared capabilities have drifted; otherwise
// returns the lint result (including any non-blocking warnings) for inspection.
const report = assertExtensionBlueprint(blueprint);
```

`assertExtensionManifestMatchesBlueprint(manifest, blueprint)` is the **strict**
bookend to that lenient preflight: where `assertExtensionBlueprint` only fails on
an *undeclared* capability and merely warns on an unused one, this assertion fails
on **both** — so a hand-maintained `manifest.json` stays exactly the least-privilege
set the blueprint requires (assert what `synthesizeExtensionManifest` would
otherwise generate). Only `capabilities` are reconciled, since that is the one
manifest field a blueprint determines:

```ts
import { assertExtensionManifestMatchesBlueprint } from "@unbrained/pm-cli/sdk/testing";

// Throws if manifest.capabilities is missing any capability the blueprint uses, or
// declares any the blueprint never exercises. Returns { used, declared, missing,
// unused, findings } on an exact match.
assertExtensionManifestMatchesBlueprint(manifest, blueprint);
```

Where the blueprint guards `capabilities`, a manifest's `pm_min_version` /
`pm_max_version` bounds guard *which pm CLI versions the package supports*.
Tracker references: `pm-knma` introduced `checkExtensionManifestCompatibility`;
`pm-hng2` introduced `assertExtensionManifestCompatible`.
`checkExtensionManifestCompatibility(manifest, { pmVersion, pmMaxVersionExceededMode? })`
is the author-time inverse of the loader's runtime version gate: it takes the pm
version you target and returns structured per-bound findings (the same
`extension_pm_*_version_*` outcomes the loader emits), so you can verify the window
without installing the package against a real CLI. `assertExtensionManifestCompatible`
is the throwing CI guard — it fails on a blocking incompatibility (a malformed
bound, a `pm_min_version` the target is below, or a `block`-mode `pm_max_version`
the target exceeds) and stays quiet on advisory `*_unchecked` / `*_exceeded_warn`
warnings, which still load:

```ts
import { checkExtensionManifestCompatibility } from "@unbrained/pm-cli/sdk";
import { assertExtensionManifestCompatible } from "@unbrained/pm-cli/sdk/testing";

// Inspect every bound outcome against a target version…
const report = checkExtensionManifestCompatibility(manifest, { pmVersion: "2026.6.23" });
//   report.compatible === false, report.findings[0].code === "pm_min_version_unmet", …

// …or fail the package's own suite when a bound would block the load.
assertExtensionManifestCompatible(manifest, { pmVersion: "2026.6.23" });
```

Tracked: [pm-ozaf](../.agents/pm/features/pm-ozaf.toon).

`preflightExtension(blueprint, { identity?, target?, declaredCapabilities? })` is the
author-time **capstone** that runs all of the above in one call — the static analog
of `createExtensionTestHarness`, which unified the runtime-test helpers. Rather than
chaining `lintExtensionBlueprint`, `synthesizeExtensionManifest`, and
`checkExtensionManifestCompatibility` (and reconciling their separate results)
before publishing, you read one `ExtensionPreflightReport`: the blueprint is always
linted; when `identity` is given the complete least-privilege manifest is synthesized
and returned; when `target` is given the synthesized bounds (or, absent an identity,
the blueprint's in-module `manifest` mirror) are version-checked. The per-stage
results are exposed unmodified (`report.blueprint` / `report.manifest` /
`report.compatibility`) alongside a flattened `report.findings` where each entry is
tagged by `source` (`"blueprint"` | `"compatibility"`); `report.ok` is `false` if any
stage produced an `error`. `assertExtensionPreflight(blueprint, options?)` is the
throwing one-line CI guard over it — it fails listing every blocking finding tagged
`[source:code]` and stays quiet on advisory warnings, returning the full report on
success:

```ts
import { preflightExtension } from "@unbrained/pm-cli/sdk";
import { assertExtensionPreflight } from "@unbrained/pm-cli/sdk/testing";

// Inspect every author-time stage in one report…
const report = preflightExtension(blueprint, {
  identity: { name: "command-kit", version: "1.0.0", entry: "./index.ts", priority: 0 },
  target: { pmVersion: "2026.6.23" },
});
//   report.manifest.capabilities (derived), report.compatibility.compatible, report.findings[]

// …or guard the whole package in one CI line.
assertExtensionPreflight(blueprint, {
  identity: { name: "command-kit", version: "1.0.0", entry: "./index.ts", priority: 0 },
  target: { pmVersion: "2026.6.23" },
});
```

Invoke a registered command handler to assert its behavior (not just that it was
registered). `runRegisteredCommandForTest` dispatches through pm's real engine and
returns the `CommandHandlerResult`:

```ts
import { runRegisteredCommandForTest } from "@unbrained/pm-cli/sdk/testing";

const invocation = await runRegisteredCommandForTest(activation.commands, {
  command: "hello",
  options: { name: "ada" },
});

// invocation.handled === true; invocation.result is the handler's return value.
```

Importers and exporters get dedicated name-based helpers so tests never hand-build
the `"<name> import"` / `"<name> export"` command path. Pass the whole `activation`
and the registration name:

```ts
import { runRegisteredImporterForTest, runRegisteredExporterForTest } from "@unbrained/pm-cli/sdk/testing";

const imported = await runRegisteredImporterForTest(activation, {
  importer: "csv",
  options: { rows: 3 },
});
const exported = await runRegisteredExporterForTest(activation, { exporter: "csv" });

// Both return a CommandHandlerResult: imported.result is the importer's return value.
```

Fire a registered lifecycle hook to assert its behavior (the `context` is
type-safe per `kind`). A clean run returns `[]`; a hook that throws contributes a
single `extension_hook_failed:*` warning while the others still run:

```ts
import { runRegisteredHookForTest } from "@unbrained/pm-cli/sdk/testing";

const warnings = await runRegisteredHookForTest(activation.hooks, {
  kind: "after_command",
  context: { command: "close", args: ["pm-1a2b"], pm_root: "", ok: true },
});
// warnings === [] when every after_command hook ran cleanly.
```

The override surfaces have parallel invoke helpers that delegate to pm's real
runners and return the override result verbatim, after guarding that a matching
override is registered for the target (command / format / service):

```ts
import {
  runRegisteredParserOverrideForTest,
  runRegisteredCommandOverrideForTest,
  runRegisteredRendererOverrideForTest,
  runRegisteredServiceOverrideForTest,
  runRegisteredPreflightOverrideForTest,
} from "@unbrained/pm-cli/sdk/testing";

const parsed = await runRegisteredParserOverrideForTest(activation.parsers, {
  command: "deploy",
  args: ["staging"],
  options: {},
  global: {},
  pm_root: "",
});
// parsed.overridden === true; parsed.context holds the rewritten args/options.

const rendered = await runRegisteredRendererOverrideForTest(activation.renderers, {
  format: "toon",
  result: { id: "pm-1a2b" },
});
// rendered.rendered is the custom string the override produced.
```

Assert a command registration contract:

```ts
import { assertRegisteredCommandContract } from "@unbrained/pm-cli/sdk/testing";

assertRegisteredCommandContract(activation.registrations, {
  command: "hello",
  action: "hello",
  flags: ["--name"],
});
```

Assert importer, exporter, and search-provider registrations against an
`ExtensionRegistrationRegistry` (from `activation.registrations`). The optional
`extensionName` narrows the match to a single extension:

```ts
import {
  assertRegisteredExporter,
  assertRegisteredImporter,
  assertRegisteredSearchProvider,
  assertRegisteredVectorStoreAdapter,
} from "@unbrained/pm-cli/sdk/testing";

assertRegisteredImporter(activation.registrations, { importer: "jsonl" });
assertRegisteredExporter(activation.registrations, {
  exporter: "jsonl",
  extensionName: "my-ext",
});
assertRegisteredSearchProvider(activation.registrations, { provider: "semantic-local" });
assertRegisteredVectorStoreAdapter(activation.registrations, { adapter: "pinecone" });
```

Use `assertRegisteredVectorStoreAdapter` for packages that call
`registerVectorStoreAdapter`. It proves the semantic-storage integration is
present without importing private registry internals or configuring a live
vector store in unit tests.

Assert package-owned schema registrations the same way. This lets packages prove
their custom project-management primitives without importing private registry
types or reading generated schema files:

```ts
import {
  assertRegisteredItemField,
  assertRegisteredItemType,
} from "@unbrained/pm-cli/sdk/testing";

assertRegisteredItemField(activation.registrations, {
  field: "severity",
  extensionName: "incident-ext",
  type: "string",
});
assertRegisteredItemType(activation.registrations, {
  itemType: "Incident",
  folder: "incidents",
});
```

Hooks are surfaced via `activation.hooks` (an `ExtensionHookRegistry`), not the command
registry, so `assertRegisteredHook` takes the hook registry and a lifecycle `kind`
(`before_command` | `after_command` | `on_read` | `on_write` | `on_index`):

```ts
import { assertRegisteredHook } from "@unbrained/pm-cli/sdk/testing";

const hook = assertRegisteredHook(activation.hooks, {
  kind: "on_write",
  extensionName: "my-ext",
});
// hook.run is the registered OnWriteHook handler
```

Override registrations from `registerCommand(command, override)`, `registerParser`,
`registerPreflight`, and `registerRenderer` live on `activation.commands`,
`activation.parsers`, `activation.preflight`, and `activation.renderers` (not the
registration registry). Each override helper takes the matching registry and
returns the registered entry (so you can invoke `entry.run` directly):

```ts
import {
  assertRegisteredCommandOverride,
  assertRegisteredParserOverride,
  assertRegisteredPreflightOverride,
  assertRegisteredRendererOverride,
} from "@unbrained/pm-cli/sdk/testing";

assertRegisteredCommandOverride(activation.commands, { command: "list" });
assertRegisteredParserOverride(activation.parsers, { command: "list", extensionName: "my-ext" });
assertRegisteredPreflightOverride(activation.preflight); // preflight overrides are global (no command)
assertRegisteredRendererOverride(activation.renderers, { format: "toon" });
```

Service overrides from `registerService(service, override)` live on
`activation.services` (an `ExtensionServiceRegistry`), so
`assertRegisteredServiceOverride` takes the service registry and a known service
name (`output_format` | `error_format` | `help_format` | `lock_acquire` |
`lock_release` | `history_append` | `item_store_write` | `item_store_delete`):

```ts
import { assertRegisteredServiceOverride } from "@unbrained/pm-cli/sdk/testing";

const service = assertRegisteredServiceOverride(activation.services, {
  service: "output_format",
  extensionName: "my-ext",
});
// service.run is the registered ServiceOverride handler
```

Schema migrations from `registerMigration(definition)` live on
`activation.registrations.migrations`. `assertRegisteredMigration` matches by the
migration `id` and can additionally assert the `mandatory` governance flag (an
unset flag is treated as non-mandatory):

```ts
import { assertRegisteredMigration } from "@unbrained/pm-cli/sdk/testing";

const migration = assertRegisteredMigration(activation.registrations, {
  migration: "backfill-severity",
  mandatory: true,
});
// migration.definition is the normalized SchemaMigrationDefinition
```

### Project profiles (`registerProfile`)

Tracked: [pm-08sv](../.agents/pm/features/pm-08sv.toon).

A **project profile** is the broadest customization primitive a package can ship:
one declarative `ProjectProfileDefinition` that bundles item types, custom
statuses, fields, per-type workflows, config knobs, create templates, and package
recommendations into a single archetype `pm profile apply` stages idempotently.
The three core archetypes (`agile`/`ops`/`research`) are baked in; a package adds
its own with `api.registerProfile(profile)` under the `schema` capability:

```ts
import { defineProjectProfile, type ExtensionApi } from "@unbrained/pm-cli/sdk";

export const kanbanProfile = defineProjectProfile({
  name: "kanban",
  title: "Kanban continuous flow",
  summary: "WIP-limited flow with a verifying stage.",
  types: [{ name: "Card", folder: "cards" }],
  statuses: [{ id: "doing", roles: ["active"] }],
  fields: [{ key: "wip_limit", type: "number", commands: ["create", "update"] }],
  workflows: [{ type: "Card", allowed_transitions: [["open", "doing"]] }],
  config: [{ key: "search_provider", value: "bm25", summary: "Offline lexical search." }],
  templates: [{ name: "card", options: { type: "Card" } }],
  packages: [{ spec: "templates", reason: "Reusable card shapes." }],
});

export function activate(api: ExtensionApi): void {
  api.registerProfile(kanbanProfile);
}
```

Once the package is active, the profile resolves by name through `pm profile list`
(labelled with its source package), `pm profile show <name>`, and
`pm profile apply <name>` — exactly like a core archetype, with no consumer code.
Built-in names are reserved: a registered profile that collides with a core name
(or another package's profile) is ignored with a warning rather than shadowing it.
Profiles flow through the declarative loop too — `composeExtension({ profiles: [...] })`
auto-wires `registerProfile`, and `deriveExtensionCapabilities` maps a `profiles`
surface to `schema`. Prove a profile registered with `assertRegisteredProfile`:

```ts
import { assertRegisteredProfile } from "@unbrained/pm-cli/sdk/testing";

const { profile } = assertRegisteredProfile(activation.registrations, { profile: "kanban" });
// profile is the normalized ProjectProfileDefinition
```

Together these complete the SDK assertion surface: every extension `register*`
method (including `registerProfile`) now has a matching `assertRegistered*`
helper, so packages can prove any registration without importing private registry
internals.

The three executable registration surfaces add `runRegistered*ForTest` invoke
helpers on top of those assertions, so a package can exercise the real behavior of
a custom provider, adapter, or migration:

```ts
import {
  runRegisteredSearchProviderForTest,
  runRegisteredVectorStoreAdapterForTest,
  runRegisteredMigrationForTest,
} from "@unbrained/pm-cli/sdk/testing";

// Invoke a registered provider's semantic query (or embed / embedBatch /
// queryExpansion / rerank); the result type follows `operation`.
const hits = await runRegisteredSearchProviderForTest(activation.registrations, {
  provider: "semantic-local",
  operation: "query",
  context: { query: "calendar", mode: "semantic", tokens: ["calendar"], options: {}, settings, documents },
});

// Invoke a registered adapter's upsert / query / delete.
await runRegisteredVectorStoreAdapterForTest(activation.registrations, {
  adapter: "pinecone",
  operation: "upsert",
  context: { points: [{ id: "pm-1", vector }], settings },
});

// Invoke a registered migration's run with a host-shaped context.
await runRegisteredMigrationForTest(activation.registrations, {
  migration: "backfill-severity",
  pmRoot,
});
```

The bundled `pm-lifecycle-hooks` package is the first-party hooks exemplar. It
declares only the `hooks` capability and registers a default-inert `afterCommand`
hook, so package authors can copy a lifecycle pattern that does not write files,
produce output, or alter command behavior.

The bundled `pm-governance-audit` package is the governance hook exemplar. It
combines package-owned commands with `onRead` and `onWrite` hooks, declares the
`hooks` capability, and only writes a compact JSONL sidecar when
`PM_GOVERNANCE_AUDIT_HOOK_LOG` is set. Use that pattern for audit/cache/telemetry
packages that need file-level context without storing item bodies by default.

`afterCommand` receives the command outcome plus an optional `affected` array for
item mutations. Each affected entry is a compact command context:
`id`, `op`, `item_type`, `previous_status`, `status`, `changed_fields`, and
partial `previous`/`current` front matter snapshots. Use this for
transition-aware packages such as notifications; do not parse the untyped
`result` payload when the transition fields are available.

`onWrite` receives `{ path, scope, op }` for every observed write. When the write
is tied to an item mutation, the context also includes `item_id`, `item_type`,
`before`, `after`, and `changed_fields`, so sync packages can mirror the exact
item change without reparsing files. Non-item writes omit those item fields.
`changed_fields` lists mutated fields for updates and uses lifecycle sentinels
for item lifecycle writes: `["imported"]` for package imports, `["restored"]`
for restores, and `["deleted"]` for deletes.

## Custom Item Type

```ts
import { defineExtension } from "@unbrained/pm-cli/sdk";

export default defineExtension({
  activate(api) {
    api.registerItemTypes([
      {
        name: "Incident",
        folder: "incidents",
        aliases: ["incident"],
        required_create_fields: ["title", "description", "severity"],
        options: [
          { key: "severity", values: ["critical", "major", "minor"], required: true },
          { key: "service", values: ["api", "web", "worker"] },
        ],
      },
    ]);

    api.registerItemFields([
      { name: "severity", type: "string" },
      { name: "service", type: "string", optional: true },
    ]);
  },
});
```

Manifest capability: `schema`.

Declared item fields are first-class create/update inputs. Agents and importers can persist extension provenance without description markers:

```bash
pm create "Import issue" --type Incident --field service=api --field severity=critical
pm update pm-1234 --field service=worker
```

`--field` accepts only fields declared by active `registerItemFields` registrations and coerces values using the declared field type.

## Importer / Exporter

`registerImporter(name, importer)` and `registerExporter(name, exporter)` register
a data adapter and automatically create a `<name> import` / `<name> export` command
path that invokes it. The handler receives an `ImportExportContext`
(`registration`, `action`, `command`, `args`, `options`, `global`, `pm_root`).

By default the auto-created command only has a handler. Pass an optional third
`ImportExportRegistrationOptions` argument to make it a first-class command with a
description, flags, intent, examples, failure hints, and positional arguments —
surfaced in `--help` and runtime contracts exactly like `registerCommand`:

```ts
import { defineExtension } from "@unbrained/pm-cli/sdk";

export default defineExtension({
  activate(api) {
    api.registerImporter(
      "jsonl",
      async (context) => {
        // context.options.file, context.global, context.pm_root, ...
        return { ok: true, imported: 0 };
      },
      {
        action: "jsonl-import",
        description: "Import JSONL records into pm items.",
        intent: "ingest external task records",
        examples: ["pm jsonl import --file source.jsonl"],
        failure_hints: ["Verify the JSONL source path exists."],
        flags: [
          {
            long: "--file",
            value_name: "path",
            value_type: "string",
            description: "Path to the JSONL source file.",
          },
        ],
      },
    );

    api.registerExporter("jsonl", async () => ({ ok: true }), {
      description: "Export pm items to JSONL.",
    });
  },
});
```

Manifest capability: `importers` (and `schema` when supplying `flags`). The two-argument
form remains supported; supplying the options object never produces a command-handler
collision because the definition and handler share the same command path and extension.

Importers and exporters read their source/destination through flags (e.g. `--file`,
`--folder`) and take **no positional argument** unless one is declared via `arguments`.
An unexpected positional (such as `pm jsonl import data.jsonl` instead of
`pm jsonl import --file data.jsonl`) is rejected with a usage error rather than being
silently ignored, and any `failure_hints` you register are appended to that error so an
agent is steered to the correct flag. Flags declared via `flags` render once, as
first-class options in the standard `Options:` section of `--help`.

The bundled `pm-beads` and `pm-todos` packages are first-party importer/exporter
exemplars that use this registration path and expose runtime contracts for their
generated commands.

## Search Provider

```ts
import { defineExtension } from "@unbrained/pm-cli/sdk";

export default defineExtension({
  activate(api) {
    api.registerSearchProvider({
      name: "example-search",
      async query(context) {
        return context.documents
          .filter((doc) => doc.metadata.title?.toLowerCase().includes(context.query.toLowerCase()))
          .map((doc) => ({ id: doc.metadata.id, score: 0.5, matched_fields: ["title"] }));
      },
    });
  },
});
```

Manifest capability: `search`.

Core search invokes the registered `query` when `settings.search.provider` matches
the provider `name`. The bundled `pm-search-advanced` package ships a working
first-party exemplar: `searchAdvancedLocalProvider()` registers a deterministic,
dependency-free local lexical ranker named `search-advanced-local` (enable with
`pm config set search.provider search-advanced-local`). Authors building
embedding-backed providers (for example Ollama or a hosted model) implement
`embed`/`embedBatch` on the same `SearchProviderDefinition` shape, and may also
`registerVectorStoreAdapter` for a custom vector store.

Optional advanced relevance hooks:

- `queryExpansion` (or `query_expansion`) for `search.query_expansion.provider`
- `rerank` for hybrid rerank candidates when `search.rerank.enabled=true`

Both hooks are best-effort. If a hook throws or returns an invalid shape, core
search degrades gracefully and emits warning codes instead of hard-failing.

## Robust Automation Pattern

1. Read `PM_TOOL_ACTIONS` or `PM_TOOL_PARAMETERS_SCHEMA` for baseline static validation.
2. Load runtime contracts with `getContracts(pmRoot, { runtimeOnly: true })` or run `pm contracts --runtime-only --json` inside the target project.
3. Verify the action appears in `actions` and has `action_availability[].invocable: true`.
4. Validate required fields with `PM_TOOL_ACTION_PARAMETER_CONTRACTS` for static actions or the runtime schema for package actions.
5. Execute only after preflight passes.

Runnable examples:

- [SDK contract consumer](examples/sdk-contract-consumer/README.md)
- [SDK app embedding](examples/sdk-app-embedding/README.md)
- [CI examples](examples/ci/)

## CLI Simplification Migration

The conservative full-surface simplification pass updated invocation parsing and error envelopes. Integration details are documented in [CLI Simplification Migration](MIGRATION_CLI_SIMPLIFICATION.md).

For SDK and automation consumers, the key runtime change is the optional `recovery` object in CLI usage/error JSON payloads:

- `attempted_command`
- `normalized_args`
- `provided_fields`
- `missing`
- `suggested_retry`

Treat `recovery.suggested_retry` as the first-choice deterministic replay command when present.

## Authoring Pattern

- Keep handlers deterministic and JSON-like.
- Return data, not pre-rendered terminal text, unless implementing a renderer or output service.
- Keep service, renderer, and preflight overrides narrow. For `output_format`, return `context.payload`, `null`, or `undefined` for unrelated commands; for renderers, return `null` when the payload should fall back to native rendering.
- Declare only capabilities in use.
- Set `pm_min_version` when the package requires SDK or runtime behavior added after older pm releases.
- Include examples and failure hints in dynamic commands.
- Add `pm package doctor` diagnostics to testing instructions.

## Related Docs

- [Extensions And Packages](EXTENSIONS.md)
- [CLI Simplification Migration](MIGRATION_CLI_SIMPLIFICATION.md)
- [Architecture](ARCHITECTURE.md)
- [Starter Extension](examples/starter-extension/README.md)
