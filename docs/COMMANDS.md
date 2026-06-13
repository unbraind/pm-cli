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

Tracked documentation work: [pm-u9d0](../.agents/pm/epics/pm-u9d0.toon).

## Command Families

| Family | Commands | Purpose |
|--------|----------|---------|
| Bootstrap | `init`, `config`, `health`, `telemetry` | create and inspect tracker setup |
| Triage | `context`, `search`, `list*`, `aggregate`, `dedupe-audit`* | find work and audit decomposition |
| Lifecycle | `create`, `claim`, `update`, `append`, `close`, `release`, `delete`, `start-task`, `pause-task`, `close-task` | mutate item state |
| Planning | `plan create`, `plan add-step`, `plan update-step`, `plan complete-step`, `plan link`, `plan approve`, `plan materialize` | agent-optimized living plans with ordered steps, evidence, decisions, validation, and materialization |
| Logs | `comments`, `notes`, `learnings`, `comments-audit` | record progress and durable context |
| Links | `files`, `docs`, `test`, `deps` | connect items to artifacts, tests, and relationships |
| Verification | `test`, `test-all`, `test-runs`, `validate`, `gc` | run linked tests and repository checks |
| History | `history`, `history-compact`, `history-redact`, `history-repair`, `activity`, `restore`, `stats` | inspect, compact, redact, re-anchor, and recover item state |
| Schema | `schema add-type` / `remove-type` / `add-status` / `remove-status` | manage config-driven custom item types (`.agents/pm/schema/types.json`) and statuses (`.agents/pm/schema/statuses.json`) |
| Calendar | `calendar`, `cal` | project deadlines, reminders, and events |
| Packages | `install`, `upgrade`, `package`, `packages`, `extension`, package/extension command groups | install, upgrade, manage, and run package-backed extension commands |
| Machines | `contracts`, `help`, optional `guide`/`completion` | command contracts plus optional guide-shell docs routing and shell helpers |

`*` `dedupe-audit` is provided by the optional `governance-audit` package (`pm install governance-audit --project`).

## Bootstrap

```bash
pm init
pm init --defaults --with-packages
pm init --agent-guidance status
pm init --agent-guidance add
pm config project list
pm health --check-only --summary --json
pm telemetry status
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
pm aggregate --group-by parent,type --completion --include-unparented
pm install governance-audit --project   # if dedupe-audit is not available
pm dedupe-audit --mode parent_scope --limit 20
```

Use `context` first for a compact active-work snapshot. Use `search` when the request names a concept, component, or prior issue.
`context` standard/deep views include high-level child completion counters plus `recently_created` and `unparented` sections, so agents can spot new orphan work before creating duplicates.
Use `pm aggregate --completion` when you need per-group `open`, `in_progress`, `closed`, `other`, and `completion_pct` progress context.

`--sort` accepts `priority|deadline|updated_at|created_at|title|parent`, plus the convenience aliases `updated` (→ `updated_at`) and `created` (→ `created_at`):

```bash
pm list-all --sort updated --order desc
```

### Incremental "what changed since" filters

Every `list*` command accepts `--updated-after`/`--updated-before`/`--created-after`/`--created-before`, and `pm search` accepts `--status` for parity with `list`. These keep a long-running agent's context focused on the slice it cares about instead of re-scanning the whole tracker:

```bash
# Items touched since my last context window (feed back the previous run's `now`)
pm list-all --updated-after 2026-06-04T15:18:32Z --brief

# Relative offsets are SIGNED: -2h/-7d reach into the past, +1d into the future.
# Units are h/d/w/m (m = months — there is no minutes unit).
pm list-open --updated-after=-2h --brief
pm list-all --created-after=-7d --status open

# Search scoped to open work only (drops closed-history noise); statuses are
# open/closed/canceled aliases or configured ids, comma-separated, with a
# did-you-mean hint on typos.
pm search "reminder validation" --status open --limit 10
```

`list`/`search` full and fields projections echo full filter metadata. Compact mode emits only active filters (plus runtime schema filters when present) and omits the default projection/sorting/now trailer keys for lower token cost.

