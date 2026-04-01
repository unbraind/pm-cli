# pm-cli Extension Development Guide

Extensions let you add commands, renderers, importers, exporters, schema fields, item-type definitions, search providers, and lifecycle hooks to `pm-cli` without modifying core.

## Extension Locations

| Scope | Path |
|-------|------|
| Global | `~/.pm-cli/extensions/<name>/` (override: `PM_GLOBAL_PATH/extensions/<name>/`) |
| Project | `.agents/pm/extensions/<name>/` (override: `PM_PATH/extensions/<name>/`) |

**Load order:** core built-ins → global → project. Project-local extensions take precedence over global when they declare the same command name or renderer key.

## Manifest

Every extension directory must contain a `manifest.json`:

```json
{
  "name": "pm-ext-example",
  "version": "0.1.0",
  "entry": "./dist/index.js",
  "priority": 100,
  "capabilities": [
    "commands",
    "renderers",
    "hooks",
    "schema",
    "importers",
    "search"
  ]
}
```

- `entry` must resolve inside the extension directory (no path traversal).
- `capabilities` declares what the extension will register. API calls that exceed declared capabilities fail activation deterministically.
- Unknown capability names are silently ignored for gating but emit discovery diagnostics.

## Extension Module

The entry module must export an `activate` function:

```ts
import { defineExtension, type ExtensionApi } from "@unbrained/pm-cli/sdk";

export default defineExtension({
  activate(api: ExtensionApi): void {
    // register commands, hooks, renderers, etc.
  },
});
```

`activate` may be synchronous or return `Promise<void>`.

## API Reference

### `api.registerCommand(def)`

Register a new command handler path or replace an existing core command at dispatch time.

**New command path:**

```ts
api.registerCommand({
  name: "acme sync",
  run: async (context) => {
    // context.command: normalized command path
    // context.args: string[] positional args
    // context.options: Record<string, unknown> command-scoped flags
    // context.global: GlobalOptions (--json/--quiet/--path/--no-extensions/--profile)
    // context.pm_root: resolved PM root
    return { ok: true, synced: 42 };
  },
});
```

If the command path matches a core command (for example `list-open`), the extension handler runs first and the core action is skipped. Command names are canonicalized (trimmed, lowercased, repeated whitespace collapsed). Handlers receive cloned snapshots so mutation cannot leak into caller state.

**Override existing core command result:**

```ts
api.registerCommand("list", (context) => {
  return {
    ...(context.result as Record<string, unknown>),
    _ext: "annotated",
    command: context.command,
    pm_root: context.pm_root,
  };
});
```

Result override callbacks are synchronous. Returning a Promise is ignored and emits `extension_command_override_async_unsupported:<layer>:<name>:<command>`.

### `api.registerFlags(targetCommand, flags)`

Declare flags for a command (displayed in `--help` for dynamic extension commands):

```ts
api.registerFlags("acme sync", [
  { long: "--dry-run", short: "-d", description: "Simulate without writing" },
  { long: "--org", value_name: "name", description: "Organization name", required: true },
  { long: "--legacy-mode", enabled: false },
  { long: "--internal-debug", visible: false },
]);
```

Supported metadata for dynamic extension help rendering:

- `required: true` appends a `[required]` marker in help.
- `enabled: false` appends a `[disabled]` marker in help.
- `visible: false` hides the flag from dynamic help output.

Core help output now also appends command-level narrative sections (why/examples/tips). Dynamic extension commands still receive flag-level rendering from `registerFlags(...)`, so extension authors should provide explicit `description` text on each flag to keep help high-signal.

### `api.registerRenderer(format, renderer)`

Override TOON or JSON output for a command:

```ts
api.registerRenderer("toon", (context) => {
  if (context.command !== "stats") {
    return `noop: ${JSON.stringify(context.result)}`;
  }
  return customToonFormat(context.result);
});
```

Renderer overrides must return a string. Non-string return values are ignored and produce a deterministic `extension_renderer_invalid_result:<layer>:<name>:<format>` warning.

