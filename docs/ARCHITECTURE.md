# Architecture

This page is for contributors changing `pm-cli` internals. Users should start with [Quickstart](QUICKSTART.md). Agents should start with [Agent Guide](AGENT_GUIDE.md).

## Agent Quick Context

- CLI wiring lives in `src/cli/`.
- Domain behavior lives in `src/core/`.
- Public SDK exports live in `src/sdk/`.
- Items are stored as TOON by default; history is append-only JSONL.
- `pm contracts` is the machine-readable runtime contract source.

Tracked documentation work: [pm-u9d0](../.agents/pm/epics/pm-u9d0.toon).

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
    schema/
    search/
    store/
      front-matter-cache.ts
    test/
    validate/
    shared/
  mcp/
    server.ts
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
  plans/
  stories/
  history/
  locks/
  schema/
  checkpoints/
  runtime/
  search/
  extensions/
```

Type folders are created on demand: the listing above shows the built-in item
types plus `stories/`, a representative folder created by a custom or preset
type. `schema/` holds config-driven customization (`types.json`,
`statuses.json`, `fields.json`), `checkpoints/` holds bulk-mutation rollback
snapshots, and `runtime/` holds non-canonical operational state (for example
background-refresh coordination). The legacy required `index/` directory was
removed in 2026-05-31 ([pm-yf31](../.agents/pm/issues/pm-yf31.toon)).

Required data:

- item documents under type folders
- `history/<id>.jsonl`
- `settings.json`

Optional rebuildable data:

- keyword and vector search cache files (`search/`)
- `checkpoints/` and `runtime/` operational state

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

Built-in item types (11; confirm at runtime with `pm schema list`):

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
- `Plan`

Runtime type resolution merges built-ins, persisted project schema in
`.agents/pm/schema/types.json` (`pm schema add-type` / `pm init --type-preset`),
`settings.item_types.definitions`, and extension `registerItemTypes(...)`
registrations.

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
pm history <id> --full --diff --verify
pm activity --id <id> --limit 50
pm validate --check-history-drift
```

## Command Contracts

Command/action metadata is centralized in `src/sdk/cli-contracts.ts` and used by:

- CLI option normalization
- help output
- completion generation
- provider-safe tool schemas
- `pm contracts`
- extension command/action contract exposure

Use runtime contracts instead of duplicating flag lists:

```bash
pm contracts --json
pm contracts --command create --flags-only --json
pm help create --json
```

### Adding a Command or Flag (Wiring Checklist)

A new command or field-mutating flag touches several registries. Missing one
produces a silently partial surface (for example a flag that parses on the CLI
but is absent from `pm contracts`, MCP, or completions). Wire each site that
applies:

1. **Commander registration** — register the command/flag in the relevant
   `src/cli/register-*.ts` family module (`register-setup`, `register-list-query`,
   `register-mutation`, `register-operations`).
2. **Command module** — implement the handler under `src/cli/commands/` and add
   it to the `src/cli/commands/index.ts` barrel. The static orphan-modules gate
   fails on a command module that only the dynamic dispatcher imports, so the
   barrel export is mandatory.
3. **Flag contracts** — declare flags in `src/sdk/cli-contracts.ts` (the
   `*_FLAG_CONTRACTS` registries). Use `list: true` only for comma-list
   accumulation flags, never for Commander `collect` repeatable flags. Flags that
   should not appear in the public surface go through the `NO_SURFACE` set.
4. **MCP exposure** — if the command is agent-callable, add or extend its tool in
   `src/mcp/tool-definitions.ts` (tool definition plus parameter properties).
   Shared parameter names (`fields`, `scope`) are owned centrally — prefer a new
   boolean over overloading a shared enum.
5. **Option policies** — if the flag participates in `command_option_policies`
   (provided-set governance), wire it into the command's policy declaration.
6. **Dependency-audit scope** — field mutations that must be excluded from
   audit-only update scopes belong in the update command's disallowed list.
7. **Docs and completions** — document the command in
   [Command Reference](COMMANDS.md); completion output is generated from the
   contracts, so confirm `pm completion` reflects the new surface.