## Bulk Operations

`update-many` and `close-many` apply one change across a matched set with a dry-run preview and a rollback checkpoint. Both share the `--filter-*` scoping family (`--filter-status/-type/-tag/-priority/-sprint/-release/-parent/-assignee/-deadline-before|after/-updated-after|before/-created-after|before`) plus `--ids` for an explicit comma-separated allowlist intersected with the other filters.

```bash
# Bulk metadata update by explicit id allowlist (compose with search --json | jq)
pm update-many --ids pm-a,pm-b,pm-c --priority 1 --dry-run
pm update-many --filter-tag wave:7 --reviewer maintainer-review

# Audited bulk close: routes EACH match through full `pm close` semantics
# (close validation, active-child orphan checks, blocked-edge cleanup) — unlike
# `update-many --status closed`, which bypasses them. A shared --reason is required
# and at least one filter is required so it never matches every item.
pm close-many --filter-sprint S-12 --reason "Sprint S-12 acceptance criteria met" --dry-run
pm close-many --filter-sprint S-12 --reason "Sprint S-12 acceptance criteria met"
pm close-many --rollback close-many-20260604-abc123   # restore the batch
```

`close-many` skips already-terminal matches by default (pass `--force` to re-close), reports a per-item plan (`close`/`skip`, plus `active_child_ids` for parents that would be orphaned) under `--dry-run`, and writes a checkpoint by default (`--no-checkpoint` to disable). Checkpoints for both commands live under `.agents/pm/checkpoints/<command>/` and are restored with `--rollback <checkpoint-id>`.

When a flag is rejected with `Unknown option`, the error guidance now suggests the nearest supported flag (including abbreviations like `--desc` → `--description`) and notes when the flag is valid on a different command (for example `--type` on `test-all` points to `create`/`list`).

## Create and Update

Shortest agent-friendly create (positional title + defaults to `Task` type):

```bash
pm create "Document command contracts"
pm create "Fix login bug" --type Issue --priority high
```

`pm create` defaults `--type` to `settings.governance.create_default_type` (falling back to `Task`).
Set it with `pm config project set governance-create-default-type <Type>` (must resolve to a known item type).
Pass `--create-mode strict` to require an explicit `--type` flag for governance-controlled flows.
`pm update --status` can be constrained per item type via `schema.type_workflows` plus
`pm config project set governance-workflow-enforcement <off|warn|strict>` (see CONFIGURATION.md → Per-Type Workflows).
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

Repeated singular/plural list flags now accumulate, so `--tag a --tag b` is equivalent to `--tags a,b` (the same holds for `--status`, `--ids`, and `--fields` on read commands). Earlier versions silently kept only the last value. `list`/`search` also accept `--tags` as a never-block alias for the canonical read filter `--tag`.

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
pm --id-only create "Probe item"             # output is only id + status
```

Use `pm create --allow-missing-parent --parent <id>` only for deliberate imports or staged backlog reconstruction. Normal `pm create --parent <id>` fails fast when the parent id cannot be resolved.

Use `pm close <duplicate-id> --duplicate-of <canonical-id>` to close duplicates. The command validates the canonical target exists, records `duplicate_of`, auto-fills the close reason as `Duplicate of <canonical-id>` when no reason text was supplied, and fills the resolution/expected/actual closure fields when they were not provided explicitly.

Over MCP the mutation tools (`pm_create`/`pm_update`/`pm_close`/`pm_run` append/update-many) are compact by default; pass `fullChangedFields=true` to restore the full `changed_fields` delta, or `idOnly=true` for single-item id/status output.

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
pm files <id> --add src/cli/main.ts --note "command wiring"
pm files <id> --add-glob "src/cli/**/*.ts"
pm docs <id> --add path=docs/COMMANDS.md,note="public command docs"
pm docs <id> --add docs/COMMANDS.md --note "public command docs"
pm deps <id> --format tree
```

