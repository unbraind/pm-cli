# pm-cli (`pm`)

[![CI](https://github.com/unbraind/pm-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/unbraind/pm-cli/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40unbrained%2Fpm-cli)](https://www.npmjs.com/package/%40unbrained%2Fpm-cli)
[![Node >=20](https://img.shields.io/node/v/%40unbrained%2Fpm-cli)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

`pm` is a git-native project management CLI for humans and coding agents. It stores work as plain Markdown files with JSON front matter, keeps append-only history, and supports safe collaboration.

## Highlights

- Git-native items that stay reviewable in diffs
- Safe multi-agent workflows with claims, locks, and restore
- Deterministic output with TOON by default and `--json` when needed
- Optional search and extension support for more advanced setups

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

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Extensions](docs/EXTENSIONS.md)
- [Contributing](CONTRIBUTING.md)
- [Security Policy](SECURITY.md)
- [Changelog](CHANGELOG.md)

## License

MIT. See [LICENSE](LICENSE).
