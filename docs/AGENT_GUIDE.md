# Agent Guide

This guide is optimized for coding agents that need to understand and mutate repository work with minimal context.

## Agent Quick Context

Run this before heavy work:

```bash
pm context --limit 10
pm search "<request keywords>" --limit 10
pm list-open --limit 20
pm list-in-progress --limit 20
pm guide workflows
```

If a relevant item exists, reuse it. If not, create a parent lineage, then create and claim the child implementation item.

Tracked documentation work: [pm-3042](../.agents/pm/epics/pm-3042.toon), [pm-r9gu](../.agents/pm/features/pm-r9gu.toon), [pm-1sb2](../.agents/pm/tasks/pm-1sb2.toon).

## Canonical Loop

1. **Orient**

```bash
pm context --limit 10
pm search "<keywords>" --limit 10
pm list-open --limit 20
pm list-in-progress --limit 20
```

2. **Create only when necessary**

```bash
pm create --create-mode progressive \
  --title "..." \
  --description "..." \
  --type Epic \
  --status open \
  --priority 1 \
  --comment "author=$PM_AUTHOR,created_at=now,text=Duplicate check evidence: ..."
```

Create hierarchy from broad to narrow: `Epic` -> `Feature` -> `Task` or `Issue`. Use `--parent <id>` for child items.

3. **Claim**

```bash
pm claim <item-id>
pm update <item-id> --status in_progress --message "Start implementation"
```

4. **Clarify**

```bash
pm update <item-id> --description "..." --ac "..." --estimate 90
pm append <item-id> --body "Implementation notes..."
```

5. **Link execution context**

```bash
pm files <item-id> --add path=src/app.ts,scope=project,note="entrypoint"
pm docs <item-id> --add path=docs/COMMANDS.md,scope=project,note="public docs"
pm test <item-id> --add command="node scripts/run-tests.mjs test -- tests/unit/app.spec.ts",scope=project,timeout_seconds=240
```

6. **Record progress**

```bash
pm comments <item-id> "Implemented the retry path."
pm notes <item-id> --add "Design rationale or tradeoff."
pm learnings <item-id> --add "Durable lesson for future work."
```

7. **Validate and close**

```bash
pm test <item-id> --run --progress
node scripts/run-tests.mjs coverage
pm comments <item-id> "Evidence: linked test and coverage passed."
pm close <item-id> "Acceptance criteria met; verification passed." --validate-close warn
pm release <item-id>
```

## Token-Minimal Retrieval

| Need | Command |
|------|---------|
| Next work and agenda | `pm context --limit 10` |
| Relevant items | `pm search "<keywords>" --limit 10` |
| Single item | `pm get <id>` |
| Exact machine payload | `pm get <id> --json` |
| Command flags | `pm <command> --help --json` |
| Low-noise machine contracts | `pm contracts --command <command> --flags-only --json` |
| Timeline | `pm activity --id <id> --limit 20` |
| Dependencies | `pm deps <id> --format tree` |
| Local docs routing | `pm guide <topic>` |

Default TOON output is preferred for model-readable loops. Use `--json` only when strict parsing is needed.

## Guide Routing for Agents

Use `pm guide` as the local progressive-disclosure router before opening large documents:

```bash
pm guide
pm guide quickstart
pm guide commands --depth standard
pm guide skills --depth deep --format markdown
pm guide release --json
```

## Ownership Rules

- Claim before heavy edits.
- `pm claim <id>` can take over non-terminal work from another owner.
- Use `--force` only for explicit override paths.
- For append-only audit comments on another owner item, use `--allow-audit-comment`.
- Release when pausing, handing off, or after close.

## Documentation Rules for Agents

- Keep [README](../README.md) short.
- Put details in focused docs under `docs/`.
- Keep reusable workflow prompts in `.agents/skills/*` and route via `pm guide skills`.
- Use relative links such as `[Command Reference](COMMANDS.md)`.
- Add tracker references near the top of new docs when a task created the change.
- Link docs back to the active item with `pm docs`.
- Do not link public docs to ignored local operations artifacts or private evidence logs.

## Safe Defaults

Use these defaults unless the task requires otherwise:

- `PM_AUTHOR=<stable-agent-name>` for mutations.
- `node scripts/run-tests.mjs test` and `node scripts/run-tests.mjs coverage` for tests.
- `pm validate --check-resolution --check-history-drift` before closing broad work.
- `pm normalize --dry-run --json` before lifecycle metadata cleanups.
- `pm health --check-only` when inspecting repository health without refresh side effects.
