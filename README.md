# pm-cli (`pm`)

[![CI](https://github.com/unbraind/pm-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/unbraind/pm-cli/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40unbrained%2Fpm-cli)](https://www.npmjs.com/package/%40unbrained%2Fpm-cli)
[![Node >=20](https://img.shields.io/node/v/%40unbrained%2Fpm-cli)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

`pm` is a git-native project management CLI for humans and coding agents. It stores items as TOON (`.toon`) by default with full first-class JSON-front-matter Markdown (`.md`) support, keeps append-only JSONL history, and supports safe collaboration.

## Highlights

- Git-native items that stay reviewable in diffs
- Safe multi-agent workflows with claims, locks, and restore
- Deterministic output with TOON by default and `--json` when needed
- Layered command help: compact default (`Intent` + one example) and deep explainability via `--explain`
- Machine-readable help payloads via `pm <command> --help --json` (also `pm help <command> --json`)
- Structured diagnostics with machine-readable JSON error envelopes when `--json` is active
- Dedicated machine contract surface via `pm contracts` (`--action`, `--command`, `--schema-only`)
- Sparse TOON default output that omits null/undefined/empty fields for token-efficient agent workflows
- Agent-friendly calendar views (`pm calendar` / `pm cal`) with markdown default output
- Agent-first context snapshot command (`pm context` / `pm ctx`) for critical work + agenda triage
- Reusable create templates (`pm templates save/list/show` + `pm create --template`)
- First-class dual item storage formats: TOON (`.toon`) and JSON-front-matter Markdown (`.md`)
- Compact TOON documents that are easier to review in terminal and GitHub web UI
- Automatic item format migration when `item-format` config changes
- Deterministic canonical normalization and atomic writes for parallel git/worktree workflows
- Warning-first/strict validation policies for sprint/release and parent references
- Additive history diff/verify diagnostics (`pm history --diff --verify`)
- Linked path hygiene for files/docs (`--add-glob`, `--migrate`, `--validate-paths`, `--audit`)
- Dependency topology inspection via `pm deps --format tree|graph`
- Deterministic `--tag` completion suggestions from tracked item metadata
- Additive large-list controls via `--offset` pagination and opt-in JSON streaming (`--stream` with `--json`)
- Standalone `pm validate` command for metadata, resolution, linked-file, and history-drift audits
- Opt-in non-interactive progress output for long-running operations (`pm test`, `pm test-all`, `pm reindex` with `--progress`)
- Optional search and extension support for more advanced setups

## Unified Command Contracts

`pm` now centralizes command/action contract metadata in `src/sdk/cli-contracts.ts` and uses it across:

- CLI option normalization in `src/cli/main.ts`
- Shell completion generation in `src/cli/commands/completion.ts`
- Pi wrapper tool actions, JSON Schema, and arg mapping in `.pi/extensions/pm-cli/index.ts`

Compatibility policy for command contracts:

- Existing commands/flags and aliases remain valid.
- Pi tool schema now uses strict action-scoped branches (schema v4); callers should send only action-relevant fields.
- `--json` remains the full machine payload; default TOON remains sparse/token-efficient.
- `pm contracts --json` is the canonical runtime contract introspection surface for agents.

## Item Storage Formats

- Default item format is TOON (`.toon`) using root-object field storage (`id`, `title`, ..., `body`).
- JSON front matter + markdown body (`.md`) is a fully supported alternative format.
- History files always remain JSONL (`history/<id>.jsonl`).
- Set project item storage format with:

```bash
pm config project set item-format --format toon
# or
pm config project set item-format --format json_markdown
```

Changing `item-format` automatically migrates item files to the configured format.

## Parallel Git and Worktree Robustness

- TOON and JSON/Markdown are equally supported item formats; teams can choose either format per repository.
- Canonical normalization (stable field ordering and deterministic serialization) reduces diff churn and helps keep merges predictable.
- Item writes are atomic (temp file + rename), which prevents partial writes and corruption during concurrent local operations.
- Item history remains append-only JSONL with before/after hashes, so changes are auditable and recoverable with `pm history` and `pm restore`.
- When both `.toon` and `.md` exist for one item ID, configured `item_format` is the source of truth and automatic migration removes split-format drift.
- Concurrent edits to the exact same content can still require normal git conflict resolution; the storage model is designed to avoid silent data loss and make reconciliation explicit.

## Install

`pm-cli` requires Node.js 20 or newer.

```bash
npm install -g @unbrained/pm-cli
pm --version
pm --help
```

For project-local use:

```bash
npx @unbrained/pm-cli --help
```

## Quick Start

```bash
pm init

pm create \
  --title "Fix Windows restore failure after stale lock cleanup" \
  --description "Restore can fail on Windows when a stale lock is cleaned up during retry." \
  --type Issue \
  --status open \
  --priority 1 \
  --tags "windows,locks,restore,release" \
  --body "Users can reproduce this on Windows after an interrupted restore. Add retry logging and verify restore succeeds after stale lock cleanup." \
  --deadline +3d \
  --estimate 180 \
  --acceptance-criteria "Restore succeeds after stale lock cleanup on Windows and regression coverage is added." \
  --definition-of-ready "Owner, reproduction steps, and affected files are identified." \
  --order 7 \
  --goal "Release readiness" \
  --objective "Stabilize restore under lock contention" \
  --value "Reduces failed recovery workflows during real incidents" \
  --impact "Fewer blocked releases and clearer operator recovery steps" \
  --outcome "Restore completes reliably after stale lock cleanup" \
  --why-now "The bug affects recovery flows and can block release work." \
  --author "alex-maintainer" \
  --message "Create restore failure issue with full metadata" \
  --assignee "alex-maintainer" \
  --parent "pm-release" \
  --reviewer "sam-reviewer" \
  --risk high \
  --confidence medium \
  --sprint "2026-W11" \
  --release "v2026.3" \
  --blocked-by "pm-locks" \
  --blocked-reason "Need the lock cleanup refactor merged first" \
  --unblock-note "Rebase once the lock cleanup patch lands" \
  --reporter "qa-bot" \
  --severity high \
  --environment "windows-11 node-25 npm-global-install" \
  --repro-steps "1) Interrupt restore after lock creation 2) Retry restore 3) Observe stale-lock cleanup fail on Windows" \
  --resolution "Add a retry after stale-lock cleanup and log the recovery path" \
  --expected-result "Restore retries cleanly and completes after stale-lock cleanup." \
  --actual-result "Restore exits with a lock error after cleanup on Windows." \
  --affected-version "2026.3.9" \
  --fixed-version "2026.3.10" \
  --component "core/locks" \
  --regression true \
  --customer-impact "Maintainers can be blocked from recovering work during release prep." \
  --dep "id=pm-locks,kind=blocks,author=alex-maintainer,created_at=now" \
  --comment "author=alex-maintainer,created_at=now,text=Initial triage confirms the Windows-only stale-lock recovery failure." \
  --note "author=alex-maintainer,created_at=now,text=Investigate lock cleanup timing in the restore retry path." \
  --learning "author=alex-maintainer,created_at=now,text=Windows file-handle timing needs a retry window after stale-lock cleanup." \
  --file "path=src/core/lock/lock-store.ts,scope=project,note=likely stale-lock retry fix" \
  --test "command=node scripts/run-tests.mjs test -- tests/integration/cli.integration.spec.ts,scope=project,timeout_seconds=900,note=restore lock regression coverage" \
  --doc "path=docs/ARCHITECTURE.md,scope=project,note=lock and restore design context"

pm list-open --limit 10
pm claim <item-id>
```

From there, use `pm update`, `pm comments`, `pm notes`, `pm learnings`, `pm files`, `pm docs`, `pm test`, `pm search`, and `pm close` as work progresses.

Claim behavior note:

- `pm claim <ID>` can take over non-terminal items even when currently assigned to someone else.
- Use `--force` for claim/release only when overriding terminal-state or lock conflicts.
- For ownership-conflict mutations, `--force` is intended for coordinated PM audits, lead-maintainer metadata corrections, or explicit ownership handoff cleanup.

Create policy mode note:

- `pm create` defaults to strict required-option enforcement.
- Use `--create-mode progressive` for staged governance triage when you need to defer non-critical metadata/linkage fields without placeholder `none` entries.

```bash
pm create --title "Triage seed" --description "Capture scope first, enrich later" --type Task --create-mode progressive
```

## Reusable Create Templates

Use templates to save recurring create metadata (including repeatable seeds) and apply them with explicit override precedence:

```bash
pm templates save release-issue \
  --type Issue \
  --status open \
  --priority 1 \
  --tags "release,incident" \
  --dep "id=pm-release,kind=related,created_at=now" \
  --file "path=src/cli/main.ts,scope=project"

pm templates list
pm templates show release-issue --json

# Explicit flags override template defaults deterministically.
pm create \
  --title "Follow-up issue" \
  --description "Investigate release incident follow-up." \
  --type Issue \
  --template release-issue \
  --status blocked
```

## Semantic Search Defaults (Ollama)

`pm search` now auto-enables semantic-capable defaults on hosts where local Ollama is installed, without requiring manual semantic provider/vector configuration in `settings.json`.

- Auto-defaults only apply when semantic settings are otherwise unset (no explicit `settings.search.provider`, `settings.vector_store.adapter`, `providers.*`, or `vector_store.*` semantic config).
- Resolved defaults are:
  - embedding provider: Ollama (`http://localhost:11434`)
  - embedding model: `PM_OLLAMA_MODEL` (if set), otherwise first model from `ollama list` (preferring names containing `embed`/`embedding`), otherwise `qwen3-embedding:0.6b`
  - vector store: local LanceDB path `.agents/pm/search/lancedb/`
- Explicit user/project configuration always takes precedence over auto-defaults.
- If implicit auto-defaulted semantic execution fails at runtime, `pm search` falls back to keyword mode to avoid breaking existing users.
- Disable this behavior with `PM_DISABLE_OLLAMA_AUTO_DEFAULTS=1`.

To (re)build semantic artifacts explicitly:

```bash
pm reindex --mode hybrid
```

## Health Drift, Integrity, and Vectorization Checks

`pm health` includes deterministic checks for item/history integrity and semantic vector freshness:

- `integrity`
  - scans item and history files for merge-conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`)
  - reports invalid item parses and invalid JSONL lines in history streams with deterministic warning codes
- `history_drift`
  - scans current items and compares each canonical item hash against the latest history `after_hash`
  - reports missing history streams, unreadable/corrupt history streams, and hash mismatches
- `vectorization`
  - compares current item `updated_at` values against a local vectorization ledger at `search/vectorization-status.json`
  - identifies stale/missing vector entries and performs targeted semantic refresh for stale item IDs when semantic runtime is available
  - avoids forcing a full rebuild (`pm reindex`) for routine health checks

The vectorization ledger is also refreshed during `pm reindex --mode semantic|hybrid` to keep health diagnostics aligned with the latest indexed corpus.

## Standalone Validation Checks

`pm validate` provides a dedicated audit surface for project metadata quality and integrity checks:

- Runs all validation checks by default (`metadata`, `resolution`, `files`, `history_drift`).
- Runs linked-command PM reference checks by default (`command_references`) to catch stale `pm-<id>` references before execution-time failures.
- Supports scoped checks with `--check-metadata`, `--check-resolution`, `--check-files`, `--check-command-references`, and `--check-history-drift`.
- `--check-files` supports `--scan-mode default|tracked-all`; `tracked-all` uses git-tracked candidates when available.
- `tracked-all` excludes PM internals by default for higher-signal orphaned results; pass `--include-pm-internals` for full internal-audit scans.
- File-check details report filtered candidate counts (`candidate_total`, `candidate_scanned`) plus raw pre-filter counts (`candidate_total_raw`, `candidate_scanned_raw`) and `pm_internal_excluded_count`.
- Command-reference details report referenced PM IDs and stale-reference rows; stale rows emit `validate_command_references_stale_pm_ids:<count>` warnings.
- Returns deterministic TOON/JSON output suitable for review or automation pipelines.
- Output writers treat broken pipes (`EPIPE`) as expected shell behavior, so early-terminating pipelines do not emit unhandled Node stack traces.

## Missing History Stream Policy

`settings.history.missing_stream` controls behavior when an item's `history/<id>.jsonl` stream is missing:

- `auto_create` (default)
  - missing streams for existing items are created automatically before history-touching command paths continue
- `strict_error`
  - history-touching command paths fail with a deterministic error instead of creating missing streams

Configure policy with:

```bash
pm config project set history-missing-stream-policy --policy auto_create
pm config project set history-missing-stream-policy --policy strict_error
pm config project get history-missing-stream-policy --json
```

Policy enforcement applies to `pm history`, `pm activity`, `pm stats`, `pm health`, restore, and existing-item mutation paths.

## Sprint/Release Format Policy

`settings.validation.sprint_release_format` controls `--sprint` and `--release` validation behavior during `pm create` and `pm update`:

- `warn` (default)
  - accepts non-conforming values and emits deterministic warnings (`validation_warning:sprint_format:<value>` / `validation_warning:release_format:<value>`)
- `strict_error`
  - rejects non-conforming values with a deterministic usage error

Accepted format for conforming values: 1-64 characters matching `[A-Za-z0-9][A-Za-z0-9._/-]*` (no spaces).

Configure policy with:

```bash
pm config project set sprint-release-format-policy --policy warn
pm config project set sprint-release-format-policy --policy strict_error
pm config project get sprint-release-format-policy --json
```

## Parent Reference Validation Policy

`settings.validation.parent_reference` controls how `--parent` behaves during `pm create` and `pm update` when the referenced parent item does not exist:

- `warn` (default)
  - keeps backward-compatible behavior and emits `validation_warning:parent_reference_missing:<id>`
- `strict_error`
  - rejects missing parent references with a deterministic usage error

Configure policy with:

```bash
pm config project set parent-reference-policy --policy warn
pm config project set parent-reference-policy --policy strict_error
pm config project get parent-reference-policy --json
```

## History Diff and Verify

`pm history` now supports additive diagnostics:

```bash
# Include changed-field summaries derived from RFC6902 patches
pm history pm-a1b2 --diff

# Verify before/after hash replay chain and current item hash alignment
pm history pm-a1b2 --verify --json
```

`pm restore` also supports history-only recovery when an item file is missing or deleted but its history stream still exists.

## Deadline and Date Inputs

- Date/time inputs used by `--deadline`, `--deadline-before`, `--deadline-after`, calendar `--date/--from/--to`, reminders, and events accept:
  - ISO timestamps
  - Flexible date strings (for example `2026-03-31T13-59`, `20260331`, `20260331T135900Z`)
  - Relative offsets (`+6h`, `+1d`, `+2w`, `+6m`)
- Accepted values are normalized to canonical ISO timestamps for deterministic storage and filtering.

## Status Values

- Canonical status values are: `draft`, `open`, `in_progress`, `blocked`, `closed`, `canceled`.
- Status input flags also accept `in-progress` as an alias for `in_progress` (`pm create`, `pm update`, `pm calendar`, and `pm test-all`).
- Persisted item data and command output remain canonical (`in_progress`) for deterministic storage and filtering.
- `pm update --close-reason <text>` sets `close_reason` explicitly; `--close-reason none` clears it.
- When `pm update --status` reopens an item from `closed` to a non-terminal status, stale `close_reason` is auto-cleared unless `--close-reason` is explicitly provided in that update call.

## Resilient Entry Input Formats

Entry-style flags (`--add`, `--remove`, and repeatable create/update seed flags like `--comment`, `--file`, `--test`, `--doc`, `--reminder`, `--event`, `--type-option`) now accept three deterministic forms:

- CSV key/value: `key=value,key2=value2`
- Markdown-style key/value: `key: value` (single line, bullets, or multiline blocks)
- Stdin token: pass `-` and pipe payload into the command

Examples:

```bash
# Files/docs/tests add supports markdown-style key:value
pm files pm-a1b2 --add "path: src/cli/main.ts,scope: project,note: cli wiring"
pm docs pm-a1b2 --add $'- path: README.md\n- scope: project\n- note: docs sync'
pm test pm-a1b2 --add $'command: node scripts/run-tests.mjs test\nscope: project\ntimeout_seconds: 240'

# Linked-path hygiene for files/docs (bulk migrate + optional validation/audit)
pm files pm-a1b2 --add-glob "src/**/*.ts"
pm docs pm-a1b2 --add-glob "pattern=docs/**/*.md,scope=project,note=docs sweep"
pm files pm-a1b2 --migrate "from=src/old/,to=src/new/" --validate-paths --audit
pm docs pm-a1b2 --migrate "from=docs/legacy/,to=docs/current/" --validate-paths --audit
pm files pm-a1b2 --add "path=src/new/entry.ts,scope=project" --append-stable

# Comments can be added positionally or with --add
pm comments pm-a1b2 "captured from shorthand positional text"
pm comments pm-a1b2 --add "text: captured from markdown formatter"
pm comments pm-a1b2 --add "handoff note from alternate author" --author "alex-maintainer" --force
pm comments pm-a1b2 --add "audit note from governance review" --author "audit-maintainer" --allow-audit-comment

# Notes and learnings support the same positional/--add shorthand
pm notes pm-a1b2 "implementation context captured from shorthand positional text"
pm notes pm-a1b2 --add "text: parser fallback rationale"
pm learnings pm-a1b2 --add "text: always run linked tests through the sandbox runner"

# Pipe markdown payload via stdin with "-"
printf '%s\n' 'path: docs/ARCHITECTURE.md' 'scope: project' 'note: piped update' | pm files pm-a1b2 --add -
printf '%s\n' 'text: evidence from piped stdin' | pm comments pm-a1b2 --add -
printf '%s\n' 'text: implementation note from piped stdin' | pm notes pm-a1b2 --add -
printf '%s\n' 'text: learning captured from piped stdin' | pm learnings pm-a1b2 --add -
printf '%s\n' 'at: +1d' 'text: reminder from piped stdin' | pm update pm-a1b2 --reminder -
printf '%s\n' 'Backfilled body from stdin token' | pm update pm-a1b2 --body -
pm update pm-a1b2 --dep "id=pm-b3c4,kind=blocks,author=alex-maintainer,created_at=now"
pm update pm-a1b2 --dep-remove "pm-b3c4"
pm update pm-a1b2 --dep none
pm deps pm-a1b2 --format tree
pm deps pm-a1b2 --format graph --json
```

`none` semantics are unchanged for explicit clears in repeatable fields (`--file none`, `--comment none`, etc.).

For `pm create` log-seed flags (`--comment`, `--note`, `--learning`), only `author`, `created_at`, and `text` keys are accepted. Ambiguous unquoted payloads that introduce extra parsed keys (for example `text=hello,scope:project`) are rejected to prevent silent text truncation. Use quoted text (`text="hello,scope:project"`), markdown-style key/value input, or stdin token `-` for punctuation-heavy text.

## Linked Artifact and Test Policy

- Use dedicated linked-artifact commands for file/doc mutations:
  - `pm files <ID> --add/--add-glob/--remove`
  - `pm docs <ID> --add/--add-glob/--remove`
- Use `pm update <ID> --body <value>` to replace an item's body content (including empty-string backfills); use `pm append <ID> --body <value>` for additive narrative updates.
- Dependency links on existing items are now mutated through `pm update` (`--dep` to add entries or clear with `none`, `--dep-remove`/`--dep_remove` to remove selectors).
- Use `pm deps <ID> --format tree|graph` for deterministic read-only dependency visualization.
- `pm update` intentionally does not accept `--file` or `--doc`; command guidance points to `pm files` / `pm docs`.
- `pm test <ID> --add` intentionally enforces sandbox-safe, runnable command entries. Every new linked test must include `command=...`; optional `path=...` is metadata-only context.
- `pm create --test` follows the same policy: `command=...` is required, optional `path=...` can annotate command scope.
- Linked test entries also support optional per-entry runtime directives: `env_set=KEY=VALUE;KEY2=VALUE2`, `env_clear=KEY1;KEY2`, and `shared_host_safe=true|false`.
- `pm test <ID> --run` / `pm test-all` execute in temporary sandbox roots but seed project/global `settings.json` and `extensions/` directories from source roots so extension-defined type behavior matches direct workspace commands.
- `pm test <ID> --run` / `pm test-all` support additive run-level runtime controls: repeatable `--env-set KEY=VALUE`, repeatable `--env-clear NAME`, and `--shared-host-safe` (ephemeral/shared-host-friendly defaults such as `PORT=0` when unset).
- `pm test <ID> --run` and `pm test-all` emit heartbeat/progress lines to stderr in interactive terminals during long-running linked commands, and support explicit non-interactive progress output via `--progress`.
- Linked test timeout handling uses deterministic process termination (including force-kill fallback) and reports explicit timeout/maxBuffer diagnostics in `run_results`.
- Failed linked test `run_results` now include `failure_category` (for example `infra_collision` vs `assertion_failure`) and `pm test-all` totals include aggregated `failure_categories` counts for triage.
- `pm list` / `pm list-*` return front-matter rows by default; pass `--include-body` when body projection is needed, `--offset <n>` for pagination, and `--stream` (with `--json`) for newline-delimited item streaming.

## Terminal Compatibility

`pm` is intentionally terminal-neutral so it works in native shells, IDE-integrated terminals, and emulated PTY backends:

- Output is plain deterministic TOON/JSON/markdown text (no required terminal-specific OSC/ANSI control protocol).
- Error exits preserve deterministic exit-code mapping while using graceful `process.exitCode` behavior.
- Stdin token entry (`-`) requires piped stdin when invoked from an interactive TTY.
- `pm beads import --file -` follows the same stdin guard: if stdin is interactive TTY, `pm` returns usage guidance instead of waiting for EOF.
- Linked test execution uses shell-compatible spawn orchestration instead of buffered one-shot capture, reducing silent long-run behavior in IDE-integrated terminals.
- During interactive runs, linked tests print periodic stderr heartbeat lines (`[pm test] linked-test ... running`) until completion.
- Timeout paths attempt graceful termination first, then deterministic force-kill fallback for stubborn subprocess trees.
- For manual EOF in interactive sessions:
  - Unix/macOS terminals: `Ctrl+D`
  - Windows terminals: `Ctrl+Z` then `Enter`

Example piped Beads import:

```bash
cat issues.jsonl | pm beads import --file -
```

## Custom Item Types and Type Options

`pm` supports project/global custom item types through `settings.json` and extension registrations. When no custom configuration exists, built-in types keep their default behavior.

### Configure custom types in `settings.json`

```json
{
  "item_types": {
    "definitions": [
      {
        "name": "Asset",
        "folder": "assets",
        "aliases": ["assets", "3d-asset"],
        "required_create_fields": ["title", "description", "status", "priority", "message"],
        "required_create_repeatables": [],
        "command_option_policies": [
          { "command": "create", "option": "severity", "enabled": false },
          { "command": "create", "option": "reporter", "enabled": false },
          { "command": "create", "option": "goal", "visible": false },
          { "command": "update", "option": "message", "required": true }
        ],
        "options": [
          {
            "key": "category",
            "values": ["Map", "Character", "Prop", "VFX"],
            "required": true,
            "aliases": ["asset_category"],
            "description": "High-level asset classification"
          },
          {
            "key": "pipeline",
            "values": ["Blockout", "Modeling", "Rigging", "Texturing", "Done"]
          }
        ]
      }
    ]
  }
}
```

### Use custom types on create/update

```bash
pm create \
  --title "Forest world map" \
  --description "Primary world navigation mesh and terrain art" \
  --type Asset \
  --status open \
  --priority 1 \
  --message "Track world map asset" \
  --type-option category=Map \
  --type-option pipeline=Modeling

pm update pm-a1b2 --type-option category=Character --type-option pipeline=Rigging
```

`--type-option` accepts `key=value`, `key:value`, and `key=<name>,value=<value>` formats (including markdown-style lines), can read stdin via `-`, and can be cleared with `none`.

`command_option_policies` lets each type mark create/update options as:

- `required: true|false` (mandatory or optional)
- `enabled: true|false` (accepted or rejected at runtime)
- `visible: true|false` (shown or hidden in policy-aware help guidance)

### Improved required `--type` guidance

When `--type` is missing, usage output now includes:

- why `--type` is required
- allowed values from the active runtime type registry
- concrete `pm create` examples (including custom-type usage)
- deterministic aggregation when multiple required options are missing for the selected type (single response, stable flag ordering)

For `pm create --help` and `pm update --help`, add `--type <value>` to render type-aware policy details (required/disabled/hidden option lists) and type-option schema details (required marker, allowed values, aliases, description) from active settings/extensions.

## Help and Error Guidance

`pm` now treats command guidance as a first-class UX surface:

- Default help is compact and token-efficient (`Intent` + one high-signal example).
- Add `--explain` to any `--help` invocation to render deeper rationale, multiple examples, and tips.
- `pm help` and `pm help <command>` are success paths (exit code `0`) with no trailing usage envelope.
- `pm <command> --help --json` and `pm help <command> --json` emit deterministic machine-readable help payloads.
- Usage/runtime errors use one canonical guidance model:
  - text mode: structured sections (`What happened`, `What is required`, `Why`, `Examples`, optional `Next steps`)
  - `--json` mode: machine-readable envelope (`type`, `code`, `title`, `detail`, `required`, `exit_code`, optional `why/examples/next_steps`)

Text-mode example:

```text
Error: Missing required option --type <value>

What happened:
  Commander rejected the command because --type <value> was not provided.

What is required:
  Pass --type <value> with a valid value before running the command.
```

JSON-mode example (`--json`):

```json
{
  "type": "urn:pm-cli:error:missing_required_option",
  "code": "missing_required_option",
  "title": "Missing required option --type <value>",
  "detail": "Commander rejected the command because --type <value> was not provided.",
  "required": "Pass --type <value> with a valid value before running the command.",
  "exit_code": 2
}
```

## Sparse TOON Default Output

For default TOON output, command results are rendered directly from the command payload with recursive compaction:

- omit `null` and `undefined`
- omit empty arrays and empty objects
- preserve meaningful falsy values (`0`, `false`, non-empty strings)

JSON output remains contract-stable and continues to expose the full payload through `--json`.

## SDK and Full Override Extensions

`pm` now ships a stable SDK entrypoint at `@unbrained/pm-cli/sdk` for extension authors.

```ts
import { defineExtension, type ExtensionApi } from "@unbrained/pm-cli/sdk";

export default defineExtension({
  activate(api: ExtensionApi) {
    api.registerCommand({
      name: "list-open",
      run: async (context) => ({ overridden: true, command: context.command }),
    });
  },
});
```

Extension runtime behavior is extension-first by default:

- Extension command handlers can replace core command execution at dispatch time.
- Parser overrides (`registerParser`) can rewrite command args/options/global context before dispatch.
- Preflight overrides (`registerPreflight`) can intercept mutation gate decisions and migration flow.
- Service overrides (`registerService`) can replace output/error/help rendering and selected internal runtime services.
- Command-result overrides and renderer overrides still run with deterministic precedence (last registration wins).
- `beforeCommand` and `afterCommand` hooks receive command args/options/global snapshots and final command result/error state.
- `registerItemFields(...)` definitions now participate in create/update defaulting and validation.
- `registerSearchProvider(...)` + `settings.search.provider` and `registerVectorStoreAdapter(...)` + `settings.vector_store.adapter` are now live runtime selectors for `pm search` / `pm reindex`.

Use `--no-extensions` to force core-only behavior for a single invocation.

## Extension Lifecycle Manager (`pm extension`)

Use `pm extension` to install, inspect, activate, deactivate, and remove custom extensions in project or global scope.

Lifecycle actions (exactly one per call):

- `--install`
- `--uninstall`
- `--explore`
- `--manage`
- `--activate`
- `--deactivate`

Scope selectors:

- `--project` (default)
- `--local` (alias of `--project`)
- `--global`

Install source selectors:

- local extension directory path (for example `.agents/pm/extensions/my-ext`)
- GitHub URL (for example `https://github.com/owner/repo/tree/main/path/to/ext`)
- GitHub shorthand URL form (for example `github.com/owner/repo/path`)
- explicit GitHub shorthand flag form `--gh owner/repo/path` (alias: `--github`)
- optional Git ref override with `--ref <branch|tag|sha>`

Requested source equivalence examples:

```bash
# Multiple extensions in one repo (default extension roots)
pm extension --install --project https://github.com/unbraind/pm-cli/tree/main/.agents/pm/extensions/pi
pm extension --install --project github.com/unbraind/pm-cli/pi
pm extension --install --project --gh unbraind/pm-cli/pi

# Custom extension roots in repo
pm extension --install --project https://github.com/unbraind/pm-cli/tree/main/.custom/pm-extensions/pi
pm extension --install --project github.com/unbraind/pm-cli/.custom/pm-extension/pi
pm extension --install --project --gh unbraind/pm-cli/pi

# Single-extension repo or extension at repository root
pm extension --install --project https://github.com/unbraind/pm-cli
pm extension --install --project github.com/unbraind/pm-cli
pm extension --install --project --gh unbraind/pm-cli

# Local extension directory
pm extension --install --project .agents/pm/extensions/pi
```

Activation and health behavior:

- Install auto-activates the extension in selected scope settings.
- Deactivate/activate toggle `extensions.disabled[]`/`extensions.enabled[]` in settings.
- `pm extension --explore` lists discovered extensions and active status.
- `pm extension --manage` refreshes GitHub-managed update metadata, persists it to scope-local `.managed-extensions.json`, and includes a concise triage summary with remediation hints.
- `pm health` includes managed extension state diagnostics plus a condensed extension triage block for quick load/activation/migration issue triage across project and global roots.

Use `pm extension --help` for compact guidance or `pm extension --help --explain` for expanded examples/tips.

## Calendar, Reminders, and Events

`pm` supports persistent reminder metadata, one-off and recurring scheduled events, and a dedicated calendar surface for deadline/reminder/event planning.

### Reminder fields on items

- `pm create` and `pm update` accept repeatable `--reminder` flags.
- Reminder value format: `at=<iso|date|relative>,text=<text>`.
- Use `none` to explicitly clear reminders in create/update flows.

Examples:

```bash
pm create \
  --title "Prepare release notes" \
  --description "Draft and review release notes for vnext." \
  --type Task \
  --status open \
  --priority 1 \
  --tags "release,docs" \
  --body "" \
  --deadline +2d \
  --reminder "at=+1d,text=Start first draft" \
  --reminder "at=+36h,text=Send review draft" \
  --estimate 45 \
  --acceptance-criteria "Release notes merged and linked." \
  --author "maintainer-agent" \
  --message "Create release notes task with reminders" \
  --assignee none \
  --dep none --comment none --note none --learning none --file none --test none --doc none

pm update pm-a1b2 --reminder "at=+4h,text=Follow up with reviewer"
pm update pm-a1b2 --reminder none
```

### Event fields on items

- `pm create` and `pm update` accept repeatable `--event` flags.
- Event value format supports:
  - `start=<iso|date|relative>` (required)
  - `end=<iso|date|relative>` (optional, must be after `start`)
  - `title=<text>`, `description=<text>`, `location=<text>`, `timezone=<iana-or-label>`, `all_day=<true|false|1|0|yes|no>`
- Recurrence metadata (optional, RFC-lite):
  - `recur_freq=<daily|weekly|monthly|yearly>`
  - `recur_interval=<int>=1+`
  - `recur_count=<int>=1+`
  - `recur_until=<iso|date|relative>`
  - `recur_by_weekday=<mon|tue|wed|thu|fri|sat|sun>` (pipe-delimited)
  - `recur_by_month_day=<1..31>` (pipe-delimited)
  - `recur_exdates=<iso|date|relative>` (pipe-delimited)
- Use `none` to explicitly clear all events in create/update flows.

Examples:

```bash
pm create \
  --title "Run release planning" \
  --description "Set recurring planning sync plus a one-off launch checkpoint." \
  --type Task \
  --status open \
  --priority 1 \
  --tags "release,calendar" \
  --body "" \
  --deadline +7d \
  --event "start=2026-04-03T15:00:00.000Z,title=Launch checkpoint,location=War room" \
  --event "start=2026-04-01T09:00:00.000Z,title=Weekly planning,recur_freq=weekly,recur_by_weekday=wed,recur_interval=1" \
  --estimate 30 \
  --acceptance-criteria "Calendar schedule is captured in item metadata." \
  --author "maintainer-agent" \
  --message "Create calendar-rich planning task" \
  --assignee none \
  --dep none --comment none --note none --learning none --file none --test none --doc none

pm update pm-a1b2 --event "start=+2d,title=Retro,recur_freq=monthly,recur_by_month_day=15"
pm update pm-a1b2 --event none
```

### Calendar command (`pm calendar` / `pm cal`)

- Views: `agenda` (default), `day`, `week`, `month`
- Default output for calendar is markdown (command-specific override)
- Explicit output override: `--format markdown|toon|json` or global `--json`
- Event source controls:
  - `--include deadlines|reminders|events|all` (comma or pipe-delimited when passing multiple values)
  - default source set is `all`
- Recurrence expansion controls:
  - `--recurrence-lookahead-days <n>`
  - `--recurrence-lookback-days <n>`
  - `--occurrence-limit <n>` (per recurring event; `>= 1`)
- Past toggles and range controls:
  - `--past` includes past events in bounded views
  - `--from` / `--to` supported on `agenda`
  - `--date` anchors day/week/month calculations
- Shared filters: `--type`, `--tag`, `--priority`, `--status`, `--assignee`, `--sprint`, `--release`, `--limit`

Examples:

```bash
pm calendar
pm cal --view week --date +2d --past
pm calendar --view agenda --from 2026-04-01T00:00:00.000Z --to 2026-04-08T00:00:00.000Z --assignee alex
pm calendar --view agenda --include events --recurrence-lookahead-days 30 --occurrence-limit 50
pm calendar --view month --tag release --format json
```

## Context Snapshot (`pm context` / `pm ctx`)

`pm context` provides a token-efficient project-state snapshot optimized for quickly deciding the next work item.

- Default output is TOON (sparse and agent-friendly), with explicit `--format markdown|toon|json` and global `--json`.
- Focus sections prioritize active work (`in_progress`, then `open`) using deterministic ranking:
  - status
  - priority (`0..4`, lower is higher priority)
  - explicit `order` (when present)
  - deadline proximity
  - recency/id tie-breakers
- Output is split into:
  - high-level focus (`Epic`, `Feature`)
  - low-level focus (`Task`, `Issue`, `Chore`, etc.)
- Agenda context is included from deadlines, reminders, and scheduled events in an agenda window.
- If there are no open or in-progress items, `pm context` automatically includes a blocked-work fallback section.
- Shared filters: `--type`, `--tag`, `--priority`, `--assignee`, `--sprint`, `--release`, `--limit`.
- Agenda window controls: `--date`, `--from`, `--to`, `--past`.

Examples:

```bash
pm context
pm ctx --limit 5
pm context --assignee alex --priority 1 --limit 10
pm context --from +0d --to +7d --format markdown
pm context --date 2026-04-01T00:00:00.000Z --past --json
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Extensions](docs/EXTENSIONS.md)
- [Contributing](CONTRIBUTING.md)
- [Security Policy](SECURITY.md)
- [Changelog](CHANGELOG.md)

## License

MIT. See [LICENSE](LICENSE).
