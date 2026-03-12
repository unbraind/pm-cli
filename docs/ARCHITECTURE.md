# pm-cli Architecture

This document describes the internal architecture of `pm-cli` for contributors and maintainers.

## Overview

`pm-cli` is a TypeScript ESM CLI built on Node.js 20+. It follows a clean separation between CLI wiring and domain logic:

```
src/
  cli/            CLI layer: command registration, option parsing, output rendering
  core/           Domain logic: storage, locking, history, search, extensions
  extensions/     Built-in extension implementations (beads, todos)
  types/          Shared TypeScript type definitions
```

## Source Tree

```
src/
  cli.ts                         Main CLI entry (shim that imports cli/main.ts)
  cli/
    main.ts                      Command registration with commander; global option wiring
    commands/
      init.ts                    pm init
      create.ts                  pm create (full schema flag surface)
      get.ts                     pm get
      update.ts                  pm update
      append.ts                  pm append
      close.ts                   pm close
      delete.ts                  pm delete
      claim.ts                   pm claim / release
      release.ts                 (re-exports from claim.ts)
      list.ts                    pm list (active-only: excludes closed/canceled) / list-all / list-* commands
      comments.ts                pm comments
      files.ts                   pm files
      docs.ts                    pm docs
      test.ts                    pm test (add/remove/run linked tests)
      test-all.ts                pm test-all (orchestration)
      search.ts                  pm search (keyword / semantic / hybrid)
      reindex.ts                 pm reindex
      history.ts                 pm history
      activity.ts                pm activity
      restore.ts                 pm restore
      stats.ts                   pm stats
      health.ts                  pm health
      gc.ts                      pm gc
      config.ts                  pm config
      install.ts                 pm install pi
      completion.ts              pm completion
      beads.ts                   pm beads (subcommand router to built-in extension)
      index.ts                   barrel re-export
    extension-command-options.ts Loose option parser for dynamic extension commands
  core/
    extensions/
      loader.ts                  Extension manifest discovery, load, activate
      builtins.ts                Built-in extension registrations
      index.ts                   barrel
    fs/
      fs-utils.ts                Atomic write, path existence, mkdirp
      index.ts                   barrel
    history/
      history.ts                 RFC6902 patch generation, history append, replay
      index.ts                   barrel
    item/
      id.ts                      ID generation (cryptographic random base36) and normalization
      item-format.ts             Item front-matter serializer (canonical key order, determinism)
      parse.ts                   Markdown item file parser (JSON front-matter + body)
      index.ts                   barrel
    lock/
      lock.ts                    Exclusive lock acquire/release with TTL and stale detection
      index.ts                   barrel
    output/
      output.ts                  TOON / JSON output rendering
    search/
      cache.ts                   Keyword index artifact read/write (manifest.json + embeddings.jsonl)
      embedding-batches.ts       Deterministic batch embedding generation with retry
      providers.ts               OpenAI / Ollama embedding provider abstraction
      vector-stores.ts           Qdrant / LanceDB vector store abstraction
    shared/
      command-types.ts           GlobalOptions, shared command type definitions
      constants.ts               Exit codes, required directory names
      errors.ts                  PmCliError with exit code
      serialization.ts           Deterministic JSON serialization (stable key order)
      time.ts                    ISO timestamp helpers, relative deadline parsing
      index.ts                   barrel
    store/
      item-store.ts              File-backed item CRUD with lock/atomic write contract
      paths.ts                   PM root resolution (PM_PATH, --path, cwd)
      settings.ts                settings.json read/write
      index.ts                   barrel
  types/
    index.ts                     ItemFrontMatter, ItemType, ItemStatus, Dependency, etc.
  extensions/
    builtins/
      beads/
        index.ts                 Beads JSONL import extension
      todos/
        index.ts                 todos extension activate()
        import-export.ts         todos import/export logic
  command-types.ts               (re-export shim)
  constants.ts                   (re-export shim)
  errors.ts                      (re-export shim)
  ... (other re-export shims for backward compat)
```

## Item Storage

Each item is stored as a Markdown file:

```
.agents/pm/
  <type-plural>/<id>.md     e.g. tasks/pm-a1b2.md
  history/<id>.jsonl        append-only RFC6902 patch log
  locks/<id>.lock           exclusive lock metadata (JSON)
  settings.json             project configuration
  index/manifest.json       keyword index cache (optional, rebuildable)
  search/embeddings.jsonl   keyword corpus records (optional, rebuildable)
  extensions/               project-local extensions
```

