# pm-cli (`pm`)

[![CI](https://github.com/unbraind/pm-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/unbraind/pm-cli/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40unbrained%2Fpm-cli)](https://www.npmjs.com/package/%40unbrained%2Fpm-cli)
[![Node >=20](https://img.shields.io/node/v/%40unbrained%2Fpm-cli)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

`pm` is a git-native project management CLI for humans and coding agents. It stores work items in reviewable repository files, records every mutation in append-only history, and defaults to sparse TOON output so agents can spend fewer tokens while still getting deterministic data.

## Start Here

| Need | Read |
|------|------|
| Install and create the first item | [Quickstart](docs/QUICKSTART.md) |
| Agent workflow and token-minimal loops | [Agent Guide](docs/AGENT_GUIDE.md) |
| Command families and examples | [Command Reference](docs/COMMANDS.md) |
| Settings, storage, search, and output | [Configuration](docs/CONFIGURATION.md) |
| Safe test execution and linked tests | [Testing](docs/TESTING.md) |
| Extension authoring | [Extensions](docs/EXTENSIONS.md) and [SDK](docs/SDK.md) |
| Pi native package | [Pi Package](docs/PI_PACKAGE.md) |
| Codex native integration | [Codex Plugin](docs/CODEX_PLUGIN.md) |
| Maintainer release process (daily auto-release + local parity) | [Releasing](docs/RELEASING.md) |
| Contributor internals | [Architecture](docs/ARCHITECTURE.md) |

Full documentation starts at [docs/README.md](docs/README.md).

Use local in-CLI routing when an agent should stay inside terminal context:

```bash
pm guide
pm guide quickstart
pm guide commands --depth standard
pm guide skills --depth deep --format markdown
```

## Install

`pm-cli` requires Node.js 20 or newer.

```bash
npm install -g @unbrained/pm-cli
pm --version
pm --help
```

Use the npm registry package for global installs and updates. Avoid `npm install -g` from the GitHub git URL for routine updates; npm can leave a stale global shim when replacing git-sourced installs. If that happens, run `bash scripts/install.sh --repair` from a checkout or `npm uninstall -g @unbrained/pm-cli && npm install -g @unbrained/pm-cli`.

Project-local invocation also works:

```bash
npx @unbrained/pm-cli --help
```

For Pi, install the native package integration after publish:

```bash
pi install npm:@unbrained/pm-cli
```

This registers a native `pm` tool, Pi skills, and prompt templates without requiring Pi to run the `pm` shell command.

## 60 Second Example

```bash
pm init

pm create \
  --title "Fix stale lock restore failure" \
  --description "Restore should retry cleanly after stale lock cleanup." \
  --type Issue \
  --status open \
  --priority 1 \
  --tags "restore,locks" \
  --ac "Restore succeeds after stale lock cleanup and has regression coverage." \
  --create-mode progressive

pm list-open --limit 10
pm claim <item-id>
pm update <item-id> --status in_progress --message "Start implementation"
pm files <item-id> --add path=src/core/lock/lock.ts,scope=project
pm test <item-id> --add command="node scripts/run-tests.mjs test -- tests/unit/lock.spec.ts",scope=project,timeout_seconds=240
pm test <item-id> --run --progress
pm close <item-id> "Fixed stale lock retry path; linked test passed."
pm release <item-id>
```

## Agent Loop

Use `pm context` first, then search before creating anything:

```bash
pm context --limit 10
pm search "keywords for the requested work" --limit 10
pm list-open --limit 20
pm list-in-progress --limit 20
```

If no relevant item exists, create a parent lineage before child work, claim the child item, link changed files/docs/tests, and leave evidence comments before closing. The full workflow is in the [Agent Guide](docs/AGENT_GUIDE.md).

For token-aware local routing, use `pm guide workflows` and then drill into related topics (`commands`, `skills`, `release`) only when needed.

## Release Automation

- Daily release preparation runs in `.github/workflows/auto-release.yml`.
- Tag-driven publishing remains in `.github/workflows/release.yml`.
- Local parity commands:
  - `pnpm release:pipeline:dry-run`
  - `pnpm release:pipeline -- --telemetry-mode required`

## Core Model

- Items live under `.agents/pm/` as TOON by default, with JSON-front-matter markdown also supported.
- History lives in `.agents/pm/history/<id>.jsonl` and is append-only.
- Statuses are `draft`, `open`, `in_progress`, `blocked`, `closed`, and `canceled`.
- Built-in types include `Epic`, `Feature`, `Task`, `Chore`, `Issue`, `Decision`, `Event`, `Reminder`, `Milestone`, and `Meeting`.
- Output defaults to sparse TOON. Use `--json` for strict parsing.
- `pm contracts` is the machine-readable command and schema contract surface for agents.
- `pm guide` is the local progressive-disclosure docs and skills index for agents.

## Tracker References

This documentation refresh is tracked through `pm`:

- [pm-3042](.agents/pm/epics/pm-3042.toon) - documentation overhaul epic
- [pm-r9gu](.agents/pm/features/pm-r9gu.toon) - documentation structure feature
- [pm-1sb2](.agents/pm/tasks/pm-1sb2.toon) - README and public docs rewrite task

Docs should link to relevant `pm` items, and `pm` items should link back to changed docs through `pm docs`.

## License

[MIT](LICENSE)
