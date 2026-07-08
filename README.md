# pm-cli (`pm`)

[![CI](https://github.com/unbraind/pm-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/unbraind/pm-cli/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/unbraind/pm-cli/branch/main/graph/badge.svg)](https://codecov.io/gh/unbraind/pm-cli)
[![CodeFactor](https://www.codefactor.io/repository/github/unbraind/pm-cli/badge)](https://www.codefactor.io/repository/github/unbraind/pm-cli)
[![npm version](https://img.shields.io/npm/v/%40unbrained%2Fpm-cli)](https://www.npmjs.com/package/%40unbrained%2Fpm-cli)
[![Node >=22.18](https://img.shields.io/node/v/%40unbrained%2Fpm-cli)](https://nodejs.org)
![NPM Downloads](https://img.shields.io/npm/d18m/%40unbrained%2Fpm-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[![pm total](https://pm-cli.unbrained.dev/badges/svg?repo=unbraind/pm-cli&metric=items&style=flat&rt=2)](https://pm-cli.unbrained.dev/badges)
[![pm open](https://pm-cli.unbrained.dev/badges/svg?repo=unbraind/pm-cli&metric=status&status=open&style=flat&rt=2)](https://pm-cli.unbrained.dev/badges)
[![pm in progress](https://pm-cli.unbrained.dev/badges/svg?repo=unbraind/pm-cli&metric=status&status=in_progress&style=flat&rt=2)](https://pm-cli.unbrained.dev/badges)
[![pm closed](https://pm-cli.unbrained.dev/badges/svg?repo=unbraind/pm-cli&metric=closed&style=flat&rt=2)](https://pm-cli.unbrained.dev/badges)
[![pm completion](https://pm-cli.unbrained.dev/badges/svg?repo=unbraind/pm-cli&metric=completion&style=flat&rt=2)](https://pm-cli.unbrained.dev/badges)

`pm` is a git-native project management CLI for humans and coding agents. It stores work items in reviewable repository files, records every mutation in append-only history, and defaults to sparse TOON output so agents can spend fewer tokens while still getting deterministic data.

## Start Here

| Need | Read |
|------|------|
| Install and create the first item | [Quickstart](docs/QUICKSTART.md) |
| New maintainer onboarding | [Onboarding](docs/ONBOARDING.md) |
| Agent workflow and token-minimal loops | [Agent Guide](docs/AGENT_GUIDE.md) |
| Command families and examples | [Command Reference](docs/COMMANDS.md) |
| Settings, storage, search, and output | [Configuration](docs/CONFIGURATION.md) |
| Safe test execution and linked tests | [Testing](docs/TESTING.md) |
| Package and extension authoring | [Packages and Extensions](docs/EXTENSIONS.md) and [SDK](docs/SDK.md) |
| Codex native integration | [Codex Plugin](docs/CODEX_PLUGIN.md) |
| Claude Code native integration | [Claude Code Plugin](docs/CLAUDE_CODE_PLUGIN.md) |
| Maintainer release process (daily auto-release + local parity) | [Releasing](docs/RELEASING.md) |
| Contributor internals | [Architecture](docs/ARCHITECTURE.md) |

Full documentation starts at [docs/README.md](docs/README.md).

For optional in-terminal docs routing, use the canonical [guide topic map](docs/README.md#guide-topic-map).

## Install

`pm-cli` requires Node.js 22.18 or newer (extensions and packages are authored and loaded as TypeScript via Node's native type stripping, so no compiled `.js` is shipped or committed).

```bash
npm install -g @unbrained/pm-cli
pm --version
pm --help
```

Use the npm registry package for global installs and updates. Avoid `npm install -g` from the GitHub git URL for routine updates; npm can leave a stale global shim when replacing git-sourced installs. If that happens, run `bash scripts/install.sh --repair` from a checkout or `npm uninstall -g @unbrained/pm-cli && npm install -g @unbrained/pm-cli`.

Project-local invocation also works:

```bash
npx --yes @unbrained/pm-cli@latest --help
```

For Claude Code, install the native plugin (no `pm` CLI required):

```
/plugin install pm-claude@pm
```

This registers 28 MCP tools, 5 workflow skills, 14 slash commands, 4 subagents, hybrid TUI tracking, and a session-start context hook — all without shelling out to the `pm` CLI.

`pm` packages use the same package-first vocabulary:

```bash
pm install '*'
pm install ./my-package
pm package manage --project
pm package doctor --detail summary
pm upgrade --dry-run
```

The legacy `pm extension ...` command remains available for existing automation.

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
pm files <item-id> --add path=src/core/lock/lock.ts
pm test <item-id> --add command="node scripts/run-tests.mjs test -- tests/unit/lock.spec.ts",timeout_seconds=240
pm test <item-id> --run --progress
pm close <item-id> "Fixed stale lock retry path; linked test passed."
pm release <item-id>
```

## Agent Loop

Use `pm next` to get the single highest-priority ready item (and why), or `pm context` for the full snapshot, then search before creating anything:

```bash
pm next                                          # the next actionable item + rationale, ready/blocked queues
pm context --limit 10
pm search "keywords for the requested work" --limit 10
pm list-open --limit 20
pm list-in-progress --limit 20
```

If no relevant item exists, create a parent lineage before child work, claim the child item, link changed files/docs/tests, and leave evidence comments before closing. The full workflow is in the [Agent Guide](docs/AGENT_GUIDE.md).

For token-aware local routing, install `guide-shell` with `pm install guide-shell --project`, then use `pm guide workflows` and drill into related topics (`commands`, `skills`, `release`) only when needed.

## Release Automation

- Daily release preparation runs in `.github/workflows/auto-release.yml`.
- Tag-driven publishing remains in `.github/workflows/release.yml`.
- Local parity commands:
  - `pnpm release:pipeline:dry-run`
  - `pnpm release:pipeline`
  - run maintainer-only reliability checks separately and keep their raw details in ignored local notes

## Core Model

- Items live under `.agents/pm/` as TOON by default, with JSON-front-matter markdown also supported.
- History lives in `.agents/pm/history/<id>.jsonl` and is append-only.
- Statuses are `draft`, `open`, `in_progress`, `blocked`, `closed`, and `canceled`.
- Built-in types include `Epic`, `Feature`, `Task`, `Chore`, `Issue`, `Decision`, `Event`, `Reminder`, `Milestone`, `Meeting`, and `Plan`.
- Output defaults to sparse TOON. Use `--json` for strict parsing.
- `pm contracts` is the machine-readable command and schema contract surface for agents.
- `pm guide` is the optional local progressive-disclosure docs and skills index for agents after installing `guide-shell`.

Search behavior (lexical `search.tuning` weights, hybrid `--semantic-weight`, query expansion, reranking, and vector-store options) is fully configurable — see [Search Configuration](docs/CONFIGURATION.md#search-configuration).

## Tracker References

Current documentation work is tracked through:

- [pm-u9d0](.agents/pm/epics/pm-u9d0.toon) - docs, onboarding, release, and CI capability epic

Legacy documentation baseline references (closed):

- [pm-3042](.agents/pm/epics/pm-3042.toon) - documentation overhaul epic (closed)
- [pm-r9gu](.agents/pm/features/pm-r9gu.toon) - documentation structure feature (closed)
- [pm-1sb2](.agents/pm/tasks/pm-1sb2.toon) - README and public docs rewrite task (closed)

Docs should link to relevant `pm` items, and `pm` items should link back to changed docs through `pm docs`.

## License

[MIT](LICENSE)
