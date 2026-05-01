# pm-cli Architecture

This document describes the internal architecture of `pm-cli` for contributors and maintainers.

## Overview

`pm-cli` is a TypeScript ESM CLI built on Node.js 20+. It follows a clean separation between CLI wiring and domain logic:

```
src/
  cli/            CLI layer: command registration, option parsing, output rendering
  core/           Domain logic: storage, locking, history, search, extensions
  extensions/     Optional extension authoring sources (non-bundled)
  types/          Shared TypeScript type definitions
.agents/
  pm/extensions/  Bundled managed extension sources shipped with package (beads, todos)
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
      templates.ts               pm templates save/list/show
      get.ts                     pm get
      update.ts                  pm update (including ownership-safe metadata audits via --allow-audit-update and dependency-only audits via --allow-audit-dep-update)
      update-many.ts             pm update-many (bulk apply/dry-run/rollback checkpoint workflow)
      normalize.ts               pm normalize (lifecycle metadata dry-run planning + optional apply workflow)
      append.ts                  pm append
      close.ts                   pm close (includes optional close-time validation mode)
      delete.ts                  pm delete
      claim.ts                   pm claim / release
      release.ts                 (re-exports from claim.ts)
      list.ts                    pm list (active-only: excludes closed/canceled) / list-all / list-* commands with projection, sorting, offset, and JSON stream controls
      aggregate.ts               pm aggregate (default grouped child-count governance queries)
      dedupe-audit.ts            pm dedupe-audit (exact/fuzzy/parent-scoped duplicate clustering)
      calendar.ts                pm calendar / pm cal (agenda/day/week/month views)
      context.ts                 pm context / pm ctx (critical work + agenda snapshot)
      comments.ts                pm comments
      notes.ts                   pm notes
      learnings.ts               pm learnings
      files.ts                   pm files
      docs.ts                    pm docs
      deps.ts                    pm deps (dependency tree/graph projection)
      test.ts                    pm test (add/remove/run linked tests; optional forced progress visibility)
      test-all.ts                pm test-all (orchestration; optional forced progress visibility + pre-run limit/offset pagination)
      test-runs.ts               pm test-runs (background run lifecycle: list/status/logs/stop/resume; bare command defaults to list)
      search.ts                  pm search (keyword / semantic / hybrid)
      reindex.ts                 pm reindex (optional forced progress visibility)
      history.ts                 pm history
      activity.ts                pm activity (timeline filters + JSON stream mode)
      restore.ts                 pm restore
      stats.ts                   pm stats
      health.ts                  pm health
      validate.ts                pm validate (metadata/resolution/lifecycle/files/command-reference/history drift checks)
      gc.ts                      pm gc (dry-run and scoped cache cleanup)
      contracts.ts               pm contracts (machine-readable contracts/schema surface)
      config.ts                  pm config
      extension.ts               pm extension lifecycle manager (install/uninstall/explore/manage/activate/deactivate)
      completion.ts              pm completion (lazy/eager tag completion modes)
      beads.ts                   Beads import runtime used by bundled managed extension
      todos.ts                   Todos import/export runtime used by bundled managed extension
      index.ts                   barrel re-export
    extension-command-options.ts Loose option parser for dynamic extension commands
  core/
    extensions/
      loader.ts                  Extension manifest discovery, load, activate
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
      parent-reference-policy.ts Parent-reference policy normalization + warning/strict validation helpers
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
    test/
      background-runs.ts         Background linked-test run registry/worker lifecycle + dedupe
      item-test-run-tracking.ts  Settings-gated bounded item `test_runs` summary persistence
    telemetry/
      consent.ts                 First-run telemetry consent prompt + non-interactive guardrails
      runtime.ts                 Telemetry event capture, redaction, queueing, and exporter retry flow
    shared/
      command-types.ts           GlobalOptions, shared command type definitions
      constants.ts               Exit codes, required directory names
      conflict-markers.ts        Merge-conflict marker detection helpers
      errors.ts                  PmCliError with exit code + optional guidance context
      serialization.ts           Deterministic JSON serialization (stable key order)
      time.ts                    ISO/date parsing helpers, relative offsets, and field-attributed parse diagnostics
      index.ts                   barrel
    store/
      item-store.ts              File-backed item CRUD with lock/atomic write contract
      paths.ts                   PM root resolution (PM_PATH, --path, cwd)
      settings.ts                settings.json read/write
      index.ts                   barrel
  types/
    index.ts                     ItemFrontMatter, ItemType, ItemStatus, Dependency, etc.
  sdk/
    cli-contracts.ts             Canonical command/action contracts + JSON Schema exports
    index.ts                     Public SDK exports
  command-types.ts               (re-export shim)
  constants.ts                   (re-export shim)
  errors.ts                      (re-export shim)
  ... (other re-export shims for backward compat)
.agents/
  pm/
    extensions/
      beads/
        manifest.json            Bundled managed beads extension manifest
        index.js                 Registers `beads import` command and loads runtime from dist
      todos/
        manifest.json            Bundled managed todos extension manifest
        index.js                 Registers `todos import` / `todos export` and loads runtime from dist
```

