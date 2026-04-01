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
      calendar.ts                pm calendar / pm cal (agenda/day/week/month views)
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
      type-registry.ts           Runtime item-type registry (built-ins + settings + extensions)
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

Each item is stored as a format-configured document file:

```
.agents/pm/
  <type-folder>/<id>.toon   default item storage (TOON root-object fields)
  <type-folder>/<id>.md     fully supported JSON front matter + markdown body
  history/<id>.jsonl        append-only RFC6902 patch log
  locks/<id>.lock           exclusive lock metadata (JSON)
  settings.json             project configuration
  index/manifest.json       keyword index cache (optional, rebuildable)
  search/embeddings.jsonl   keyword corpus records (optional, rebuildable)
  extensions/               project-local extensions
```

### Item File Format

Default TOON item document:

```toon
id: pm-a1b2
title: ...
# ...
body: |
  Optional markdown body here.
```

Alternative markdown item document:

```md
```
{
  "id": "pm-a1b2",
  "title": "...",
  ...
}

Optional markdown body here.
```

Fields are normalized and serialized in canonical key order (defined in `item-format.ts`) before hashing/history patch generation, regardless of on-disk item format.

Type resolution is centralized in the runtime type registry:

- built-in types (`Epic`, `Feature`, `Task`, `Chore`, `Issue`)
- `settings.item_types.definitions`
- extension `registerItemTypes(...)` registrations

The registry is used by create/update validation, list/search/calendar type filters, completion scripts, and store path routing.

Scheduling metadata is persisted directly in item front matter:

- `reminders?: Array<{ at: ISO timestamp; text: string }>`
- reminders are normalized and sorted deterministically by `at` then `text`
- `events?: Array<{ start_at: ISO timestamp; end_at?: ISO timestamp; title?: string; description?: string; location?: string; timezone?: string; all_day?: boolean; recurrence?: RecurrenceRule }>`
- recurrence supports `freq`, `interval`, `count`, `until`, `by_weekday`, `by_month_day`, and `exdates`
- event and recurrence arrays are normalized/sorted deterministically for stable serialization
- `pm create` and `pm update` support repeatable `--reminder` and `--event` values (`none` clears)

### Parallel Git/Worktree Safety

`pm` storage is designed for high-concurrency git workflows (branches, worktrees, and multi-host collaboration):

1. **First-class dual formats** — `.toon` and `.md` are both supported for item storage.
2. **Single format of record per repo** — `settings.item_format` defines the canonical extension; migration removes alternate-extension drift.
3. **Deterministic canonicalization** — normalized fields and stable ordering reduce diff noise and improve merge predictability.
4. **Atomic writes** — item files are replaced via temp + `rename`, preventing torn writes.
5. **Append-only history** — `history/<id>.jsonl` records RFC6902 patches with before/after hashes for auditability and restore.

If concurrent edits modify the same semantic fields on separate branches, git can still surface textual conflicts. In those cases, the deterministic canonical model plus append-only history is intended to make reconciliation explicit and loss-resistant rather than silent.

## Mutation Contract

Every item mutation follows this sequence:

1. **Acquire lock** — exclusive open on `locks/<id>.lock`; reject if stale and no `--force`
2. **Read current item** — parse configured-format item (`.toon` or `.md`) into canonical `{ front_matter, body }`
3. **Compute `before_hash`** — SHA-256 of canonical `{ front_matter, body }` JSON
4. **Apply mutation** — in-memory model update
5. **Update `updated_at`** — every mutation must change this timestamp
6. **Compute patch + `after_hash`** — RFC6902 diff; SHA-256 of new canonical state
7. **Atomic write** — write configured-format item file via temp + `rename` (single syscall, OS-atomic)
8. **Append history line** — JSONL append to `history/<id>.jsonl`
9. **Release lock** — unlink lock file

If step 7 or 8 fails, the item file is rolled back (if write succeeded) before returning failure.

When `update --type` changes an item's resolved type folder, mutation logic performs a safe file move to the target folder and rolls back on failure.

## Calendar Pipeline

`pm calendar` (`pm cal`) is a read-only projection command that derives scheduling events from existing item metadata.

Pipeline:

1. Resolve PM root and load settings.
2. Read all item front matter records.
3. Apply deterministic item filters (`type`, `tag`, `priority`, `status`, `assignee`, `sprint`, `release`).
4. Expand each item into calendar events:
   - deadline event (if `deadline` is set)
   - reminder events (for each `reminders[]` entry)
   - one-off scheduled events (`events[]` entries without recurrence)
   - recurring event occurrences (`events[].recurrence`) expanded inside a bounded recurrence window
5. Apply source controls and recurrence bounds:
   - `--include deadlines|reminders|events|all`
   - `--recurrence-lookahead-days`, `--recurrence-lookback-days`
   - `--occurrence-limit` (cap per recurring event expansion)
6. Apply view windows:
   - `agenda` (default, optional `--from`/`--to`)
   - `day`, `week`, `month` (anchored by `--date`)
   - `--past` toggles lower-bound behavior for bounded views
7. Sort events deterministically by timestamp, priority, item id, event kind, event title, then reminder text.
8. Bucket events by UTC date and compute summary counts (`deadlines`, `reminders`, `scheduled`).

Output behavior is command-specific: `pm calendar` defaults to markdown for agent/human readability while keeping explicit `--format`/`--json` overrides. Global TOON defaults for other commands are unchanged.

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
| `item_format` | Item storage format: `toon` (default) or `json_markdown` |
| `locks.ttl_seconds` | Lock TTL (default 1800) |
| `output.default_format` | `toon` or `json` |
| `item_types.definitions[]` | Custom type names, aliases, folders, required fields/repeatables, and `--type-option` definitions |
| `search.*` | Search provider and tuning settings |
| `providers.openai` / `providers.ollama` | Embedding provider config |
| `vector_store.qdrant` / `vector_store.lancedb` | Vector store config |

Precedence: CLI flags > env vars (`PM_PATH`, `PM_AUTHOR`, etc.) > `settings.json` > hard defaults.

For repositories created before `item_format` existed, mutating item commands are blocked until an explicit format is selected through `pm config ... item-format --format ...`. Once selected (or changed), item files are automatically migrated to the configured format, and when both `.md` and `.toon` exist for an item, the configured format is the source of truth.

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
