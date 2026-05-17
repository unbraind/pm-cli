# Command Reference

This is a task-oriented command guide. For exact flags, use runtime help because extensions and settings can change the active surface:

```bash
pm <command> --help
pm <command> --help --json
pm contracts --command <command> --flags-only --json
pm install guide-shell --project
pm guide commands --depth standard
```

## Agent Quick Context

- Prefer `pm context`, `pm search`, and narrow list commands before mutation.
- Prefer TOON for reading and `--json` for strict parsing.
- Use `pm install guide-shell --project` before `pm guide <topic>` when local docs routing is needed.
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
| Packages | `install`, `upgrade`, `package`, `packages`, `extension`, package/extension command groups | install, upgrade, manage, and run package-backed extension commands |
| Machines | `contracts`, `help`, optional `guide`/`completion` | command contracts plus optional guide-shell docs routing and shell helpers |

## Bootstrap

```bash
pm init
pm init --defaults --with-packages
pm init --agent-guidance status
pm init --agent-guidance add
pm config project list
pm health --check-only
```

`pm init` creates `.agents/pm`. `pm health --check-only` inspects without refreshing optional search artifacts.
`pm init --agent-guidance ask` is the default behavior: prompt in TTY only when AGENTS/CLAUDE guidance is missing and no decline is recorded.
Use `--agent-guidance add` to write guidance, `--agent-guidance skip` to persist a decline without writing, and `--agent-guidance status` to inspect guidance state.
Use `--with-packages` for one-step agent setup when bundled package commands should be active immediately.

## Packages

```bash
pm package                     # bare command defaults to --explore (list installed)
pm install '*' --project
pm package catalog --project
pm install npm:@scope/pm-package --project
pm package doctor --project --detail summary
pm upgrade --dry-run
pm upgrade --packages-only
pm upgrade --cli-only --repair
```

`pm install` and `pm package` are the preferred package-first workflow. `pm package` and `pm extension` bare invocations default to `--explore` so agents can list installed packages without remembering an action flag. `pm install '*'`, shell-expanded `pm install *`, and `pm install all` install bundled first-party packages. `pm extension` remains as a compatibility command for direct extension lifecycle operations.
When package-owned commands are unavailable, usage guidance includes an install-ready retry (for example `pm install calendar`, `pm install search-advanced`, `pm install governance-audit`, or `pm install guide-shell`).

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

Shortest agent-friendly create (positional title + defaults to `Task` type):

```bash
pm create "Document command contracts"
pm create "Fix login bug" --type Issue --priority 1
```

`pm create` defaults `--type` to `settings.governance.create_default_type` (falling back to `Task`).
Pass `--create-mode strict` to require an explicit `--type` flag for governance-controlled flows.

Minimal progressive create with explicit fields:

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
pm files <id> --add path=src/cli/main.ts,note="command wiring"
pm files <id> --add-glob "src/cli/**/*.ts"
pm docs <id> --add path=docs/COMMANDS.md,note="public command docs"
pm deps <id> --format tree
```

Linked files and docs keep reviews reproducible. `deps` is read-only and projects item relationships.

## Linked Tests

```bash
pm test <id> --add command="node scripts/run-tests.mjs test -- tests/unit/output.spec.ts",timeout_seconds=240
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
For `--include events` without explicit `--to`, `--recurrence-lookahead-days`, or `--occurrence-limit`, recurring expansion is intentionally capped to a bounded default window and emits a warning with retry hints for broader windows.

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
