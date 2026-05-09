# Quickstart

Use this page to get from a clean repository to a tracked, verified item.

## Agent Quick Context

- Start with `pm init`.
- Create items with enough metadata to route work, then enrich later.
- Claim before implementation.
- Link changed files, docs, and tests to the item.
- Close only after evidence is recorded.
- Use `pm guide quickstart` or `pm guide workflows` when you need local docs routing.

Tracked documentation work: [pm-1sb2](../.agents/pm/tasks/pm-1sb2.toon).

## Install

```bash
npm install -g @unbrained/pm-cli
pm --version
```

For updates, use the registry package again:

```bash
npm install -g @unbrained/pm-cli@latest
```

Do not use the GitHub git URL as the normal global update path. If a previous git-sourced install left a stale `pm` shim, run `bash scripts/install.sh --repair` from a checkout or uninstall the package before reinstalling from npm.

For one-off use:

```bash
npx @unbrained/pm-cli --help
```

## Initialize a Repository

```bash
pm init
pm health --check-only
```

`pm init` creates `.agents/pm/` with settings, item folders, history, locks, search cache directories, and project extension storage.

## Create Your First Item

Use strict create mode when all required fields are ready. Use progressive mode for staged triage.

```bash
pm create \
  --title "Add restore retry logging" \
  --description "Restore should explain stale lock retry behavior." \
  --type Task \
  --status open \
  --priority 1 \
  --tags "restore,locks" \
  --ac "Retry logs are visible and regression coverage passes." \
  --create-mode progressive
```

Useful item types:

| Type | Use |
|------|-----|
| `Epic` | broad outcome or initiative |
| `Feature` | user-facing capability or major slice |
| `Task` | implementation work |
| `Issue` | bug or defect |
| `Decision` | recorded choice and rationale |
| `Event`, `Reminder`, `Milestone`, `Meeting` | calendar-aware planning |

## Find and Claim Work

```bash
pm context --limit 10
pm search "restore lock retry" --limit 10
pm list-open --limit 20
pm claim <item-id>
pm update <item-id> --status in_progress --message "Start implementation"
```

Do not create a duplicate item until `context`, `search`, and list commands show no relevant active item.

## Link Work Artifacts

```bash
pm files <item-id> --add path=src/core/lock/lock.ts,scope=project,note="implementation"
pm docs <item-id> --add path=docs/ARCHITECTURE.md,scope=project,note="design context"
pm test <item-id> --add command="node scripts/run-tests.mjs test -- tests/unit/lock.spec.ts",scope=project,timeout_seconds=240
```

Use `node scripts/run-tests.mjs ...` for linked tests so tracker data is sandboxed.

## Record Evidence and Close

```bash
pm test <item-id> --run --progress
pm comments <item-id> "Evidence: linked lock regression passed."
pm close <item-id> "Acceptance criteria met; linked regression passed." --validate-close warn
pm release <item-id>
```

For broad readiness checks:

```bash
pnpm build
node scripts/run-tests.mjs coverage
pm validate --check-resolution --check-history-drift
```

## Next Pages

- [Agent Guide](AGENT_GUIDE.md) for the full canonical workflow.
- [Command Reference](COMMANDS.md) for command families and examples.
- [Configuration](CONFIGURATION.md) for output, storage, search, and validation settings.
- [Testing](TESTING.md) for sandbox and linked-test details.