### Item File Format

```
{
  "id": "pm-a1b2",
  "title": "...",
  ...
}

Optional markdown body here.
```

Fields are serialized in canonical key order (defined in `item-format.ts`).

## Mutation Contract

Every item mutation follows this sequence:

1. **Acquire lock** — exclusive open on `locks/<id>.lock`; reject if stale and no `--force`
2. **Read current item** — parse front-matter + body
3. **Compute `before_hash`** — SHA-256 of canonical `{ front_matter, body }` JSON
4. **Apply mutation** — in-memory model update
5. **Update `updated_at`** — every mutation must change this timestamp
6. **Compute patch + `after_hash`** — RFC6902 diff; SHA-256 of new canonical state
7. **Atomic write** — write to temp file; `rename` to target (single syscall, OS-atomic)
8. **Append history line** — JSONL append to `history/<id>.jsonl`
9. **Release lock** — unlink lock file

If step 7 or 8 fails, the item file is rolled back (if write succeeded) before returning failure.

## History and Restore

Each history entry is a JSONL line:

```json
{
  "ts": "ISO timestamp",
  "author": "string",
  "op": "create|update|append|...|restore",
  "patch": [ /* RFC6902 ops */ ],
  "before_hash": "sha256-hex",
  "after_hash": "sha256-hex",
  "message": "optional"
}
```

`pm restore <ID> <TIMESTAMP|VERSION>` replays patches from `op=create` through the target entry, rebuilding exact canonical state.

## Extension System

Extensions are Node.js modules with an `activate(api)` export:

```ts
export function activate(api: ExtensionApi): void {
  api.registerCommand({ name: "my command", run: async (args, opts, global) => { ... } });
  api.hooks.beforeCommand((ctx) => { ... });
}
```

Load order: **core built-ins → global (`~/.pm-cli/extensions/`) → project (`.agents/pm/extensions/`)**.

Project-local extensions override global by default. See [EXTENSIONS.md](./EXTENSIONS.md) for the full API reference.

## Search Architecture

- **Keyword mode** (always available): multi-factor lexical scoring with configurable field weights
- **Semantic mode** (requires provider + vector store config): embedding-based vector similarity
- **Hybrid mode** (default when semantic available): blended lexical + semantic ranking

Providers: OpenAI-compatible, Ollama
Vector stores: Qdrant, LanceDB

### Keyword Scoring

Each item is scored across: `title` (8×), `description` (5×), `tags` (6×), `status` (2×), `body` (1×), `comments`/`notes`/`learnings` (1× each), `dependencies` (3×). Exact title token matches add a bonus (10×).

Weights are configurable via `settings.json` under `search.tuning`.

## Configuration

`settings.json` is read from the PM root at startup. Key sections:

| Key | Description |
|-----|-------------|
| `id_prefix` | Prefix for generated IDs (default `pm-`) |
| `author_default` | Default author for mutations |
| `locks.ttl_seconds` | Lock TTL (default 1800) |
| `output.default_format` | `toon` or `json` |
| `search.*` | Search provider and tuning settings |
| `providers.openai` / `providers.ollama` | Embedding provider config |
| `vector_store.qdrant` / `vector_store.lancedb` | Vector store config |

Precedence: CLI flags > env vars (`PM_PATH`, `PM_AUTHOR`, etc.) > `settings.json` > hard defaults.

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Generic failure |
| 2 | Usage / invalid args |
| 3 | Not found |
| 4 | Conflict (lock / ownership) |
| 5 | Dependency failed (test-all) |

## Testing

Tests live in `tests/`:

```
tests/
  unit/           Unit tests (item format, lock, search, commands, extensions, etc.)
  integration/    Integration tests (CLI subprocess spawn, runtime/readiness coverage)
```

All tests run in sandboxed temp directories (`PM_PATH` + `PM_GLOBAL_PATH` isolated per suite). Coverage is enforced at 100% for lines, branches, functions, and statements.

Run all tests:

```bash
node scripts/run-tests.mjs test       # sandbox-safe, tests only
node scripts/run-tests.mjs coverage  # sandbox-safe, with coverage gate
```

The `scripts/run-tests.mjs` wrapper creates a temp directory, sets `PM_PATH` and `PM_GLOBAL_PATH`, runs Vitest, then cleans up.