Linked files and docs keep reviews reproducible. `deps` is read-only and projects item relationships. The standalone `--note <text>` flag annotates every link added by `--add`/`--add-glob` in the same invocation (a per-entry embedded `note=` wins); `--note` without an add is a usage error.

## Linked Tests

```bash
pm test <id> --add command="node scripts/run-tests.mjs test -- tests/unit/output.spec.ts",timeout_seconds=240
pm test <id> --add command "node scripts/run-tests.mjs test -- tests/unit/output.spec.ts"
pm test <id> --add-json '{"command":"node scripts/run-tests.mjs test -- tests/unit/output.spec.ts","timeout_seconds":240}'
pm test <id> --run --progress
pm test <id> --run --match output
pm test <id> --run --only-index 2
pm test <id> --run --only-last
pm test-all --status in_progress --progress
```

Linked test commands should be sandbox-safe. Prefer `node scripts/run-tests.mjs ...` because it sets temporary `PM_PATH` and `PM_GLOBAL_PATH`. The two-token form `--add command "npm test -- parser"` (and `--add path "..."` / `--remove command "..."`) is accepted when the value is quoted into a single shell argument; it is normalized to `--add command=...` before parsing. Use `--add-json` when command strings contain commas, nested quotes, shell variables, or `--` separators that are awkward to preserve through CSV-style `--add` parsing. `--match`, `--only-index`, and `--only-last` select which linked tests execute without mutating the stored linked-test list.

Strict linked-test guards:

```bash
pm test <id> --run \
  --check-context \
  --fail-on-context-mismatch \
  --fail-on-skipped \
  --require-assertions-for-pm
```

## Search Reindex and Eval

`reindex` is provided by the `search-advanced` package (`pm install search-advanced --project`).

```bash
pm reindex --mode keyword
pm reindex --mode semantic
pm reindex --mode semantic --full
pm reindex --mode hybrid --progress
pm reindex --mode keyword --eval --eval-fixtures tests/search-eval/golden-queries.json
```

- `--mode semantic` and `--mode hybrid` are stale-first by default: only items whose `updated_at` no longer matches `search/vectorization-status.json` are re-embedded.
- `--full` forces a complete semantic/hybrid re-embed and vector upsert, even when ledger entries are unchanged.
- Progress now includes a stale-vs-total line so agents can estimate semantic reindex cost before embedding starts.
- When `pm reindex --mode keyword` detects an embedding provider/model mismatch against the last semantic ledger, it emits a migration warning so agents can run `pm reindex --mode semantic` to rebuild vectors.
- `--eval` runs the golden-query nDCG@5 harness and appends an `eval` summary to JSON output; `--eval-fixtures` overrides the fixture file path.

## Calendar and Context

```bash
pm calendar --view week --date today --full-period
pm calendar --from today --to +7d --include deadlines,reminders,events
pm context --from today --to +7d --limit 10
pm context --section recently_created --section unparented --limit 10
```

`calendar` defaults to markdown for human and agent readability. Other commands default to TOON unless configured otherwise.
For `--include events` without explicit `--to`, `--recurrence-lookahead-days`, or `--occurrence-limit`, recurring expansion is intentionally capped to a bounded default window and emits a warning with retry hints for broader windows.

## Validation and Maintenance

```bash
pm validate --check-resolution --check-history-drift
pm validate --check-files --scan-mode tracked-all
pm validate --check-resolution --fix-hints --json
pm validate --auto-fix --dry-run --json
pm validate --auto-fix --fix-scope lifecycle
pm validate --prune-missing --dry-run --json
pm normalize --dry-run --json
pm gc --dry-run
pm gc --scope locks --dry-run
```

Use dry-run modes before broad lifecycle or cleanup changes.

`pm gc` accepts `--scope` values `index`, `embeddings`, `runtime`, and `locks` (comma-separated or repeatable); with no `--scope` it sweeps all of them. The `runtime` scope clears `runtime/test-runs/` and `runtime/history-drift-cache.json`; removing the drift cache forces the next `pm health` run to perform a full history-drift re-scan. The `locks` scope removes only **expired** lock files in `locks/` — those whose own embedded `created_at + ttl_seconds` has elapsed (debris left by crashed processes). Active locks and any lock file that cannot be parsed are always retained (never deleted when staleness cannot be proven), and the result includes a `locks` summary (`scanned`/`removed`/`retained`).