8. **Contract snapshot** — run `pnpm contracts:update` to regenerate
   `tests/fixtures/contracts/full.json`; the static gate compares against it.
9. **Coverage** — add focused tests so the new module keeps the corpus at
   `100/100/100/100` (see [Testing Architecture](#testing-architecture)).

Verify the end-to-end surface with `pm contracts --command <name> --json`,
`pm help <name> --json`, and the matching MCP tool listing.

## Telemetry Schema Negotiation

Telemetry preserves wire compatibility through an explicit client/server negotiation split:

- Event payloads keep `event.schema_version` as the event-document schema (currently v1).
- Queue envelopes include `client_schema_version` so client/runtime evolution can be tracked independently from event payload versioning.
- `pm health --check-telemetry` probes `/healthz` and records any advertised max-version header for observability/debugging.

This keeps v1 behavior stable while providing a forward path for future telemetry schema upgrades.

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

## Performance and Startup Latency

`pm-cli` is optimized for the agent loop, where many short commands run back to
back. The performance model has three layers (the absolute timings below are
indicative order-of-magnitude figures at the time of writing — treat the relative
behavior, not the exact milliseconds, as the durable contract):

- **Per-command startup.** After a command-family code split, each handler
  imports only its own command module rather than the full command barrel, so a
  read command does not pay for mutation/search modules. On a clean project the
  dominant remaining cost is Node ESM module resolution (~90ms); this is the last
  structural startup lever and is tracked under the observability epic.
- **Reads.** The front-matter cache splits item metadata from body text and skips
  re-reads of unchanged files, and on-read hooks are skipped when no extension
  registers one. `pm health` uses a drift-scan verification cache so repeated
  health checks do not re-hash every history stream.
- **Mutations.** Mutations are non-blocking: the semantic reindex runs in a
  detached background worker behind a reindex lock instead of inline embedding,
  and item-format migration skips already-migrated items rather than re-parsing
  the whole corpus on every write. This is what keeps `create`/`update` in the
  hundreds-of-milliseconds range instead of multi-second inline-embed latency.

What dominates latency in a given repository:

- a clean project is fast (~140ms); a large dev repo is slower mainly from many
  auto-loaded extensions and any inline embedding provider, not from item count.
- `pm --version` short-circuits before the main entrypoint, so it is **not** a
  valid probe for command startup cost.

Profiling startup cost:

```bash
node --cpu-prof --cpu-prof-dir=/tmp/pmprof dist/cli.js list >/dev/null
pm health --check-only          # drift-scan + telemetry timings
```

Reindex and embedding remain the heaviest background operations; keep them off
the synchronous mutation path. See the observability epic
([pm-5oj5](../.agents/pm/epics/pm-5oj5.toon)) for tracked perf work.

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

Coverage governance is literal all-source, not a curated allowlist:

- `vitest.config.ts` `coverage.include` is the full ship surface: `src/*.ts`,
  `src/**/*.ts`, `packages/**/*.ts`, `scripts/*.mjs`, `scripts/**/*.mjs`,
  `plugins/*.mjs`, `plugins/**/*.mjs`, and the `docs/examples/**/*.{ts,js,mjs}`
  reference snippets. The only `coverage.exclude` entry is `src/**/*.d.ts`
  (type-only declarations have no executable lines).
- Global thresholds are `100/100/100/100` (lines/branches/functions/statements)
  for the whole measured corpus — there is no per-file ratchet and no per-file
  `/* c8 ignore */` allowlist for production modules.
- Adding a new module under any included root automatically pulls it into the
  gate. There is no include-list to edit; if a new module is genuinely not
  shippable source (a throwaway script), it belongs outside these roots rather
  than in a hand-maintained exclude list.
- When authoring example snippets under `docs/examples/`, import the published
  SDK by its bare specifier (`@unbrained/pm-cli/sdk`); `vitest.config.ts` aliases
  that to `src/sdk/index.ts` so the example specs cover without the workspace
  self-link present in a clean CI install.
- When a module is hard to test end-to-end (for example CLI orchestration),
  extract pure logic helpers into small modules and cover those directly instead
  of weakening thresholds. Run `node scripts/run-tests.mjs coverage` locally to
  confirm `100/100/100/100` before pushing.

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
