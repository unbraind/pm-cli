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
- Rich command help guidance with command purpose, practical examples, and usage tips
- Structured error diagnostics that explain what happened, what is required, why it matters, and concrete fix examples
- Command-aware default output envelopes (`summary`, `highlights`, `next_steps`, `result`) for faster follow-up actions
- Agent-friendly calendar views (`pm calendar` / `pm cal`) with markdown default output
- First-class dual item storage formats: TOON (`.toon`) and JSON-front-matter Markdown (`.md`)
- Compact TOON documents that are easier to review in terminal and GitHub web UI
- Automatic item format migration when `item-format` config changes
- Deterministic canonical normalization and atomic writes for parallel git/worktree workflows
- Optional search and extension support for more advanced setups

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

From there, use `pm update`, `pm comments`, `pm files`, `pm test`, `pm search`, and `pm close` as work progresses.

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

# Comments can be added positionally or with --add
pm comments pm-a1b2 "captured from shorthand positional text"
pm comments pm-a1b2 --add "text: captured from markdown formatter"

# Pipe markdown payload via stdin with "-"
printf '%s\n' 'path: docs/ARCHITECTURE.md' 'scope: project' 'note: piped update' | pm files pm-a1b2 --add -
printf '%s\n' 'text: evidence from piped stdin' | pm comments pm-a1b2 --add -
printf '%s\n' 'at: +1d' 'text: reminder from piped stdin' | pm update pm-a1b2 --reminder -
```

`none` semantics are unchanged for explicit clears in repeatable fields (`--file none`, `--comment none`, etc.).

## Terminal Compatibility

`pm` is intentionally terminal-neutral so it works in native shells, IDE-integrated terminals, and emulated PTY backends:

- Output is plain deterministic TOON/JSON/markdown text (no required terminal-specific OSC/ANSI control protocol).
- Error exits preserve deterministic exit-code mapping while using graceful `process.exitCode` behavior.
- Stdin token entry (`-`) requires piped stdin when invoked from an interactive TTY.
- `pm beads import --file -` follows the same stdin guard: if stdin is interactive TTY, `pm` returns usage guidance instead of waiting for EOF.
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

For `pm create --help` and `pm update --help`, add `--type <value>` to render type-aware policy details (required/disabled/hidden option lists) from active settings/extensions.

## Help and Error Guidance

`pm` now treats command guidance as a first-class UX surface:

- Command help includes a deterministic "Why use this command" section.
- Command help includes practical copy/paste examples and targeted tips.
- Usage/runtime errors are rendered with structured sections:
  - `What happened`
  - `What is required`
  - `Why`
  - `Examples`
  - optional `Next steps`

Example:

```text
Error: Missing required option --type <value>

What happened:
  Commander rejected the command because --type <value> was not provided.

What is required:
  Pass --type <value> with a valid value before running the command.
```

## Command-Aware Default Output

For non-JSON output, command results are wrapped in a consistent envelope:

- `summary`: high-level command outcome
- `highlights`: key facts from the result
- `next_steps`: suggested follow-up commands
- `result`: raw command payload

This keeps default terminal output easier to act on while preserving strict machine-oriented payload compatibility through `--json`.

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
- Command-result overrides and renderer overrides still run with deterministic precedence (last registration wins).
- `beforeCommand` and `afterCommand` hooks receive command args/options/global snapshots and final command result/error state.
- `registerItemFields(...)` definitions now participate in create/update defaulting and validation.
- `registerSearchProvider(...)` + `settings.search.provider` and `registerVectorStoreAdapter(...)` + `settings.vector_store.adapter` are now live runtime selectors for `pm search` / `pm reindex`.

Use `--no-extensions` to force core-only behavior for a single invocation.

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

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Extensions](docs/EXTENSIONS.md)
- [Contributing](CONTRIBUTING.md)
- [Security Policy](SECURITY.md)
- [Changelog](CHANGELOG.md)

## License

MIT. See [LICENSE](LICENSE).