`--fix-hints` is a read-only flag: each failing check gains `details.fix_hints`, an array of `pm` command templates derived from the warning codes it raised (for example `pm history-repair <id>` for history drift, or `pm update <id> --reviewer "<name>"` for a missing reviewer). Generic hints may contain `<id>`/`<field>`/`<path>` placeholders the agent substitutes from the check's detail rows; the resolution check aliases concrete per-row commands and marks `fix_hints_truncated` when the list is summarized. It never mutates items. The mapping comes from the shared remediation registry that also backs `pm health --json` (see Self-Repair Remediation below), so agents gating on `pm validate` can auto-repair findings without hardcoding warning-code-to-command lookups.

`pm validate --check-metadata` also groups missing-required-field counts per item type in `details.missing_by_type` (for example `{ "Task": { "close_reason": 3 } }`) — counts only, zero-suppressed, and limited to the active metadata profile's required fields, so remediation can be targeted by type without verbose row dumps.

`--auto-fix` applies the safe, deterministic subset of those remediations automatically and reports the result under a top-level `fixes` object (`planned_fixes[]`, `applied_fixes[]`, `gated_fixes[]`, `failed_fixes[]` — each row lists the item id, check, field, and the equivalent standalone `pm` command). Safe means derivable and non-destructive: a closed item missing `resolution` is backfilled from its own `close_reason` (or the `"completed"` default), and a closed item missing `close_reason` is backfilled from its existing `resolution`. Auto-fix NEVER closes, cancels, or deletes items, and every applied fix runs through the normal audited `pm update` path. Structural lifecycle fixes — an active item whose parent is terminal gets reparented to its active grandparent or has its parent link cleared — are always *planned* but only *applied* when the explicit `--fix-scope lifecycle` grant is passed. `--fix-scope` is an exact allowlist of what `--auto-fix` may mutate (`metadata`, `resolution`, `lifecycle`; comma-separated or repeatable) — `--fix-scope lifecycle` alone applies *only* lifecycle fixes; omitting the flag grants the safe field-backfill scopes (`metadata`, `resolution`) and never lifecycle. `--dry-run` previews the full plan without mutating anything. With `--auto-fix` and no explicit `--check-*` flags, only the fix-capable checks (metadata, resolution, lifecycle) run. The `checks` in the output always describe the pre-fix state; re-run `pm validate` to confirm convergence.

`pm validate --check-files` classifies every stale linked path in `details.missing_linked_path_classifications` as either `moved` (a file with the same basename still exists in the scan — the row carries the top relink candidate, e.g. `old/path.md:moved:new/path.md`) or `deleted` (no candidate anywhere, e.g. `old/path.md:deleted`). `--prune-missing` bulk-removes the stale links classified `deleted` from their items (link removal only — real files are never touched; `moved` links are kept so their relink candidates are not lost) and reports each removal in `fixes.applied_fixes[]` as the equivalent `pm files <id> --remove <path>` / `pm docs <id> --remove <path>` command. It honors `--dry-run` and implies `--check-files`.

### Telemetry Local Analytics

`pm telemetry` surfaces local queue/runtime telemetry state without running full health checks:

```bash
pm telemetry status
pm telemetry stats --limit 10
pm telemetry flush
pm telemetry clear
# Legacy-compatible alias for older agent scripts:
pm telemetry local-analytics status
```

- `status` reports queue depth, endpoint, and latest flush metadata.
- `stats` groups queued local telemetry events by command name.
- `flush` runs an immediate local queue flush attempt.
- `clear` disables telemetry and deletes local queue/runtime telemetry artifacts.
- `local-analytics <status|stats|flush|clear>` is accepted as a backward-compatible namespace alias for older scripts; new scripts should use `pm telemetry <subcommand>`.

