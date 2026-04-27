# pm SDK Guide

This guide documents the public SDK surface for extension authors.

Primary import:

```ts
import { defineExtension } from "@unbrained/pm-cli/sdk";
```

Use this document for SDK/API contracts. Use `docs/EXTENSIONS.md` for full runtime lifecycle behavior and `pm extension --init ./my-extension` for starter scaffold generation.

## Import Surfaces

- `@unbrained/pm-cli/sdk`: stable extension authoring API and CLI contract exports.
- `@unbrained/pm-cli/cli`: runtime CLI module entrypoint. This path is for runtime module resolution, not a typed library API; its declaration file intentionally exports no symbols.

## Public SDK Exports

Source of truth:

- `src/sdk/index.ts`
- `src/sdk/cli-contracts.ts`

### Extension authoring values

- `defineExtension(...)`
- `EXTENSION_CAPABILITIES`
- `EXTENSION_CAPABILITY_CONTRACT`
- `EXTENSION_CAPABILITY_CONTRACT_VERSION`
- `EXTENSION_CAPABILITY_LEGACY_ALIASES`

### CLI/action contract values

- `PM_CORE_COMMAND_NAMES`
- `PM_TOOL_ACTIONS`
- `PM_TOOL_PARAMETERS_SCHEMA`
- `PM_EXTENSION_CAPABILITY_CONTRACTS`
- `PM_EXTENSION_SERVICE_NAME_CONTRACTS`
- all exported `...FLAG_CONTRACTS`, `...OPTION_CONTRACTS`, and `...COMMANDER_*_CONTRACTS` arrays from `src/sdk/cli-contracts.ts`

### CLI/action contract helpers

- `withFlagAliasMetadata(...)`
- `toCompletionFlagString(...)`
- `readFirstStringFromCommanderOptions(...)`
- `readStringArrayFromCommanderOptions(...)`

### Key type exports

- extension capability/types: `ExtensionCapability`, `PmToolAction`, `PmExtensionCapabilityContract`, `PmExtensionServiceNameContract`
- command/flag/type helpers: `CommandDefinition`, `ExtensionCommandArgumentDefinition`, `FlagDefinition`, `SchemaFieldDefinition`, `SchemaItemTypeDefinition`
- runtime extension API types: `ExtensionApi`, `ExtensionManifest`, lifecycle hook context types, importer/exporter contexts, search provider types, vector adapter types
- shared command/settings types: `GlobalOptions`, `PmSettings`

## Capability Requirements (Quick Reference)

Declare capabilities in `manifest.json`; runtime gating is strict.

- `registerCommand(...)`: requires `commands`
- `registerCommand({ flags: [...] })` and `registerFlags(...)`: require `schema`
- `registerItemFields(...)`, `registerItemTypes(...)`, `registerMigration(...)`: require `schema`
- `registerImporter(...)` and `registerExporter(...)`: require `importers`
- `registerParser(...)`: requires `parser`
- `registerPreflight(...)`: requires `preflight`
- `registerService(...)`: requires `services`
- `registerRenderer(...)`: requires `renderers`
- lifecycle hooks (`beforeCommand`, `afterCommand`, `onWrite`, `onRead`, `onIndex`): require `hooks`
- `registerSearchProvider(...)` and `registerVectorStoreAdapter(...)`: require `search`

## Minimal Extension

`manifest.json`:

```json
{
  "name": "hello-extension",
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
      run: async () => ({ ok: true, message: "hello from sdk extension" }),
    });
  },
});
```

## Typed Authoring Highlights

The SDK provides explicit interfaces for key surfaces including:

- `CommandDefinition` and `ExtensionCommandArgumentDefinition`
- `FlagDefinition`
- `SchemaFieldDefinition`, `SchemaItemTypeDefinition`, `SchemaMigrationDefinition`
- `ImportExportContext`
- `SearchProviderDefinition`, `SearchProviderQueryContext`, `SearchProviderHit`
- `VectorStoreAdapterDefinition`, `VectorStoreQueryContext`, `VectorStoreUpsertContext`

These interfaces intentionally allow additive metadata (`[key: string]: unknown`) where extension-defined metadata is expected.

## Recommended Authoring Pattern

- keep command handlers deterministic and JSON-like
- keep renderer/service overrides narrow to specific command paths
- prefer additive hooks and schema fields over global behavior changes
- ship one extension folder with `manifest.json`, an entry module, and package metadata/dependencies

## Related Docs

- full extension lifecycle/runtime reference: `docs/EXTENSIONS.md`
- architecture internals: `docs/ARCHITECTURE.md`
- complete starter scaffold: `docs/examples/starter-extension/`
