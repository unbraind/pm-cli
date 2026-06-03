# Command Reference

This is a task-oriented command guide. For exact flags, use runtime help because extensions and settings can change the active surface:

```bash
pm <command> --help
pm <command> --help --json
pm contracts --command <command> --flags-only --json
```

## Agent Quick Context

- Prefer `pm context`, `pm search`, and narrow list commands before mutation.
- Prefer TOON for reading and `--json` for strict parsing.
- Use the [guide topic map](README.md#guide-topic-map) when optional `pm guide` local docs routing is needed.
- Use `pm contracts` for machine clients.
- Every mutation writes history.

Tracked documentation work: [pm-1sb2](../.agents/pm/tasks/pm-1sb2.toon).

## Command Families

| Family | Commands | Purpose |
|--------|----------|---------|
| Bootstrap | `init`, `config`, `health` | create and inspect tracker setup |
| Triage | `context`, `search`, `list*`, `aggregate`, `dedupe-audit` | find work and audit decomposition |
| Lifecycle | `create`, `claim`, `update`, `append`, `close`, `release`, `delete`, `start-task`, `pause-task`, `close-task` | mutate item state |
| Planning | `plan create`, `plan add-step`, `plan update-step`, `plan complete-step`, `plan link`, `plan approve`, `plan materialize` | agent-optimized living plans with ordered steps, evidence, decisions, validation, and materialization |
| Logs | `comments`, `notes`, `learnings`, `comments-audit` | record progress and durable context |
| Links | `files`, `docs`, `test`, `deps` | connect items to artifacts, tests, and relationships |
| Verification | `test`, `test-all`, `test-runs`, `validate`, `gc` | run linked tests and repository checks |
| History | `history`, `history-redact`, `history-repair`, `activity`, `restore`, `stats` | inspect, redact, re-anchor, and recover item state |
| Schema | `schema add-type` | register config-driven custom item types into `.agents/pm/schema/types.json` |
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
pm health --check-only --summary --json
```

`pm init` creates `.agents/pm`. `pm health --check-only --summary --json` gives the smallest machine-readable health gate without refreshing optional search artifacts.
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

`--sort` accepts `priority|deadline|updated_at|created_at|title|parent`, plus the convenience aliases `updated` (→ `updated_at`) and `created` (→ `created_at`):

```bash
pm list-all --sort updated --order desc
```

When a flag is rejected with `Unknown option`, the error guidance now suggests the nearest supported flag (including abbreviations like `--desc` → `--description`) and notes when the flag is valid on a different command (for example `--type` on `test-all` points to `create`/`list`).

## Create and Update

Shortest agent-friendly create (positional title + defaults to `Task` type):

```bash
pm create "Document command contracts"
pm create "Fix login bug" --type Issue --priority high
```

`pm create` defaults `--type` to `settings.governance.create_default_type` (falling back to `Task`).
Pass `--create-mode strict` to require an explicit `--type` flag for governance-controlled flows.
Priority accepts either `0..4` or the equivalent names `critical`, `high`, `medium`, `low`, and `minimal`.

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

Repeated singular/plural list flags now accumulate, so `--tag a --tag b` is equivalent to `--tags a,b` (the same holds for `--status` and `--fields` on read commands). Earlier versions silently kept only the last value.

`--tags` REPLACES the whole tag list. To edit tags without restating the full set, use the additive/subtractive flags on `create`/`update`/`update-many`:

- `--add-tags <value>` adds tags to the existing list without replacing it (repeatable; CSV or JSON-array values accepted).
- `--remove-tags <value>` prunes the given tags from the existing list (repeatable; CSV or JSON-array). Available on `update`/`update-many` only — `create` has no prior tags to remove.

```bash
pm update pm-abc1 --add-tags urgent,backend     # keeps existing tags, adds two
pm update pm-abc1 --remove-tags stale            # drops "stale", keeps the rest
pm create "New backend task" --add-tags backend,p1
```

Update existing work:

```bash
pm update <id> --status in_progress --message "Start implementation"
pm update <id> --priority medium --deadline +1d --estimate 120
pm update <id> --parent <parent-id>
pm append <id> --body "Detailed implementation notes."
```

`--expected` and `--actual` are short aliases for `--expected-result` and `--actual-result` on `create`/`update`/`update-many`, matching the aliases `pm close` already accepts:

```bash
pm update <id> --expected "Retry succeeds after backoff" --actual "Retry threw on first attempt"
```

Mutation commands (`create`/`update`/`close`/`append`/...) echo a `changed_fields` array. In high-volume agent loops that array is mostly redundant with the item echo above it, so pass the global `--no-changed-fields` flag to replace it with a compact `changed_field_count`:

```bash
pm --no-changed-fields create "Probe item"   # output keeps changed_field_count, drops the array
```

Over MCP the mutation tools (`pm_create`/`pm_update`/`pm_close`/`pm_run` append/update-many) are compact by default; pass `options.full=true` to restore the full `changed_fields` delta.

## Templates

After `pm install templates --project`, `pm templates` lists both saved templates and built-in starters:

```bash
pm templates
pm templates show bug
pm create --template bug --title "Fix search regression"
```

Built-ins are `bug`, `feature`, `spike`, and `chore`. A saved template with the same name overrides the built-in.

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
pm history <id> --full --diff --verify
pm history-redact <id> --literal "[redacted_path_prefix]/private" --replacement "[redacted_path]"
pm history-redact <id> --regex "/192\\.168\\.[0-9.]+/g" --dry-run
pm history-repair <id> --dry-run
pm history-repair <id> --message "re-anchor legacy drift"
pm activity --id <id> --limit 50
pm activity --full --id <id> --limit 50
pm restore <id> <timestamp-or-version>
```

History is append-only. Restore appends a new restore event instead of rewriting old history.
`history-redact` rewrites matching history payloads deterministically, recomputes hash chains, and appends an auditable `history_redact` marker entry when changes are applied.
`history-repair` re-anchors a drifted history chain when `pm health`/`pm validate --check-history-drift` report stale hashes: it replays the stream, recomputes every before/after hash, repairs legacy patch ops that no longer strictly apply, reconciles the latest hash with the on-disk item, and appends an auditable `history_repair` marker. It never modifies item content and is a safe no-op on a clean stream.

## Custom Item Types

Tracker references: [pm-qq69](../.agents/pm/features/pm-qq69.toon), [pm-1lkm](../.agents/pm/features/pm-1lkm.toon).

`pm schema` inspects and manages the runtime item-type registry. `list` and `show` include built-in, custom, and extension-provided types so agents can confirm project context before creating work. `add-type` registers a config-driven custom item type so agents can use `pm create <Type> "..."` for project-specific work categories without editing settings by hand. Custom definitions are merged from `.agents/pm/schema/types.json` (shape: `{ "definitions": [ItemTypeDefinition...] }`).

```bash
pm schema list
pm schema show Task
pm schema add-type Spike --description "Time-boxed investigation" --default-status open
pm schema add-type Spike --alias spike --alias research --folder spikes
pm create Spike "Investigate retry backoff"
```

- `pm schema list --json` returns `{ builtin, custom, extension, counts }` for compact machine parsing.
- `pm schema show <Type> --json` returns the resolved definition, including folder, aliases, default status, required create options, type options, command-option policies, and extension provenance when applicable.
- The command is an idempotent UPSERT keyed on the type name (case-insensitive); re-running it merges aliases and overrides supplied fields while preserving everything else.
- Built-in types (Chore, Decision, Epic, Event, Feature, Issue, Meeting, Milestone, Plan, Reminder, Task) are reserved and cannot be redefined.
- Flags: `--description <text>`, `--default-status <status>`, `--folder <dir>`, `--alias <name>` (repeatable), plus `--author`/`--force` governance flags. Add `--json` for the machine envelope.
- When `pm create`/`pm update` reject an unknown type, the error now points back here: `To register a custom type, run: pm schema add-type "X" (writes .agents/pm/schema/types.json).`

`pm init --type-preset agile|ops|research` registers common domain types during initialization:

- `agile`: Story, Spike
- `ops`: Incident, Runbook
- `research`: Experiment, Hypothesis

The option composes with `--defaults`, `--preset`, `--author`, `--agent-guidance`, and `--with-packages`; re-running it is idempotent and reports `registered_type_preset` in JSON output.

## Plan Workflow

`pm plan` is the agent-optimized planning loop built on the first-class `Plan` item type. Plans persist ordered steps, evidence, decisions, discoveries, validation, and resume context. Each mutation appends a history entry; full hash-chain replay is preserved.

```bash
pm plan create --title "Refactor lock retry" --scope "Improve retry semantics" --harness claude-code --parent pm-epic1 --related pm-rel1,pm-rel2 --claim
pm plan add-step <plan-id> --step-title "Read lock.ts" --step-body "Inspect retry path" --depends-on pm-task1
pm plan update-step <plan-id> plan-step-001 --step-status in_progress --step-evidence "started reading lock.ts"
pm plan complete-step <plan-id> plan-step-001 --step-evidence "lock.ts read; retry path captured"
pm plan block-step <plan-id> plan-step-003 --step-blocked-reason "waiting on pm-task9 approval"
pm plan link <plan-id> plan-step-002 --link pm-rel3 --link-kind discovered_from --link-note "found related util"
pm plan decision <plan-id> --decision-text "Use exponential backoff" --decision-rationale "Avoid thundering herd"
pm plan discovery <plan-id> --discovery-text "Found existing util in src/util/retry.ts"
pm plan validation <plan-id> --validation-text "Coverage stays at 100%" --validation-command "node scripts/run-tests.mjs coverage"
pm plan resume <plan-id> --resume-context "step 2 pending; tests still failing on retry path"
pm plan approve <plan-id> --message "ready to execute"
pm plan materialize <plan-id> --steps plan-step-002,plan-step-003 --materialize-type Task --materialize-parent pm-epic1
pm plan show <plan-id> --depth brief
pm plan show <plan-id> --depth standard
pm plan show <plan-id> --depth deep
pm plan show <plan-id> --fields id,title,steps_summary
```

Subcommand cheatsheet:

| Subcommand | Purpose |
|------------|---------|
| `create` | Create a Plan item with scope, harness, parent, related, blocked-by, and optional auto-claim |
| `show` | Progressive-disclosure read (brief / standard / deep) with current step + next-action hints |
| `add-step` | Append a step with title/body/owner/status/dependencies/files/tests/docs |
| `update-step` | Patch one step (title, body, status, evidence, owner, blocked reason) |
| `complete-step` | Shortcut for setting a step to `completed` with evidence |
| `block-step` | Shortcut for setting a step to `blocked` with required `--step-blocked-reason` |
| `reorder-step` | Move a step to a new 1-based order |
| `remove-step` | Drop a step and renumber remaining steps |
| `link` / `unlink` | Add or remove `linked_items` on a step (with optional `--promote-to-item-dep`) |
| `decision` | Append a decision log entry (decision/rationale/evidence) |
| `discovery` | Append a discovery log entry |
| `validation` | Append a validation check (text/command/expected) |
| `resume` | Replace the resume-context summary for stateless agents |
| `approve` | Move `plan_mode` to `approved` (default) or any other mode via `--mode` |
| `materialize` | Create real pm items (default `Task`) from selected steps with bidirectional links |

Invariants:

- Exactly one step is `in_progress` per Plan; pass `--allow-multiple-active` for explicit parallel branches.
- Blocking a step requires `--step-blocked-reason` (or an already-recorded reason).
- `materialize` adds `discovered_from` + `parent` to each new item and an `implements` link back on the source step plus a `child` dependency on the Plan.
- Search keyword corpus includes plan_scope, step titles/bodies, decisions, discoveries, validation, and step linked items.

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