## Command Contract Registry

Command/action contract metadata is centralized in `src/sdk/cli-contracts.ts`.

The same registry drives:

- commander option normalization in `src/cli/main.ts`
- shell completion flag/command surfaces in `src/cli/commands/completion.ts`
- Pi wrapper action enum, tool `inputSchema`, and CLI arg mapping in `.pi/extensions/pm-cli/index.ts`
- runtime `pm contracts` payload generation for action/command/schema introspection
- runtime schema augmentation for active extension commands/actions (including extension source metadata and extension-defined flag surfaces)
- additive command surfaces such as `templates-*` actions, extension lifecycle actions (`extension-install`, `extension-uninstall`, `extension-explore`, `extension-manage`, `extension-doctor`, `extension-adopt`, `extension-adopt-all`, `extension-activate`, `extension-deactivate`), `history --diff/--verify`, files/docs path hygiene flags (`--add-glob`, `--migrate`, `--append-stable`, `--validate-paths`, `--audit`), validate governance/file drift flags (`--check-lifecycle`, `--check-stale-blockers`, `--scan-mode`, `--include-pm-internals`), list projection/sort controls (`--compact`, `--fields`, `--sort`, `--order`), `aggregate`/`dedupe-audit` action surfaces, comments-audit governance filters/export controls (`--parent`, `--tag`, `--sprint`, `--release`, `--priority`, `--latest`, `--full-history`, `--limit` alias), lifecycle aliases (`start-task`, `pause-task`, `close-task`), bulk mutation (`update-many`), lifecycle metadata normalization (`normalize`), and ownership-safe audit update controls (`update --allow-audit-update`, `update --allow-audit-dep-update`), health vector refresh controls (`--check-only`, `--no-refresh`, `--refresh-vectors`), contracts projections (`--flags-only`, `--availability-only`), completion mode controls (`--eager-tags` + lazy `completion-tags` path), calendar period control (`--full-period`), activity filtering/stream controls (`--id`, `--op`, `--author`, `--from`, `--to`, `--stream`), global pager suppression (`--no-pager`), `create --create-mode`, `comments --allow-audit-comment`, `release --allow-audit-release`, `test-all --limit/--offset`, run-level PM-context override (`--override-linked-pm-context`), linked-test preflight/remediation controls (`--check-context`, `--auto-pm-context`), `gc --dry-run/--scope`, `update --replace-deps`, richer `deps` traversal controls, and `contracts` create-required metadata projections

This keeps human CLI UX and machine-facing contracts aligned while preserving additive evolution; new projection flags such as `--command`, `--flags-only`, and `--availability-only` provide lower-noise machine payloads without replacing the full default contract corpus.

Contract projection behavior also keeps action filters deterministic: when `pm contracts --flags-only` is called with `--action` and no `--command`, the emitted `command_flags` rows are scoped to commands that implement the selected action(s).

## Item Storage

Each item is stored as a format-configured document file:

