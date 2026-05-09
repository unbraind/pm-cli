# Architecture

This page is for contributors changing `pm-cli` internals. Users should start with [Quickstart](QUICKSTART.md). Agents should start with [Agent Guide](AGENT_GUIDE.md).

## Agent Quick Context

- CLI wiring lives in `src/cli/`.
- Domain behavior lives in `src/core/`.
- Public SDK exports live in `src/sdk/`.
- Items are stored as TOON by default; history is append-only JSONL.
- `pm contracts` is the machine-readable runtime contract source.

Tracked documentation work: [pm-1sb2](../.agents/pm/tasks/pm-1sb2.toon).

## System Overview

`pm-cli` is a TypeScript ESM CLI for Node.js 20+. It is file-backed, git-native, deterministic, and designed for concurrent human plus agent workflows.

High-level flow:

1. Commander parses CLI input in `src/cli/main.ts` with commands registered via per-family modules (`register-setup.ts`, `register-list-query.ts`, `register-mutation.ts`, `register-operations.ts`).
2. Command modules normalize options and call domain services.
3. Domain services load settings, acquire locks when needed, mutate canonical item documents, and append history.
4. Renderers emit TOON by default, JSON when requested, and markdown for calendar views.
5. Extensions can add commands, schema, renderers, import/export handlers, search providers, lifecycle hooks, and selected service overrides.

## Source Tree

```text
src/
  cli.ts
  cli/
    main.ts
    register-setup.ts
    register-list-query.ts
    register-mutation.ts
    register-operations.ts
    registration-helpers.ts
    commands/
    help-content.ts
    error-guidance.ts
    extension-command-options.ts
  core/
    extensions/
    fs/
    history/
    item/
    lock/
    output/
    search/
    store/
      front-matter-cache.ts
    test/
    shared/
  sdk/
    cli-contracts.ts
    index.ts
  types/
tests/
  unit/
  integration/
.agents/
  pm/
    extensions/
docs/
scripts/
```

Important public docs:

- [Command Reference](COMMANDS.md)
- [Configuration](CONFIGURATION.md)
- [Testing](TESTING.md)
- [Extensions](EXTENSIONS.md)
- [SDK](SDK.md)

## Storage Layout

Project tracker root defaults to `.agents/pm/`.

```text
.agents/pm/
  settings.json
  epics/
  features/
  tasks/
  chores/
  issues/
  decisions/
  events/
  reminders/
  milestones/
  meetings/
  history/
  locks/
  index/
  search/
  extensions/
```

Required data:

- item documents under type folders
- `history/<id>.jsonl`
- `settings.json`

Optional rebuildable data:

- keyword and vector search cache files
- generated index metadata

## Item Documents

Default format is TOON:

```toon
id: pm-a1b2
title: Implement restore replay
description: Restore should rebuild target item state from history.
type: Task
status: in_progress
priority: 1
tags[2]: history,restore
body: |
  Implementation notes.
```

Legacy JSON-front-matter markdown files are read only for one-way migration into TOON. Runtime internals use `metadata` as the item metadata model key.

Built-in item types:

- `Epic`
- `Feature`
- `Task`
- `Chore`
- `Issue`
- `Decision`
- `Event`
- `Reminder`
- `Milestone`
- `Meeting`

Runtime type resolution merges built-ins, `settings.item_types.definitions`, and extension `registerItemTypes(...)` registrations.

## Mutation Contract

Every item mutation follows the same safety path:

1. Resolve project root and settings.
2. Acquire item lock when mutating existing item state.
3. Read and parse the current canonical item document.
4. Enforce ownership and policy gates.
5. Compute `before_hash`.
6. Apply mutation in memory.
7. Set `updated_at`.
8. Compute RFC6902 patch and `after_hash`.
9. Write item atomically through temp-file plus rename.
10. Append one history JSONL line.
11. Release lock.

If a write fails after state changes begin, mutation code attempts rollback before returning the error.

## History and Restore

History entries are append-only JSONL records:

```json
{
  "ts": "2026-05-01T12:00:00.000Z",
  "author": "codex-agent",
  "op": "update",
  "patch": [],
  "before_hash": "sha256...",
  "after_hash": "sha256...",
  "message": "Start implementation"
}
```

`pm restore <id> <timestamp-or-version>` replays history from create through the target record and appends a restore event. Restore does not rewrite prior history.

Useful diagnostics:

```bash
pm history <id> --diff --verify
pm activity --id <id> --limit 50
pm validate --check-history-drift
```

## Command Contracts

Command/action metadata is centralized in `src/sdk/cli-contracts.ts` and used by:

- CLI option normalization
- help output
- completion generation
- Pi wrapper schema
- `pm contracts`
- extension command/action contract exposure

Use runtime contracts instead of duplicating flag lists:

```bash
pm contracts --json
pm contracts --command create --flags-only --json
pm help create --json
```

## Output Pipeline

Core output formats:

- TOON for sparse, token-efficient default command output
- JSON for strict machine parsing
- markdown for calendar-oriented views

The renderer omits null, undefined, empty arrays, and empty objects from sparse TOON fallback output. JSON preserves the machine payload.

## Search Architecture

Search supports:

- keyword mode, always available
- semantic mode, when an embedding provider and vector store are available
- hybrid mode, combining keyword and semantic results

Keyword scoring uses weighted fields such as title, description, tags, status, body, comments, notes, learnings, reminders, events, and dependencies. Semantic indexing uses the same core corpus so calendar-heavy work remains discoverable through normal search and reindex flows.

Runtime semantic components can come from built-ins or extensions:

- provider selection: `settings.search.provider`
- vector adapter selection: `settings.vector_store.adapter`
- extension registration: `registerSearchProvider(...)` and `registerVectorStoreAdapter(...)`

Useful commands:

```bash
pm search "restore history" --mode keyword --limit 10
pm reindex --mode hybrid --progress
pm health --check-only
```

## Extension Host

Load order:

1. core commands
2. global extensions
3. project extensions

Project extensions take precedence over global extensions for matching command or renderer keys. Extension dispatch is extension-first when a registered handler matches a core command path.

Extension override planes:

- commands
- parser overrides
- preflight overrides
- service overrides
- renderers
- import/export handlers
- item fields and item types
- migrations
- search providers and vector adapters
- lifecycle hooks

See [Extensions](EXTENSIONS.md) and [SDK](SDK.md).

## Testing Architecture

Tests live under:

```text
tests/unit/
tests/integration/
```

All tests must run with sandboxed `PM_PATH` and `PM_GLOBAL_PATH`. Use:

```bash
node scripts/run-tests.mjs test
node scripts/run-tests.mjs coverage
```

Linked-test execution also creates sandbox roots and can seed settings/extensions for schema parity. See [Testing](TESTING.md).

## Terminal Compatibility

Runtime behavior should remain terminal-neutral:

- no required ANSI or custom terminal protocol
- deterministic TOON/JSON/markdown output
- graceful `process.exitCode` handling
- broken-pipe-safe output writes
- explicit TTY rejection for stdin token paths that require piped input
- non-interactive linked-test subprocess handling

## Public Documentation Boundary

Architecture docs should describe source structure and public runtime behavior only. Ignored local operations material and host-specific runbooks must stay out of tracked docs.