### Self-Repair Remediation

`pm health --json` annotates every non-extension check whose warnings have a known code with `details.remediation_map`, an object mapping each warning-code prefix to the executable `pm` command that fixes it:

```jsonc
// history_drift check
"remediation_map": { "history_drift_missing_stream": "pm history-repair <id>" }
// vectorization check
"remediation_map": { "vectorization_stale_items_remaining": "pm health --refresh-vectors" }
// locks check
"remediation_map": { "locks_stale_count": "pm gc --scope locks" }
```

When more than one history stream is drifted, the `history_drift` remediation commands are rewritten to `pm history-repair --all` so the whole tree is repaired in one audited pass instead of one command per stream.

`remediation_map` appears in default and `--full` output and is omitted in `--brief`/`--summary` to stay token-efficient. Extension checks keep their existing richer `details.triage.remediation` instead.

`pm health` also runs a read-only `locks` check alongside the storage check: it classifies every file in `locks/` with the exact policy `pm gc --scope locks` acts on and reports `active_lock_count`, `stale_lock_count`, `unreadable_lock_count`, and `unparseable_lock_count` (counts appear in all projection modes; nothing is ever removed). It warns with `locks_stale_count:<n>` when stale locks exist (fix: `pm gc --scope locks`) and `locks_unreadable:<n>` when lock files cannot be read (inspect first: `pm gc --scope locks --dry-run`).

## History and Recovery

```bash
pm history <id> --limit 20
pm history <id> --diff
pm history <id> --diff --field status
pm history <id> --full --diff --verify
pm history-compact <id> --dry-run
pm history-compact <id> --before 25 --message "compact early entries"
pm history-compact <id> --before 2026-06-01T00:00:00.000Z
pm history-redact <id> --literal "[redacted_path_prefix]/private" --replacement "[redacted_path]"
pm history-redact <id> --regex "/192\\.168\\.[0-9.]+/g" --dry-run
pm history-repair <id> --dry-run
pm history-repair <id> --message "re-anchor legacy drift"
pm history-repair --all --dry-run
pm history-repair --all --message "bulk re-anchor drifted streams"
pm activity --id <id> --limit 50
pm activity --full --id <id> --limit 50
pm restore <id> <timestamp-or-version>
```

History is append-only. Restore appends a new restore event instead of rewriting old history.

`--diff` replays the history chain and emits, per entry, a `changes` array of `{ field, before, after }` field-level value transitions (alongside the `changed_fields` name list) — so you can see exactly what each field changed from and to without comparing snapshots. It is independent of the compact/full projection. `--field <name>` narrows the diff to a single field's transitions (implying `--diff`), answering "when did `<field>` change?" — e.g. `pm history <id> --diff --field status`.

`pm stats` reports item and history totals plus per-type/per-status counts. Add `--storage` for aggregate history-stream metrics — `total_streams`, `total_lines`, `total_bytes`, the top streams by size (`largest_by_bytes`) and by depth (`deepest_by_lines`), and the global `oldest_entry`/`newest_entry` — to decide when to compact or redact streams and to plan storage:

```bash
pm stats
pm stats --storage --json
```
`history-redact` rewrites matching history payloads deterministically, recomputes hash chains, and appends an auditable `history_redact` marker entry when changes are applied.
`history-compact` rewrites long streams into a synthetic checkpoint baseline plus a retained tail (`--before` accepts a 1-based version or ISO timestamp), re-anchors hashes, verifies integrity, and appends an auditable `history_compact` marker when applied.
`history-repair` re-anchors a drifted history chain when `pm health`/`pm validate --check-history-drift` report stale hashes: it replays the stream, recomputes every before/after hash, repairs legacy patch ops that no longer strictly apply, reconciles the latest hash with the on-disk item, and appends an auditable `history_repair` marker. It never modifies item content and is a safe no-op on a clean stream.
`history-repair --all` (mutually exclusive with `<id>`) runs the same drift scan `pm health` uses and applies the audited single-stream repair (ownership check, lock, post-repair no-drift verification, `--message` audit marker, per-stream `--force`) to every drifted stream in one pass. One failing stream never aborts the rest: the result lists one compact row per drifted stream (`repaired` / `skipped_clean` / `failed`) plus `totals`, and the command exits non-zero only if any stream failed.