```
.agents/pm/
  <type-folder>/<id>.toon   default item storage (TOON root-object fields)
  <type-folder>/<id>.md     fully supported JSON metadata object + markdown body
  history/<id>.jsonl        append-only RFC6902 patch log
  locks/<id>.lock           exclusive lock metadata (JSON)
  settings.json             project configuration
  index/manifest.json       keyword index cache (optional, rebuildable)
  search/embeddings.jsonl   keyword corpus records (optional, rebuildable)
  search/vectorization-status.json semantic vector freshness ledger (optional, rebuildable)
  extensions/               project-local extensions
  extensions/.managed-extensions.json scope-local extension manager state (optional, lifecycle-managed)
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

`front_matter` is the internal object key used by the TypeScript document model; TOON files store identical metadata as top-level keys (no YAML front matter layer).

Type resolution is centralized in the runtime type registry:

- built-in types (`Epic`, `Feature`, `Task`, `Chore`, `Issue`, `Event`, `Reminder`, `Milestone`, `Meeting`)
- `settings.item_types.definitions`
- extension `registerItemTypes(...)` registrations

The registry is used by create/update validation, list/search/calendar type filters, completion scripts, and store path routing.

Type definitions can additionally provide `command_option_policies` entries (`create`/`update`) to mark options as required, disabled, or hidden in policy-aware help guidance while preserving default behavior when unset.

Scheduling metadata is persisted directly in item metadata:

- `reminders?: Array<{ at: ISO timestamp; text: string }>`
- reminders are normalized and sorted deterministically by `at` then `text`
- `events?: Array<{ start_at: ISO timestamp; end_at?: ISO timestamp; title?: string; description?: string; location?: string; timezone?: string; all_day?: boolean; recurrence?: RecurrenceRule }>`
- recurrence supports `freq`, `interval`, `count`, `until`, `by_weekday`, `by_month_day`, and `exdates`
- event and recurrence arrays are normalized/sorted deterministically for stable serialization
- `pm create` and `pm update` support repeatable `--reminder` and `--event` values with explicit clear flags (`--clear-reminders`, `--clear-events`)

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
3. **Enforce history stream policy** — for existing-item mutations, apply `settings.history.missing_stream` (`auto_create` or `strict_error`) before mutation writes
4. **Compute `before_hash`** — SHA-256 of canonical `{ front_matter, body }` JSON
5. **Apply mutation** — in-memory model update
6. **Update `updated_at`** — every mutation must change this timestamp
7. **Compute patch + `after_hash`** — RFC6902 diff; SHA-256 of new canonical state
8. **Atomic write** — write configured-format item file via temp + `rename` (single syscall, OS-atomic)
9. **Append history line** — JSONL append to `history/<id>.jsonl`
10. **Release lock** — unlink lock file

If step 7 or 8 fails, the item file is rolled back (if write succeeded) before returning failure.

When `update --type` changes an item's resolved type folder, mutation logic performs a safe file move to the target folder and rolls back on failure.
`pm update` now supports transactional linked/log collection mutations (`--comment`, `--note`, `--learning`, `--file`, `--test`, `--doc`) so metadata and linked surfaces can be updated under one lock/history entry. Dedicated commands (`pm comments|notes|learnings|files|test|docs`) remain available for focused single-surface operations.

### Additive Diagnostics and Path Hygiene

- `pm history --diff` adds field-level patch summaries without changing base history output.
- `pm history --verify` validates stream hash-chain replay and current-item hash alignment.
- `pm close --validate-close [warn|strict]` adds optional close-time resolution-field validation without changing default close semantics.
- `pm files` and `pm docs` support additive linked-path hygiene options:
  - `--add-glob <pattern>` for deterministic batch expansion into linked entries
  - `--migrate from=<old>,to=<new>` for bulk prefix migration
  - `--append-stable` on `pm files` to append/dedupe without full-array resorting
  - `--validate-paths` for resolved path-existence checks
  - `--audit` for cross-item linked-path usage inspection
  - `pm files --list` for explicit non-mutating linked-file listing
  - `pm files discover <ID>` scans item text fields for existing project/global file paths, reports addable vs already linked candidates, and only writes missing links when `--apply` is supplied
- `pm comments|notes|learnings --allow-audit-comment` enables append-only audit log entries on items assigned to other owners without broad ownership override semantics.
- `pm release --allow-audit-release` enables non-owner release handoffs that only clear assignee metadata without broad ownership override semantics.
- `pm comments-audit` now emits additive top-level governance `summary` metrics (`totals`, coverage ratio/percent, and `by_type`) across latest and full-history export modes while preserving existing item/export payloads; `--limit` is available as an alias for legacy `--limit-items`.
- `pm test-runs` now defaults bare command execution to list output, aligning CLI behavior with explicit `pm test-runs list`.
- `pm create --create-mode strict|progressive` keeps strict mode as default while enabling staged progressive creation for governance triage workflows.
- Strict create-mode missing-required guidance now includes direct remediation hints (`--create-mode progressive`, and scheduling-type `--schedule-preset lightweight` guidance for `Reminder`/`Meeting`/`Event`).
- Time/date parse errors are field-attributed (for example `event.end`, `reminder.at`, `--from`, `deadline-before`) with explicit guidance when unsupported compound relative expressions (for example `+3d+1h`) are provided.
- `pm create` log-seed repeatables (`--comment`, `--note`, `--learning`) now enforce explicit key boundaries (`author`, `created_at`, `text`) and reject parsed extra keys with usage guidance so unquoted key:value-like comma continuations cannot silently truncate seeded narrative text.
- `pm deps --format tree|graph --max-depth <n> --collapse none|repeated --summary` provides read-only dependency traversal from stored front matter, with deterministic ordering, cycle markers, missing-node reporting, and governance-friendly bounded projections.
- `pm update --replace-deps` enables one-shot atomic dependency replacement without separate clear/add mutations.
- `pm update --allow-audit-update` provides ownership-safe non-owner metadata mutation mode with explicit lifecycle/ownership guardrails.
- `pm update --allow-audit-dep-update` provides ownership-safe non-owner append-only dependency additions (`--dep`) without broad force semantics.
- `pm update-many` adds native bulk mutation orchestration with deterministic filter targeting, dry-run planning, checkpoint capture, and rollback-by-checkpoint-id flow; apply payload parity now includes linked-array mutation flags (`--dep/--comment/--note/--learning/--file/--test/--doc/--reminder/--event`), explicit `--clear-*` controls, and atomic `--replace-deps`/`--replace-tests` semantics while dry-run planning reports linked-array mutation intent per item.
- Lifecycle aliases (`pm start-task`, `pm pause-task`, `pm close-task`) compose claim/update/close/release primitives into discoverable single commands while preserving canonical history entries.
- `pm get` now returns `claim_state` metadata (active assignee plus latest claim/release history context) for ownership-aware automation.
- `pm get --json` payload shape is deterministic: `{ item, body, linked, claim_state }`, with body intentionally top-level for single-item diff/merge workflows.
- `pm list` / `pm list-*` support additive projection (`--compact`, `--fields`, `--include-body`), configurable sorting (`--sort`, `--order`), `--offset` pagination, and JSON-only `--stream` line-delimited output for large datasets.
- `pm aggregate` provides grouped count projections (default `--group-by parent,type`; supported dimensions: `parent,type,priority,status,assignee,tags,sprint,release`; `--count` accepted for explicit parity) for governance decomposition and triage checks.
- `pm gc` now supports no-side-effect previews (`--dry-run`) and scoped cleanup (`--scope index|embeddings|runtime`) with output guidance for reindex follow-up when search artifacts are removed.
- `pm dedupe-audit` provides exact-title, fuzzy-title, and parent-scoped duplicate cluster detection with machine-readable merge suggestions.
- `pm validate` runs standalone repository checks (`metadata`, `resolution`, `lifecycle`, `files`, `command_references`, `history_drift`), supports metadata policy selection via `--metadata-profile core|strict|custom`, supports lifecycle-governance drift targeting via `--check-lifecycle` plus optional stale-blocker heuristics via `--check-stale-blockers`, reads lifecycle pattern lists from `settings.validation.lifecycle_*_patterns` (tunable through config criteria-list keys), reports deterministic pattern-source metadata (`default|settings`) and effective pattern arrays in lifecycle check details, supports file candidate selection via `--scan-mode default|tracked-all|tracked-all-strict`, supports additive internal-audit coverage with `--include-pm-internals`, and returns deterministic filtered + raw file scan metrics, structured `excluded_by_reason` summaries, plus stale PM-id command-reference diagnostics.

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
   - `--full-period` (day/week/month only) keeps full anchored-period lower bounds instead of now-clipping
7. Sort events deterministically by timestamp, priority, item id, event kind, event title, then reminder text.
8. Bucket events by UTC date and compute summary counts (`events`, `items`, `deadlines`, `reminders`, `scheduled`) plus deterministic aggregate breakdowns (`by_kind`, `by_type`, `by_status`, `recurring_events`).
9. Render markdown event rows with deterministic detail tokens (item type, recurrence markers/rules, end-time derivation, timezone/location metadata, and description context when present).

Output behavior is command-specific: `pm calendar` defaults to markdown for agent/human readability while keeping explicit `--format`/`--json` overrides. Calendar range payloads include `period_start`/`period_end` and `full_period` metadata for deterministic downstream interpretation. Global TOON defaults for other commands are unchanged.

## Context Pipeline

`pm context` (`pm ctx`) is a read-only context-assembly command that combines prioritized active work with agenda/reminder visibility.

Pipeline:

1. Run `list` logic with non-terminal filtering and optional shared filters (`type`, `tag`, `priority`, `parent`, `assignee`, `sprint`, `release`).
2. Rank candidate items deterministically by status (`in_progress` before `open`), then priority, explicit `order`, deadline proximity, recency, and id tie-break.
3. Split ranked active items into:
   - high-level focus (`Epic`, `Feature`)
   - low-level focus (all other item types, including calendar-native built-ins such as `Event`, `Reminder`, `Milestone`, and `Meeting`)
4. If active focus is empty, project top blocked items into a blocked fallback section.
5. Run `calendar` logic in agenda mode with shared filters and context window controls (`--date`, `--from`, `--to`, `--past`).
6. Filter agenda projection to non-terminal items and summarize deadlines/reminders/events counts.
7. Return deterministic context payload (`output_default`, `window`, `filters`, `summary`, focus sections, and agenda section) with TOON default output and optional `--format`/`--json` overrides.

## Activity Pipeline

`pm activity` is a read-only history projection command for timeline inspection and automation export.

Pipeline:

1. Resolve PM root and enumerate history stream files.
2. Parse history records in deterministic timestamp order.
3. Apply optional filters (`--id`, `--op`, `--author`, `--from`, `--to`) before row materialization.
4. Validate time-window bounds (`--from <= --to`) and return usage errors deterministically on invalid windows.
5. Apply `--limit` to bounded result sets.
6. Render either:
   - standard payload `{ activity, count, limit, filters }`, or
   - JSON stream mode (`--json --stream [rows|ndjson|jsonl]`) with deterministic `meta` then `entry` records.

## Terminal and Process I/O Compatibility

`pm-cli` keeps runtime behavior terminal-neutral so commands behave consistently across native shells, IDE-integrated terminals, and emulated PTY backends:

1. **Plain deterministic output** — core output paths emit TOON/JSON/markdown text with stable key ordering and no required custom terminal control protocol.
2. **Sparse TOON fallback output** — default TOON output renders command payloads directly and recursively omits `null`/`undefined`/empty arrays/empty objects to reduce token overhead while preserving meaningful scalar values.
3. **Fail-fast stdin semantics** — stdin token readers reject interactive TTY stdin for piped-only flows (`-`) and provide explicit EOF guidance instead of waiting indefinitely.
4. **Graceful error exits** — CLI error handling preserves canonical exit codes using graceful `process.exitCode` semantics to reduce output truncation risk under buffered writes.
5. **Broken-pipe-safe output writes** — stream error handlers treat `EPIPE` as expected pipeline behavior: stdout writes preserve successful exits (pipeline-friendly readers) while stderr `EPIPE` remains non-zero, and both suppress unhandled stack traces.
6. **Linked test runtime hardening** — linked test subprocess execution uses shell-compatible spawn orchestration, closes child stdin immediately, applies deterministic runtime environment defaults, supports additive run-level/per-test env directives (`--env-set`, `--env-clear`, `--shared-host-safe`, plus linked metadata `env_set`/`env_clear`/`shared_host_safe`), supports additive PM-context controls (`--pm-context schema|tracker|auto`, `--override-linked-pm-context`, `--check-context`, `--auto-pm-context`, linked metadata `pm_context_mode=schema|tracker|auto`, `--fail-on-context-mismatch`, `--fail-on-skipped`, `--fail-on-empty-test-run`, `--require-assertions-for-pm`), enforces default schema-mode mismatch failures for PM tracker-read linked commands, emits mismatch guidance that explicitly calls out per-test `pm_context_mode` overrides when they supersede run-level context mode (unless explicitly overridden), can emit deterministic `context_preflight` warning summaries when requested, evaluates optional linked-test assertions (stdout/stderr contains/regex, min-lines, JSON equals/gte), detects high-confidence empty-selection runner signals when `--fail-on-empty-test-run` is enabled, emits per-run `execution_context` metadata for PM-command parity diagnostics (including tracker-read classification, `requested_pm_context_mode`, and `auto_pm_context_applied`), emits interactive stderr heartbeat progress for long runs (with explicit non-interactive `--progress`), supports managed background execution (`--background`) with `pm test-runs` lifecycle controls and duplicate-run fingerprints plus hardened `requested_by` fallback attribution, supports pre-run blast-radius pagination in `pm test-all` via `--offset`/`--limit`, enforces timeout/maxBuffer diagnostics with force-kill fallback plus structured failure categorization (`infra_collision`, `assertion_failure`, `empty_run`, etc.), and maps `pm test --run` linked failures to dependency-failed exit code (`5`) for CI-safe gating parity with `pm test-all`.

## Help and Error Guidance Pipeline

Help and error UX is centralized to reduce per-command drift:

1. `src/cli/help-content.ts` defines command-path help bundles (`why`, `examples`, optional `tips`) and attaches compact help by default (`Intent` + one example) with deep help enabled via `--explain`.
2. `src/cli/main.ts` performs bootstrap routing for help paths so `pm help`/`pm help <command>` are deterministic success flows, non-interactive help routes suppress pager blocking (auto-disable when stdout is not TTY), global `--no-pager` provides explicit pager suppression, and `--help --json` emits machine-readable help payloads.
3. Dynamic extension command descriptors (intent/action/examples/failure hints/arguments/flags) are merged into runtime help surfaces when available, with graceful fallback for legacy extensions that only register command handlers/flags.
4. `src/cli/error-guidance.ts` defines canonical guidance descriptors and renders either structured text sections or machine-readable JSON envelopes (`type`, `code`, `title`, `detail`, `required`, `exit_code`, optional remediation fields), with `PmCliError.context` overrides for precise runtime guidance.
5. `src/cli/main.ts` routes commander usage failures and `PmCliError` failures through these renderers, emitting JSON diagnostics when `--json` is active.
6. Commander native stderr writes are suppressed so the CLI emits a single high-signal guidance payload per failure path.

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

Extensions are Node.js modules with an `activate(api)` export. For package consumers, extension types and helpers are exported through `@unbrained/pm-cli/sdk`.

```ts
export function activate(api: ExtensionApi): void {
  api.registerCommand({
    name: "my command",
    action: "my-command",
    intent: "Short command intent shown in runtime help/contracts.",
    examples: ["pm my command --limit 5"],
    run: async (context) => ({ ok: true, command: context.command }),
  });
  api.hooks.beforeCommand((ctx) => { /* ... */ });
}
```

Load order: **core built-ins → global (`~/.pm-cli/extensions/`) → project (`.agents/pm/extensions/`)**.

Project-local extensions override global by default. Runtime dispatch is extension-first: if an extension registers a command handler for an existing core command path, the extension handler executes instead of the core action. Command result overrides and renderer overrides are still evaluated after dispatch with deterministic "last registration wins" precedence.

Lifecycle manager command architecture:

- `src/cli/commands/extension.ts` implements `pm extension` actions (`install`, `uninstall`, `explore`, `manage`, `doctor`, `adopt`, `adopt-all`, `activate`, `deactivate`) with deterministic validation, mutually-exclusive action routing, doctor-only strict warning exit controls (`--strict-exit`, alias `--fail-on-warn`), optional doctor trace payloads (`--trace` with `--detail deep`), manage runtime parity probes (`--runtime-probe`), optional managed-state remediation (`--fix-managed-state`), and explicit extension state semantics (`active` compatibility alias + `enabled`/`runtime_active`/`activation_status`).
- Install sources support local directories, GitHub HTTPS URLs, `github.com/<owner>/<repo>[/path]`, and forced shorthand via `--gh/--github`.
- Scope-local managed state is persisted at `<extensions-root>/.managed-extensions.json` for deterministic source metadata, install/update timestamps, and update-check status.
- `--manage` executes GitHub remote checks (`git ls-remote`) for managed GitHub entries, updates managed-state metadata, and emits deterministic per-extension `update_check_status`/`update_check_reason` fields plus `details.triage` status totals/remediation hints. With `--runtime-probe`, manage performs doctor-like runtime activation probes and annotates runtime probe execution metadata.
- `--adopt-all` bulk-adopts unmanaged scope extensions into managed-state metadata without reinstalling files.
- Health diagnostics include managed extension summaries/warnings for both project and global extension roots and a condensed `details.triage` surface for load/activation/migration triage, including update-coverage parity warning codes (`extension_update_health_partial_coverage`) when unmanaged extensions are action-required, capability guidance metadata, and machine-readable capability contract metadata for unknown manifest capabilities.

Extension Host V2 adds three additional override planes:

1. **Parser overrides** (`registerParser`) run before command dispatch and can normalize/replace `args`, `options`, and `global` command context.
2. **Preflight overrides** (`registerPreflight`) run before mutation gates and can control whether item-format write gates, pre-mutation format sync, extension migrations, and mandatory-migration write blocking are enforced.
3. **Service overrides** (`registerService`) expose deterministic replacement points for output/error/help formatting plus internal lock/history/item-store operations.

Runtime registration wiring now includes:

- `registerFlags(...)` deterministic shape validation (`long`/`short` presence plus typed metadata) before dynamic help registration.
- `registerCommand({ ... })` optional metadata (`action`, `description`, `intent`, `examples`, `failure_hints`, `arguments`, `flags`) is validated and stored for runtime help/contracts introspection.
- `registerItemFields(...)` defaults/validation on create and update write paths.
- `registerItemTypes(...)` deterministic schema validation for required type/policy/option fields before type-registry merge.
- `registerMigration(...)` mandatory migration execution + write gating in command preflight.
- `registerMigration(...)` activation-time validation for typed migration metadata (`id`, `description`, `status`, `mandatory`, `run`) when provided.
- `registerParser(...)` command-scoped parser override registry with deterministic last-wins behavior.
- `registerPreflight(...)` preAction decision override registry for mutation gate and migration orchestration.
- `registerService(...)` service override registry for output/error/help/lock/history/item-store runtime hooks.
- `registerSearchProvider(...)` selected by `settings.search.provider` for live `pm search` execution.
- `registerVectorStoreAdapter(...)` selected by `settings.vector_store.adapter` for live `pm search` query and `pm reindex` upsert execution.

See [EXTENSIONS.md](./EXTENSIONS.md) for the full API reference.

## Search Architecture

- **Keyword mode** (always available): multi-factor lexical scoring with configurable field weights
- **Semantic mode** (requires embedding + vector query capability): embedding-based vector similarity
- **Hybrid mode** (default when semantic capability is available): blended lexical + semantic ranking

Providers: OpenAI-compatible, Ollama
Vector stores: Qdrant, LanceDB

Runtime semantic defaults:

- When semantic settings are otherwise unset and local Ollama is installed, search/reindex runtime resolves built-in semantic defaults (Ollama provider + local LanceDB path) so semantic-capable behavior is available out of the box.
- Auto-default model resolution order: `PM_OLLAMA_MODEL` env override, then `ollama list` discovery (prefers embedding-like model names), then deterministic fallback `qwen3-embedding:0.6b`.
- Explicit semantic settings always win over auto-defaults (`settings.search.provider`, `settings.vector_store.adapter`, `providers.*`, `vector_store.*`).
- For implicit default-mode search, auto-default semantic execution failures degrade to keyword mode to preserve compatibility for existing users.
- Auto-defaults can be disabled with `PM_DISABLE_OLLAMA_AUTO_DEFAULTS=1`.

Health-time integrity and semantic/vector diagnostics:

- `pm health` runs a `directories` check that separates required tracker directories from optional built-in type directories and supports `--strict-directories` for stricter warning semantics plus `--strict-exit`/`--fail-on-warn` for non-zero exit gating when warnings are present.
- `pm health` runs an `integrity` check that scans item/history files for merge-conflict markers and parse/JSONL anomalies.
- `pm health` now runs a `history_drift` check that compares each current item's canonical hash to the latest history `after_hash`.
- `pm health` also runs a `vectorization` check that compares current item `updated_at` values to `search/vectorization-status.json`.
- When stale IDs are detected and semantic runtime is available, `pm health` defaults to targeted semantic refresh for stale IDs only (not a full reindex), while `--check-only`/`--no-refresh` keep diagnostics read-only and `--refresh-vectors` makes refresh intent explicit.
- `pm reindex --mode semantic|hybrid` rewrites the vectorization-status ledger for the full indexed corpus, keeping health diagnostics and index state aligned.

Extension runtime can supply equivalents for both sides of semantic execution:

- Search provider selection: `settings.search.provider` -> `registerSearchProvider(...)`.
- Vector adapter selection: `settings.vector_store.adapter` -> `registerVectorStoreAdapter(...)`.

If an extension provider/adapter fails and built-in provider/vector settings are configured, runtime falls back to built-in semantic components and records deterministic warnings.

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
| `history.missing_stream` | Missing history-stream policy: `auto_create` (default) or `strict_error` |
| `validation.sprint_release_format` | Sprint/release format policy: `warn` (default) or `strict_error` |
| `validation.parent_reference` | Parent-reference policy for create/update: `warn` (default) or `strict_error` |
| `testing.record_results_to_items` | Item-level test summary persistence toggle: `false` (default) / `true` |
| `telemetry.enabled` | Telemetry export toggle: `true` (default) / `false` |
| `telemetry.capture_level` | Runtime capture profile (`redacted` default, `max`, `minimal`) |
| `telemetry.endpoint` | Remote telemetry ingestion endpoint URL |
| `telemetry.installation_id` | Pseudonymous global installation identifier |
| `telemetry.retention_days` | Telemetry retention window (days) used for local queue pruning during flush and remote worker cleanup |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_ENDPOINT` (env) | Optional local OTLP trace export target for command spans |
| `item_types.definitions[]` | Custom type names, aliases, folders, required fields/repeatables, `--type-option` definitions, and `command_option_policies` (`required`/`enabled`/`visible`) |
| `search.*` | Search provider and tuning settings |
| `providers.openai` / `providers.ollama` | Embedding provider config |
| `vector_store.qdrant` / `vector_store.lancedb` | Vector store config |