Without a renderer override, non-JSON command output is wrapped by core in a command-aware envelope:

- `summary`
- `highlights`
- `next_steps`
- `result`

If your extension needs a different human-readable shape, register a TOON renderer override.

### `api.registerImporter(name, importer)`

Register an importer (also wires `<name> import` command path):

```ts
api.registerImporter("jira", async (context) => {
  // context.registration: normalized importer name
  // context.action: "import"
  // context.command: command path
  // context.options: parsed command flags
  // context.global: GlobalOptions
  // context.pm_root: resolved PM root
  return { ok: true, imported: 5, skipped: 0, ids: ["pm-xxxx"], warnings: [] };
});
```

### `api.registerExporter(name, exporter)`

Register an exporter (also wires `<name> export` command path):

```ts
api.registerExporter("jira", async (context) => {
  // context.action: "export"
  return { ok: true, exported: 5, ids: ["pm-xxxx"], warnings: [] };
});
```

### `api.registerItemFields(fields)`

Declare additional front-matter fields for schema-awareness:

```ts
api.registerItemFields([
  { name: "acme_epic_id", type: "string", optional: true },
]);
```

### `api.registerItemTypes(types)`

Register custom item types and per-type create/type-option rules:

```ts
api.registerItemTypes([
  {
    name: "Asset",
    folder: "assets",
    aliases: ["assets", "3d-asset"],
    required_create_fields: ["title", "description", "status", "priority", "message"],
    required_create_repeatables: [],
    command_option_policies: [
      { command: "create", option: "severity", enabled: false },
      { command: "create", option: "reporter", enabled: false },
      { command: "create", option: "goal", visible: false },
      { command: "update", option: "message", required: true },
    ],
    options: [
      {
        key: "category",
        values: ["Map", "Character", "Prop", "VFX"],
        required: true,
        aliases: ["asset_category"],
      },
      {
        key: "pipeline",
        values: ["Blockout", "Modeling", "Rigging", "Texturing", "Done"],
      },
    ],
  },
]);
```

Notes:

- Requires `schema` capability in the extension manifest.
- Type names and aliases are resolved by the runtime type registry and become available to `--type` filters and completion.
- Option definitions are validated by `pm create` / `pm update` through `--type-option` flags.
- `command_option_policies` are enforced by core create/update runtime and surfaced in policy-aware help sections.

### `api.registerMigration(def)`

Declare a schema migration (tracked in `pm health`):

```ts
api.registerMigration({
  id: "add-acme-epic-id",
  description: "Add acme_epic_id field to existing items",
  mandatory: false,
  status: "pending",
  run: async (pmRoot) => {
    // migrate items; update status to "applied" when done
  },
});
```

Migrations with `mandatory: true` and `status` not `"applied"` block write commands until resolved (bypass with `--force`).

### `api.registerSearchProvider(provider)`

Register a custom search provider:

```ts
api.registerSearchProvider({
  name: "elastic",
  query: async (context) => {
    // context.query, context.mode, context.tokens
    // context.options, context.settings, context.documents
    return [{ id: "pm-xxxx", score: 0.95, matched_fields: ["provider:elastic"] }];
  },
});
```

Use `settings.search.provider` to select the active extension provider for live `pm search` execution.

### `api.registerVectorStoreAdapter(adapter)`

Register a custom vector store:

```ts
api.registerVectorStoreAdapter({
  name: "pinecone",
  upsert: async (context) => {
    // context.points, context.settings
  },
  query: async (context) => {
    // context.vector, context.limit, context.settings
    return [{ id: "pm-xxxx", score: 0.87 }];
  },
});
```

Use `settings.vector_store.adapter` to select the active extension adapter for `pm search` query and `pm reindex` upsert.

## Lifecycle Hooks

Hooks run for every applicable core operation. Hook handlers receive cloned context snapshots — mutations do not leak back into caller state.

### `api.hooks.beforeCommand(hook)`

