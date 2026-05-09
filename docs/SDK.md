# SDK

The public SDK is exported from `@unbrained/pm-cli/sdk`. Use it for extension authoring and command-contract introspection. Do not import internal `src/core/...` modules from extensions.

## Agent Quick Context

- Primary import: `@unbrained/pm-cli/sdk`.
- Runtime extension lifecycle is documented in [Extensions](EXTENSIONS.md).
- Exact command/action contracts are available through `pm contracts`.
- Local deep-dive routing is available through `pm guide sdk --depth deep`.

Tracked documentation work: [pm-1sb2](../.agents/pm/tasks/pm-1sb2.toon).

## Import Surfaces

```ts
import { defineExtension } from "@unbrained/pm-cli/sdk";
```

Supported package exports:

- `@unbrained/pm-cli/sdk` - stable extension authoring API and CLI contract exports.
- `@unbrained/pm-cli/cli` - runtime CLI module entrypoint for package resolution, not a typed library API.

## Public Exports

Source of truth:

- [`src/sdk/index.ts`](../src/sdk/index.ts)
- [`src/sdk/cli-contracts.ts`](../src/sdk/cli-contracts.ts)

Common authoring exports:

- `defineExtension`
- `EXTENSION_CAPABILITIES`
- `EXTENSION_CAPABILITY_CONTRACT`
- `EXTENSION_CAPABILITY_CONTRACT_VERSION`
- `EXTENSION_CAPABILITY_LEGACY_ALIASES`
- `PM_CORE_COMMAND_NAMES`
- `PM_TOOL_ACTIONS`
- `PM_TOOL_PARAMETERS_SCHEMA`
- `PM_EXTENSION_CAPABILITY_CONTRACTS`
- `PM_EXTENSION_SERVICE_NAME_CONTRACTS`

Common types:

- `ExtensionApi`
- `ExtensionManifest`
- `CommandDefinition`
- `FlagDefinition`
- `SchemaFieldDefinition`
- `SchemaItemTypeDefinition`
- `SearchProviderDefinition`
- `VectorStoreAdapterDefinition`
- `GlobalOptions`
- `PmSettings`

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

## Minimal Command Extension

```ts
import { defineExtension } from "@unbrained/pm-cli/sdk";

export default defineExtension({
  activate(api) {
    api.registerCommand({
      name: "hello",
      description: "Return a deterministic hello payload.",
      intent: "verify SDK extension activation",
      examples: ["pm hello"],
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
  "capabilities": ["commands"]
}
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

## Command Contracts

For machine clients:

```bash
pm contracts --json
pm contracts --command create --flags-only --json
pm contracts --action create --schema-only --json
```

Use the runtime command because active extensions can add command/action metadata.

## Authoring Pattern

- Keep handlers deterministic and JSON-like.
- Return data, not pre-rendered terminal text, unless implementing a renderer.
- Keep service and preflight overrides narrow.
- Declare only capabilities in use.
- Include examples and failure hints in dynamic commands.
- Add `pm extension doctor` diagnostics to testing instructions.

## Related Docs

- [Extensions](EXTENSIONS.md)
- [Architecture](ARCHITECTURE.md)
- [starter extension](examples/starter-extension/README.md)
