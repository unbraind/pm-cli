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

`--type-option` accepts `key=value` and `key=<name>,value=<value>` formats, and can be cleared with `none`.

### Improved required `--type` guidance

When `--type` is missing, usage output now includes:

- why `--type` is required
- allowed values from the active runtime type registry
- concrete `pm create` examples (including custom-type usage)

## Calendar, Reminders, and Events

`pm` supports persistent reminder metadata, one-off and recurring scheduled events, and a dedicated calendar surface for deadline/reminder/event planning.

### Reminder fields on items

- `pm create` and `pm update` accept repeatable `--reminder` flags.
- Reminder value format: `at=<iso|relative>,text=<text>`.
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
  - `start=<iso|relative>` (required)
  - `end=<iso|relative>` (optional, must be after `start`)
  - `title=<text>`, `description=<text>`, `location=<text>`, `timezone=<iana-or-label>`, `all_day=<true|false|1|0|yes|no>`
- Recurrence metadata (optional, RFC-lite):
  - `recur_freq=<daily|weekly|monthly|yearly>`
  - `recur_interval=<int>=1+`
  - `recur_count=<int>=1+`
  - `recur_until=<iso|relative>`
  - `recur_by_weekday=<mon|tue|wed|thu|fri|sat|sun>` (pipe-delimited)
  - `recur_by_month_day=<1..31>` (pipe-delimited)
  - `recur_exdates=<iso|relative>` (pipe-delimited)
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
