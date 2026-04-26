# pm SDK Guide

This guide is the SDK-first quick start for extension authors using:

```ts
import { defineExtension } from "@unbrained/pm-cli/sdk";
```

Use this document for authoring ergonomics. Use `docs/EXTENSIONS.md` for full lifecycle/runtime behavior details.

## What the SDK Guarantees

The SDK provides stable authoring contracts for:

- `defineExtension(...)`
- `ExtensionApi` registration methods
- lifecycle hook context types
- schema/type registration definitions
- importer/exporter contexts
- search provider and vector adapter definitions
- `GlobalOptions` and `PmSettings` type exports

Reference starter that demonstrates all capabilities:

- `docs/examples/starter-extension/`

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

## Capability Registration Surface

Use `ExtensionApi` to register:

- `registerCommand`, `registerFlags`
- `registerParser`, `registerPreflight`
- `registerService`, `registerRenderer`
- `hooks.beforeCommand`, `hooks.afterCommand`, `hooks.onWrite`, `hooks.onRead`, `hooks.onIndex`
- `registerItemFields`, `registerItemTypes`, `registerMigration`
- `registerImporter`, `registerExporter`
- `registerSearchProvider`, `registerVectorStoreAdapter`

Declare matching capabilities in `manifest.json`. Runtime gating is strict.

## Typed Authoring Highlights

The SDK now provides explicit extension-authoring interfaces instead of `unknown`/`Record<string, unknown>` for key surfaces, including:

- `FlagDefinition`
- `SchemaFieldDefinition`
- `SchemaItemTypeDefinition`
- `SchemaMigrationDefinition`, `SchemaMigrationRunContext`
- `ImportExportContext`
- `SearchProviderDefinition`, `SearchProviderQueryContext`, `SearchProviderHit`
- `VectorStoreAdapterDefinition`, `VectorStoreQueryContext`, `VectorStoreUpsertContext`

These interfaces are intentionally permissive (`[key: string]: unknown`) so extensions can add metadata without fighting the type checker.

## Recommended Authoring Pattern

- keep command handlers deterministic and JSON-like
- keep renderer/service overrides narrow to specific command paths
- prefer additive hooks and schema fields over global behavior changes
- ship one extension folder with:
  - `manifest.json`
  - entry module (`index.js` or `dist/index.js`)
  - package metadata/dependencies as needed

## Related Docs

- full extension lifecycle/runtime reference: `docs/EXTENSIONS.md`
- architecture internals: `docs/ARCHITECTURE.md`
- complete starter scaffold: `docs/examples/starter-extension/`