## Custom Item Types

Tracker references: [pm-qq69](../.agents/pm/features/pm-qq69.toon), [pm-1lkm](../.agents/pm/features/pm-1lkm.toon).

`pm schema` inspects and manages the runtime item-type registry. `list` and `show` include built-in, custom, and extension-provided types so agents can confirm project context before creating work. `add-type` registers a config-driven custom item type so agents can use `pm create <Type> "..."` for project-specific work categories without editing settings by hand. Custom definitions are merged from `.agents/pm/schema/types.json` (shape: `{ "definitions": [ItemTypeDefinition...] }`). Custom statuses are managed with `show-status`/`add-status`/`remove-status` and persist in `.agents/pm/schema/statuses.json` (shape: `{ "statuses": [RuntimeStatusDefinition...] }`).

```bash
pm schema list
pm schema show Task
pm schema show-status open
pm schema add-type Spike --description "Time-boxed investigation" --default-status open
pm schema add-type Spike --alias spike --alias research --folder spikes
pm schema remove-type Spike
pm schema add-status review --role active --alias in_review --description "Awaiting review" --order 25
pm schema remove-status review
pm create Spike "Investigate retry backoff"
```

- `pm schema list --json` returns `{ builtin, custom, extension, counts, statuses: { builtin, custom, counts } }` for compact machine parsing. Each status entry includes `id`, `source` (`builtin`/`custom`), `roles`, and `aliases`.
- `pm schema show <Type> --json` returns the resolved definition, including folder, aliases, default status, required create options, type options, command-option policies, and extension provenance when applicable.
- `pm schema show-status <id> --json` returns one resolved status definition (builtin or custom) including `id`, `source`, `roles`, `aliases`, optional `description`, and optional `order`. Status aliases resolve automatically.
- `add-type` is an idempotent UPSERT keyed on the type name (case-insensitive); re-running it merges aliases and overrides supplied fields while preserving everything else.
- `remove-type <Name>` removes a custom type definition (case-insensitive). Built-in types are refused. It WARNS (non-blocking) with `items_using_type:<N>` when items of that type still exist, then removes the definition.
- `add-status <id>` writes a custom lifecycle status (idempotent UPSERT keyed on the normalized id; re-adding sets `replaced: true`). Roles are validated against the runtime status roles: `draft`, `active`, `blocked`, `terminal`, `terminal_done`, `terminal_canceled`, `default_open`, `default_close`, `default_cancel`.
- `remove-status <id>` removes a custom status. The five built-in default statuses (`open`, `in_progress`, `blocked`, `closed`, `canceled`, plus `draft`) are refused. It WARNS (non-blocking) with `items_using_status:<N>` when items currently use that status.
- Built-in types (Chore, Decision, Epic, Event, Feature, Issue, Meeting, Milestone, Plan, Reminder, Task) are reserved and cannot be redefined or removed.
- Flags: `--description <text>`, `--default-status <status>`, `--folder <dir>`, `--alias <name>` (repeatable), `--role <value>` (repeatable; add-status), `--order <n>` (add-status), plus `--author`/`--force` governance flags. Add `--json` for the machine envelope.
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
pm plan create --title "Fix flaky retry test" --step "Read lock.ts" --step "Write the fix" --step "Run the tests"
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
- `create` accepts repeated `--step <title>` flags to seed ordered steps in argv order (values are never comma-split). When `--step-title` is also given it becomes the first step. Per-step detail flags (`--step-body`, `--step-status`, `--file`, ...) apply to a single initial step only; combining them with multiple `--step` values is a usage error — create the plan first, then refine steps with `add-step`/`update-step`. On step subcommands a single `--step` value still aliases `--step-title`.
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
