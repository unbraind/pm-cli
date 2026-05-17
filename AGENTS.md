# AGENTS.md - Compact Operating Rules for `pm`

This file is the low-context entrypoint for agents working in this repository. Read it first, then expand only into the linked docs that match the task.

## Progressive Disclosure

| Need | Read |
|------|------|
| Agent workflow and ownership | [Agent Guide](docs/AGENT_GUIDE.md) |
| Exact command families and examples | [Command Reference](docs/COMMANDS.md) |
| Sandbox-safe verification | [Testing](docs/TESTING.md) |
| Settings, output, and environment | [Configuration](docs/CONFIGURATION.md) |
| Package or extension work | [Packages and Extensions](docs/EXTENSIONS.md), [SDK](docs/SDK.md) |
| Release work | [Releasing](docs/RELEASING.md) |
| Full docs map | [Documentation Index](docs/README.md) |

Use runtime contracts for exact flags because packages and settings can change the active surface:

```bash
pm <command> --help --json
pm contracts --command <command> --flags-only --json
pm install guide-shell --project
pm guide <topic>
```

## Non-Negotiables

- `pm` is the system of record. Do not edit `.agents/pm` files directly.
- Every code, docs, or test change must be linked to a `pm` item with files/docs/tests and evidence comments.
- Before creating work, search existing items and reuse the canonical lineage when possible.
- Claim before substantial edits; release when paused, handed off, closed, or canceled.
- Every mutation must write history through `pm`.
- Use TOON/default human-readable output for agent loops; use `--json` only for strict parsing.
- Do not run destructive commands or force ownership/lock overrides unless the user explicitly approves that action.
- Keep public docs free of credentials, host-specific runbooks, private operations details, and ignored local evidence logs.

## Required Bootstrap

Before `pm` mutations in this repo:

```bash
npm install -g .
pm --version
node -v
pnpm -v
pnpm build
```

Then set:

```bash
export PM_AUTHOR=<stable-agent-id>
```

Use `PM_CMD=pm` only after `pm` clearly resolves to this checkout's current build. Otherwise run `node dist/cli.js` from the repository root.

For real repository tracking, do not override `PM_PATH`. For tests and dogfood runs, use sandboxed `PM_PATH` and `PM_GLOBAL_PATH`; prefer `node scripts/run-tests.mjs ...` because it sets them automatically.

<!-- pm-cli:agent-guidance:start:v1 -->
## pm Workflow Quickstart

```bash
pm context --limit 10
pm search "<request keywords>" --limit 10
pm list-open --limit 20
pm list-in-progress --limit 20
pm create --create-mode progressive --title "..." --description "..." --type Task --status open
pm claim <id>
pm update <id> --status in_progress --message "Start implementation"
pm files <id> --add path=<path>,scope=project,note="<why>"
pm docs <id> --add path=<path>,scope=project,note="<why>"
pm test <id> --add command="node scripts/run-tests.mjs test -- <target>",scope=project,timeout_seconds=240
pm comments <id> "Evidence: <what changed and what passed>"
pm test <id> --run --progress
pm close <id> "<reason with evidence>" --validate-close warn
pm release <id>
```

Set `PM_AUTHOR=<stable-agent-id>` before mutations.
<!-- pm-cli:agent-guidance:end -->

## Working Rules

- **Orient:** run `pm context`, `pm search`, `pm list-open`, and `pm list-in-progress` before `pm create`. If net-new work is required, create or reuse the parent lineage first and record duplicate-check evidence in a create-time comment.
- **Implement:** keep edits scoped to the claimed item. Link changed files with `pm files`, docs with `pm docs`, and runnable verification with `pm test`.
- **Record:** use `pm comments`, `pm notes`, and `pm learnings` for progress, rationale, and durable lessons. Prefer append-style updates over rewriting item content.
- **Verify:** use sandbox-safe commands. For documentation-only work, run at least `pnpm build` and a focused link/content check. For broader work, run linked tests, coverage, validation, and release gates as appropriate.
- **Close:** add evidence first, then `pm close <id> "<reason>" --validate-close warn`, then `pm release <id>`.

## Test Safety

- Tests must never read or write the real repository `.agents/pm` data.
- Use `node scripts/run-tests.mjs test` and `node scripts/run-tests.mjs coverage` for local tests.
- Linked tests should use sandbox-safe commands and avoid recursive `pm test-all` item links.
- Use `--progress` for long-running non-interactive linked tests or reindex paths.

## Documentation Policy

- Keep this file and [README](README.md) short.
- Move details into focused docs under `docs/` and keep links relative/GitHub-compatible.
- Add tracker references near the top of new docs when a `pm` item created the change.
- Link documentation changes back to the active item with `pm docs`.

## When Unsure

1. Add a `pm comments <id> "Investigation note: ..."` entry before risky mutation.
2. Prefer `pm health --check-only`, `pm validate --check-resolution --check-history-drift`, and `pm normalize --dry-run --json` for diagnostics.
3. Use [Agent Guide](docs/AGENT_GUIDE.md) for the full agent loop and [Command Reference](docs/COMMANDS.md) for command-specific examples.
