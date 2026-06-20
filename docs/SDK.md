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

Package manifest exports:

- `PM_PACKAGE_RESOURCE_KINDS` (`extensions`, `docs`, `examples`, `assets`, `prompts`)
- `PM_PACKAGE_CONVENTIONAL_RESOURCE_ROOTS`
- `readPmPackageManifest`
- `collectPackageExtensionDirectories`

Command/action contract exports:

- `PM_CORE_COMMAND_NAMES`
- `PM_TOOL_ACTIONS`
- `PM_TOOL_PARAMETERS_SCHEMA`
- `PM_PROVIDER_TOOL_PARAMETERS_SCHEMA`
- `PM_TOOL_ACTION_PARAMETER_CONTRACTS`

Testing helper exports (also under `@unbrained/pm-cli/sdk/testing`):

- `activateExtensionForTest`
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

Common types:

- `ExtensionApi`
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
loader internals. Use `activateExtensionForTest` plus the targeted assertion for
the surface your package owns:

```ts
import {
  activateExtensionForTest,
  assertRegisteredCommandContract,
  assertRegisteredFlags,
} from "@unbrained/pm-cli/sdk/testing";

const activation = await activateExtensionForTest(extensionModule);

assertRegisteredCommandContract(activation.registrations, {
  command: "incident triage",
  flags: ["--severity"],
});
assertRegisteredFlags(activation.registrations, {
  targetCommand: "list",
  flags: ["--incident-filter"],
});
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
  "entry": "./index.js",
  "pm_min_version": "2026.5.31",
  "capabilities": ["commands"]
}
```

`pm_min_version` is an inclusive minimum pm CLI version. When the installed CLI is older than the manifest requires, discovery emits `extension_pm_min_version_unmet:<layer>:<name>:required=<version>:current=<version>` and does not load the extension. Use a plain numeric version such as `2026.5.31`; `>=2026.5.31` is accepted for compatibility with `engines.pm`, but ranges beyond an inclusive minimum are not interpreted.

Manifest typing also accepts optional `engines` metadata:

```json
{
  "engines": {
    "pm": ">=2026.5.31",
    "node": ">=20"
  }
}
```

Use `pm_min_version` for the loader gate. Keep `engines` as package-manager and tooling metadata.

For a complete commands-capability package that combines `registerCommand`,
`registerFlags`, and `registerParser`, see the first-party
[pm-command-kit exemplar](../packages/pm-command-kit/README.md).

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
    entry: "./index.js",
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