Runs before any command executes:

```ts
api.hooks.beforeCommand((ctx) => {
  // ctx.command: string
  // ctx.args: string[]
  // ctx.options: Record<string,unknown>
  // ctx.global: GlobalOptions
  // ctx.pm_root: string
  console.log(`[ext] before: ${ctx.command}`);
});
```

### `api.hooks.afterCommand(hook)`

Runs after a command completes (even on failure):

```ts
api.hooks.afterCommand((ctx) => {
  // ctx.ok: boolean
  // ctx.result?: unknown
  // ctx.error?: string
  // same fields as beforeCommand
});
```

### `api.hooks.onWrite(hook)`

Runs before each item file write:

```ts
api.hooks.onWrite((ctx) => {
  // ctx.path: string
  // ctx.op: string (create, update, restore, etc.)
  // ctx.item_id: string
});
```

### `api.hooks.onRead(hook)`

Runs after each item file read:

```ts
api.hooks.onRead((ctx) => {
  // ctx.path: string
  // ctx.item_id: string
});
```

### `api.hooks.onIndex(hook)`

Runs during reindex/gc operations:

```ts
api.hooks.onIndex((ctx) => {
  // ctx.mode: "keyword" | "semantic" | "hybrid" | "gc"
  // ctx.total?: number
});
```

## Health and Diagnostics

`pm health` probes all loaded extensions and surfaces:

- `extension_load_failed:<layer>:<name>` — manifest parse or module import error
- `extension_activate_failed:<layer>:<name>` — exception in `activate()`
- `extension_entry_outside_extension:<layer>:<name>` — entry path escapes directory
- `extension_capability_unknown:<layer>:<name>:<capability>` — unknown capability in manifest

Use `pm health --json` to parse diagnostics programmatically.

## Disabling Extensions

```bash
pm --no-extensions list-open   # disable all extensions for this invocation
```

Or configure per-project in `.agents/pm/settings.json`:

```json
{
  "extensions": {
    "disabled": ["pm-ext-example"]
  }
}
```

## Example: Minimal Custom Command

**`~/.pm-cli/extensions/hello/manifest.json`:**

```json
{
  "name": "hello",
  "version": "0.1.0",
  "entry": "./index.js",
  "priority": 100,
  "capabilities": ["commands"]
}
```

**`~/.pm-cli/extensions/hello/index.js`:**

```js
export function activate(api) {
  api.registerCommand({
    name: "hello",
    run: async (_context) => {
      return { message: "Hello from extension!" };
    },
  });
}
```

```bash
pm hello
# => message: Hello from extension!
```

## Built-in Extensions

`pm-cli` ships two built-in extensions compiled into the package:

| Extension | Commands | Purpose |
|-----------|----------|---------|
| `builtin-beads-import` | `pm beads import` | Import Beads JSONL records into pm items |
| `builtin-todos-import-export` | `pm todos import`, `pm todos export` | Round-trip todos markdown format |

Built-in extensions are loaded automatically and cannot be disabled via settings (use `--no-extensions` to disable all extensions including built-ins).

## Pi Agent Extension

The bundled Pi tool wrapper lives at `.pi/extensions/pm-cli/index.ts` and is a Pi agent extension (not a pm-cli extension). Install it with:

```bash
pm install pi          # to current project .pi/extensions/pm-cli/index.ts
pm install pi --global # to PI_CODING_AGENT_DIR/extensions/pm-cli/index.ts
```

Current wrapper parity includes:

- `action: "calendar"` for `pm calendar` / `pm cal` (`view`, `date`, `from`, `to`, `past`, `type`, `tag`, `priority`, `status`, `assignee`, `sprint`, `release`, `limit`, `format`)
- `create`/`update` reminder forwarding via repeatable `reminder` values (`at=<iso|relative>,text=<text>`)
- `create`/`update` custom type-option forwarding via repeatable `typeOption` values

See [AGENTS.md](../AGENTS.md) section 9 for full usage details.
