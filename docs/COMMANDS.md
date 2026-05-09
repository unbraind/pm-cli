# Command Reference

This is a task-oriented command guide. For exact flags, use runtime help because extensions and settings can change the active surface:

```bash
pm <command> --help
pm <command> --help --json
pm contracts --command <command> --flags-only --json
pm guide commands --depth standard
```

## Agent Quick Context

- Prefer `pm context`, `pm search`, and narrow list commands before mutation.
- Prefer TOON for reading and `--json` for strict parsing.
- Use `pm guide <topic>` for local docs routing before opening deeper pages.
- Use `pm contracts` for machine clients.
- Every mutation writes history.

Tracked documentation work: [pm-1sb2](../.agents/pm/tasks/pm-1sb2.toon).

## Command Families

| Family | Commands | Purpose |
|--------|----------|---------|
| Bootstrap | `init`, `config`, `health` | create and inspect tracker setup |
| Triage | `context`, `search`, `list*`, `aggregate`, `dedupe-audit` | find work and audit decomposition |
| Lifecycle | `create`, `claim`, `update`, `append`, `close`, `release`, `delete`, `start-task`, `pause-task`, `close-task` | mutate item state |
| Logs | `comments`, `notes`, `learnings`, `comments-audit` | record progress and durable context |
| Links | `files`, `docs`, `test`, `deps` | connect items to artifacts, tests, and relationships |
| Verification | `test`, `test-all`, `test-runs`, `validate`, `gc` | run linked tests and repository checks |
| History | `history`, `activity`, `restore`, `stats` | inspect and recover item state |
| Calendar | `calendar`, `cal` | project deadlines, reminders, and events |
| Extensions | `extension`, extension command groups | install, manage, and run extension commands |
| Machines | `guide`, `contracts`, `completion`, `help` | local docs routing plus command contracts and shell helpers |

## Bootstrap

```bash
pm init
pm config project list
pm health --check-only
```

`pm init` creates `.agents/pm`. `pm health --check-only` inspects without refreshing optional search artifacts.

## Triage

```bash
pm context --limit 10
pm search "calendar reminder validation" --limit 10
pm list-open --type Task --priority 1 --limit 20
pm list-in-progress --limit 20
pm aggregate --group-by parent,type --status open
pm dedupe-audit --mode parent_scope --limit 20
```

Use `context` first for a compact active-work snapshot. Use `search` when the request names a concept, component, or prior issue.

## Create and Update

Minimal progressive create:

```bash
pm create \
  --title "Document command contracts" \
  --description "Add command contract examples for agents." \
  --type Task \
  --status open \
  --priority 1 \
  --create-mode progressive
```

Strict create is best when metadata is ready:

```bash
pm create \
  --title "Fix restore replay" \
  --description "Restore should replay patches through the target version." \
  --type Issue \
  --status open \
  --priority 1 \
  --tags "restore,history" \
  --ac "Restore reproduces the target state and has regression coverage." \
  --message "Create restore replay issue"
```

Update existing work:

```bash
pm update <id> --status in_progress --message "Start implementation"
pm update <id> --deadline +1d --estimate 120
pm update <id> --parent <parent-id>
pm append <id> --body "Detailed implementation notes."
```

Use `pm close <id> "<reason>"` instead of `pm update --status closed`.

## Lifecycle Aliases

Lifecycle aliases combine claim, status, and close operations into a single command:

```bash
pm start-task <id>             # claim + move to in_progress
pm pause-task <id>             # move to open + release claim
pm close-task <id> "<reason>"  # close + release assignment
```

## Ownership

```bash
pm claim <id>
pm release <id>
pm release <id> --allow-audit-release --author <you>
```

`claim` is the normal start signal. Use `--force` only when explicitly overriding terminal-state or lock conflicts.

## Logs

```bash
pm comments <id> "Implemented command parsing fix."
printf '%s\n' '## Verification summary' '- Linux pass' '- macOS pass' | pm comments <id> --stdin
pm comments <id> --file docs/release-evidence.md
pm notes <id> --add "Keep renderer changes isolated to TOON output."
pm learnings <id> --add "Use runtime contracts instead of duplicating flag lists."
```

Use comments for progress and evidence, notes for implementation context, and learnings for durable future guidance. For comments, choose exactly one input source (`[text]`, `--add`, `--stdin`, or `--file`) per invocation.

## Linked Artifacts

```bash
pm files <id> --add path=src/cli/main.ts,scope=project,note="command wiring"
pm files <id> --add-glob "src/cli/**/*.ts"
pm docs <id> --add path=docs/COMMANDS.md,scope=project,note="public command docs"
pm deps <id> --format tree
```

Linked files and docs keep reviews reproducible. `deps` is read-only and projects item relationships.

## Linked Tests

```bash
pm test <id> --add command="node scripts/run-tests.mjs test -- tests/unit/output.spec.ts",scope=project,timeout_seconds=240
pm test <id> --run --progress
pm test-all --status in_progress --progress
```

Linked test commands should be sandbox-safe. Prefer `node scripts/run-tests.mjs ...` because it sets temporary `PM_PATH` and `PM_GLOBAL_PATH`.

Strict linked-test guards:

```bash
pm test <id> --run \
  --check-context \
  --fail-on-context-mismatch \
  --fail-on-skipped \
  --require-assertions-for-pm
```

## Calendar and Context

```bash
pm calendar --view week --date today --full-period
pm calendar --from today --to +7d --include deadlines,reminders,events
pm context --from today --to +7d --limit 10
```

`calendar` defaults to markdown for human and agent readability. Other commands default to TOON unless configured otherwise.

## Validation and Maintenance

```bash
pm validate --check-resolution --check-history-drift
pm validate --check-files --scan-mode tracked-all
pm normalize --dry-run --json
pm gc --dry-run
```

Use dry-run modes before broad lifecycle or cleanup changes.

## History and Recovery

```bash
pm history <id> --limit 20
pm history <id> --diff --verify
pm activity --id <id> --limit 50
pm restore <id> <timestamp-or-version>
```

History is append-only. Restore appends a new restore event instead of rewriting old history.

## Machine Contracts

```bash
pm contracts --json
pm contracts --command create --flags-only --json
pm contracts --action create --schema-only --json
pm help create --json
```

Agents should use runtime contracts instead of hard-coding flag lists. Contract output includes extension-provided command surfaces when active.

## Completion

```bash
pm completion bash
pm completion zsh
pm completion fish
```

Generated completions resolve tags lazily by default. Use `--eager-tags` only when embedding static tags is required.