Precedence: CLI flags > env vars (`PM_PATH`, `PM_AUTHOR`, etc.) > `settings.json` > hard defaults.

For repositories created before `item_format` existed, the first mutating item command auto-selects the current default format and runs pre-mutation item-file migration. Explicit `pm config ... item-format --format ...` selections remain supported; once selected or changed, item files are automatically migrated to the configured format, and when both `.md` and `.toon` exist for an item, the configured format is the source of truth.

History stream policy can be configured via `pm config ... history-missing-stream-policy --policy ...`. In `auto_create`, required missing streams for existing item IDs are created before history-touching command paths continue; in `strict_error`, those command paths fail fast. Restore also supports history-only recovery when an item file is missing/deleted but the stream exists.

Validation policies can be configured via:

- `pm config ... sprint-release-format-policy --policy warn|strict_error`
- `pm config ... parent-reference-policy --policy warn|strict_error`
- `pm config ... test-result-tracking --policy enabled|disabled`
- `pm config ... telemetry-tracking --policy enabled|disabled`
- `pm config ... list|export` for key discovery and one-shot resolved snapshot export

Under `warn`, create/update continue and return deterministic validation warnings; under `strict_error`, invalid values are rejected with usage errors.

## Telemetry Pipeline

Command lifecycle telemetry is integrated as an additive runtime path:

- `src/cli/main.ts`
  - initializes first-run consent behavior
  - starts telemetry capture during pre-action bootstrap
  - finalizes telemetry with command outcome in post-action and error paths
- `src/core/telemetry/consent.ts`
  - interactive first-run consent prompt
  - deterministic skip behavior for non-interactive/CI/json contexts
- `src/core/telemetry/runtime.ts`
  - sanitizes args/options/result summaries
  - emits `command_start` + `command_finish` events with additive `pm_version` and `source_context` metadata
  - spools local JSONL queue entries under global runtime storage
  - exports batched events to `settings.telemetry.endpoint` with retry/backoff
  - optionally exports command spans to OTLP (`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT`)
  - supports explicit source-context overrides via `PM_TELEMETRY_SOURCE_CONTEXT` (`user|automation|test|dogfood|audit_smoke`)

Design constraints:

- telemetry failures never block command execution
- sensitive fields are redacted before transport
- pseudonymous identifiers are used for host/path metadata
- source-context classification uses coarse categories only (no raw session/operator identifiers)

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
