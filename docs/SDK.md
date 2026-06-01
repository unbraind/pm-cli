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

- `PM_PACKAGE_RESOURCE_KINDS` (`extensions`, `docs`, `examples`)
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

- `assertRegisteredCommandContract`
- `assertRegisteredHook`
- `assertRegisteredSearchProvider`
- `assertRegisteredImporter`
- `assertRegisteredExporter`

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

When a package-owned command is missing at runtime, CLI usage guidance now includes a deterministic install hint (for example `pm install calendar` or `pm install search-advanced`) so agents can recover in one retry.

Package installs currently activate only extension resources. Additional package resource kinds (`docs`, `examples`) are metadata-first and available through package manifest/catalog inspection.

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

`PM_CLI_PACKAGE_ROOT` is reserved for first-party packages bundled inside this repository. Those packages use it to locate the running CLI's `dist/sdk/runtime.js` before they are installed as independent npm packages. External packages must not depend on `PM_CLI_PACKAGE_ROOT`, `dist/` paths, or `src/core/...`; declare `@unbrained/pm-cli` as a dependency or peer dependency and import the public SDK subpaths instead.

## Testing Helpers

Package tests can assert registration contracts without depending on Vitest-specific
helpers. Every assertion normalizes the expected name, returns the matched registration
entry, and throws an `Error` that lists what _is_ available when the expectation is
missing. They are exported from both `@unbrained/pm-cli/sdk/testing` and the main
`@unbrained/pm-cli/sdk` barrel.

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
} from "@unbrained/pm-cli/sdk/testing";

assertRegisteredImporter(activation.registrations, { importer: "jsonl" });
assertRegisteredExporter(activation.registrations, {
  exporter: "jsonl",
  extensionName: "my-ext",
});
assertRegisteredSearchProvider(activation.registrations, { provider: "semantic-local" });
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
- Keep service and preflight overrides narrow.
- Declare only capabilities in use.
- Set `pm_min_version` when the package requires SDK or runtime behavior added after older pm releases.
- Include examples and failure hints in dynamic commands.
- Add `pm package doctor` diagnostics to testing instructions.

## Related Docs

- [Extensions And Packages](EXTENSIONS.md)
- [CLI Simplification Migration](MIGRATION_CLI_SIMPLIFICATION.md)
- [Architecture](ARCHITECTURE.md)
- [Starter Extension](examples/starter-extension/README.md)
