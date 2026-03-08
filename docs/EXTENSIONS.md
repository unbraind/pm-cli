# pm-cli Extension Development Guide

Extensions let you add commands, renderers, importers, exporters, schema fields, search providers, and lifecycle hooks to `pm-cli` without modifying core.

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
import type { ExtensionApi } from "pm-cli";

export function activate(api: ExtensionApi): void {
  // register commands, hooks, renderers, etc.
}
```

`activate` may be synchronous or return `Promise<void>`.

## API Reference

### `api.registerCommand(def)`

Register a new command or override an existing core command's result.

**New command path:**

```ts
api.registerCommand({
  name: "acme sync",
  run: async (args, options, global) => {
    // args: string[] — positional CLI arguments
    // options: Record<string,unknown> — parsed flags
    // global: GlobalOptions — --json, --quiet, --path, etc.
    return { ok: true, synced: 42 };
  },
});
```

The command name is canonicalized (trimmed, lowercased, repeated whitespace collapsed). The handler receives cloned snapshots so mutation cannot leak into caller state.

**Override existing core command result:**

```ts
api.registerCommand("list", (priorResult, args, options, global, pmRoot) => {
  // priorResult: the core command's output object (cloned)
  // return a modified result object, or undefined to use priorResult as-is
  return { ...priorResult, _ext: "annotated" };
});
```

### `api.registerFlags(targetCommand, flags)`

Declare flags for a command (displayed in `--help` for dynamic extension commands):

```ts
api.registerFlags("acme sync", [
  { name: "--dry-run", description: "Simulate without writing" },
  { name: "--org <name>", description: "Organization name" },
]);
```

### `api.registerRenderer(format, renderer)`

Override TOON or JSON output for a command:

```ts
api.registerRenderer("toon", (command, result, args, options, global, pmRoot) => {
  if (command !== "stats") return undefined; // pass through
  return customToonFormat(result);
});
```

Return `undefined` to fall back to the built-in renderer.

### `api.registerImporter(name, importer)`

Register an importer (also wires `<name> import` command path):

```ts
api.registerImporter("jira", async (options, global) => {
  // options: parsed flags from `pm jira import ...`
  return { ok: true, imported: 5, skipped: 0, ids: ["pm-xxxx"], warnings: [] };
});
```

### `api.registerExporter(name, exporter)`

Register an exporter (also wires `<name> export` command path):

```ts
api.registerExporter("jira", async (options, global) => {
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
  query: async (query, options, settings) => {
    return [{ id: "pm-xxxx", score: 0.95 }];
  },
});
```

### `api.registerVectorStoreAdapter(adapter)`

Register a custom vector store:

```ts
api.registerVectorStoreAdapter({
  name: "pinecone",
  upsert: async (records, settings) => { ... },
  query: async (vector, topK, settings) => { ... },
  delete: async (ids, settings) => { ... },
});
```

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
  // ctx.error?: unknown
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
    run: async (_args, _options, _global) => {
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

See [AGENTS.md](../AGENTS.md) section 9 for full usage details.
