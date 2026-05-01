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

## Practical Examples

### Custom Search Provider

Register an extension that provides embedding-based search using a custom API:

```ts
import { defineExtension } from "@unbrained/pm-cli/sdk";

export default defineExtension({
  activate(api) {
    api.registerSearchProvider({
      name: "my-embeddings",
      async embed_batch(context) {
        const response = await fetch("https://api.example.com/embed", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ inputs: context.inputs, model: context.model }),
        });
        const data = await response.json();
        return data.embeddings; // number[][]
      },
      async query(context) {
        return context.documents
          .filter((doc) => context.tokens.some((t) => doc.front_matter.title?.toLowerCase().includes(t)))
          .map((doc) => ({ id: doc.front_matter.id, score: 0.5 }));
      },
    });
  },
});
```

Manifest: `{ "capabilities": ["search"] }`

### Custom Item Type with Schema

Register a custom `Incident` item type with required fields:

```ts
import { defineExtension } from "@unbrained/pm-cli/sdk";

export default defineExtension({
  activate(api) {
    api.registerItemTypes([
      {
        name: "Incident",
        folder: "incidents",
        aliases: ["incident", "inc"],
        required_create_fields: ["title", "severity"],
        options: [
          { key: "severity", values: ["critical", "major", "minor", "info"], required: true },
          { key: "service", values: ["api", "web", "worker", "db"] },
        ],
        command_option_policies: [
          { command: "create", option: "severity", enabled: true, required: true, visible: true },
        ],
      },
    ]);

    api.registerItemFields([
      { name: "severity", type: "string" },
      { name: "service", type: "string", optional: true },
      { name: "resolved_at", type: "string", optional: true },
    ]);
  },
});
```

Manifest: `{ "capabilities": ["schema"] }`

### Lifecycle Hooks

Track item creation and mutations for audit logging:

```ts
import { defineExtension } from "@unbrained/pm-cli/sdk";

export default defineExtension({
  activate(api) {
    api.hooks.afterCommand(async (context) => {
      if (context.command === "create" && context.ok) {
        console.error(`[audit] Created item via: pm ${context.command} ${context.args.join(" ")}`);
      }
    });

    api.hooks.onWrite(async (context) => {
      if (context.op === "create" || context.op === "update") {
        console.error(`[audit] ${context.op}: ${context.path}`);
      }
    });
  },
});
```

Manifest: `{ "capabilities": ["hooks"] }`

### Custom Vector Store Adapter

Register a Pinecone-compatible vector store:

```ts
import { defineExtension } from "@unbrained/pm-cli/sdk";

export default defineExtension({
  activate(api) {
    api.registerVectorStoreAdapter({
      name: "pinecone",
      async query(context) {
        const response = await fetch(`${process.env.PINECONE_URL}/query`, {
          method: "POST",
          headers: {
            "Api-Key": process.env.PINECONE_API_KEY ?? "",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ vector: context.vector, topK: context.limit }),
        });
        const data = await response.json();
        return data.matches.map((m: { id: string; score: number }) => ({
          id: m.id,
          score: m.score,
        }));
      },
      async upsert(context) {
        await fetch(`${process.env.PINECONE_URL}/vectors/upsert`, {
          method: "POST",
          headers: {
            "Api-Key": process.env.PINECONE_API_KEY ?? "",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            vectors: context.points.map((p) => ({
              id: p.id,
              values: p.vector,
              metadata: p.payload,
            })),
          }),
        });
      },
      async delete(context) {
        await fetch(`${process.env.PINECONE_URL}/vectors/delete`, {
          method: "POST",
          headers: {
            "Api-Key": process.env.PINECONE_API_KEY ?? "",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ids: context.ids }),
        });
      },
    });
  },
});
```

Manifest: `{ "capabilities": ["search"] }`

### Command with Flags and Arguments

Register a full command with typed arguments and flags:

```ts
import { defineExtension } from "@unbrained/pm-cli/sdk";

export default defineExtension({
  activate(api) {
    api.registerCommand({
      name: "deploy",
      description: "Deploy items to a target environment",
      intent: "push staged changes to production",
      arguments: [
        { name: "environment", required: true, description: "Target environment (staging, production)" },
      ],
      flags: [
        { long: "dry-run", short: "n", description: "Preview changes without applying", type: "boolean" },
        { long: "tag", short: "t", value_name: "tag", description: "Release tag", type: "string" },
      ],
      examples: [
        "pm deploy staging",
        "pm deploy production --dry-run",
        "pm deploy production --tag v2.0.0",
      ],
      failure_hints: [
        "Ensure the target environment is configured in settings.json",
      ],
      async run(context) {
        const env = context.args[0];
        const dryRun = context.options["dry-run"] === true;
        return { ok: true, environment: env, dry_run: dryRun };
      },
    });
  },
});
```

Manifest: `{ "capabilities": ["commands", "schema"] }`

## Recommended Authoring Pattern

- keep command handlers deterministic and JSON-like
- keep renderer/service overrides narrow to specific command paths
- prefer additive hooks and schema fields over global behavior changes
- ship one extension folder with `manifest.json`, an entry module, and package metadata/dependencies

## Related Docs

- full extension lifecycle/runtime reference: `docs/EXTENSIONS.md`
- architecture internals: `docs/ARCHITECTURE.md`
- complete starter scaffold: `docs/examples/starter-extension/`
