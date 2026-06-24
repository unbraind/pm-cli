# Agent Guide

This guide is optimized for coding agents that need to understand and mutate repository work with minimal context.

## Agent Quick Context

Run this before heavy work:

```bash
pm context --limit 10
pm search "<request keywords>" --limit 10
pm list-open --limit 20
pm list-in-progress --limit 20
pm init --agent-guidance status
pm install guide-shell --project
pm guide workflows
```

If a relevant item exists, reuse it. If not, create a parent lineage, then create and claim the child implementation item.
When AGENTS/CLAUDE guidance is missing, use `pm init --agent-guidance add` to inject compact workflow guardrails, or `pm init --agent-guidance skip` to persist an explicit decline.

Tracked documentation work: [pm-u9d0](../.agents/pm/epics/pm-u9d0.toon).

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
  --priority high \
  --comment "author=$PM_AUTHOR,created_at=now,text=Duplicate check evidence: ..."
```

Priority accepts either numeric `0..4` or named aliases `critical`, `high`, `medium`, `low`, and `minimal`.

Repeated singular/plural list flags accumulate, so `--tag a --tag b` is equivalent to `--tags a,b` (same for `--status` and `--fields` on read commands). You no longer have to pre-join values into one comma list, and `list`/`search` accept `--tags` as a never-block alias for the canonical read filter `--tag`.

`--tags` REPLACES the whole tag list. To edit tags without restating the full set, prefer `--add-tags <value>` (adds without replacing) and `--remove-tags <value>` (prunes) on `create`/`update`/`update-many` (both repeatable; CSV or JSON-array). `--remove-tags` is `update`/`update-many` only. Also note `--expected`/`--actual` are short aliases for `--expected-result`/`--actual-result` on these commands, matching `pm close`.

```bash
pm update <item-id> --add-tags urgent,backend   # keep existing tags, add two
pm update <item-id> --remove-tags stale          # drop one, keep the rest
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
pm files <item-id> --add path=src/app.ts,note="entrypoint"
pm files <item-id> --add src/app.ts --note "entrypoint"
pm docs <item-id> --add path=docs/COMMANDS.md,note="public docs"
pm test <item-id> --add command="node scripts/run-tests.mjs test -- tests/unit/app.spec.ts",timeout_seconds=240
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
| The single next action + why | `pm next` (recommended ready item with rationale, plus ranked ready/blocked queues; `--ready-only` for the tightest output) |
| Next ready work in one epic | `pm next --parent <id>` |
| Next work and agenda | `pm context --limit 10` |
| Comprehensive whole-tracker snapshot | `pm context --depth full` (every section, no per-section row cap) |
| Status of one epic/subtree | `pm context --parent <id> --depth deep` |
| Relevant items | `pm search "<keywords>" --limit 10` (keyword hits are score-ranked; keyword mode defaults to 50 results, `result.total` reports the full pre-limit count) |
| Require every query token | `pm search "<keywords>" --match-mode and` (hard-filter; `exact` = contiguous phrase; default `or` adds an all-terms ranking bonus) |
| Just the match count | `pm search "<keywords>" --count` (no hit rows; `count`/`total` carry the matched total) |
| Per-query score threshold | `pm search "<keywords>" --min-score 5` (overrides settings `search.score_threshold` for this query) |
| Every matched row (no cap) | `pm list-all --no-truncate --brief` (alias `--all`; `result.total` reports the full count when a `--limit`/`--offset` truncates) |
| Item bodies in bulk (one call) | `pm list-open --json --include-body` (avoids one `pm get` per item) |
| Open work only | `pm search "<keywords>" --status open` (drops closed-history noise; did-you-mean on typos) |
| Scope search like list | `pm search "<keywords>" --type Task --assignee <name> --parent <id>` (full `pm list` filter parity) |
| Items changed since last window | `pm list-all --updated-after <prev-run-ISO> --brief` (relative `-2h`/`-7d` also work) |
| Single item | `pm get <id>` |
| Full machine payload | `pm get <id> --full --json` |
| Command flags | `pm <command> --help --json` |
| Low-noise machine contracts | `pm contracts --command <command> --flags-only --json` |
| Semantic index refresh | `pm reindex --mode semantic --progress` (stale-first by default; add `--full` to force full rebuild) |
| Timeline | `pm activity --id <id> --limit 20` |
| Audited history redaction | `pm history-redact <id> --literal "<secret>" --replacement "[redacted]" --dry-run` |
| Audited history re-anchor | `pm history-repair <id> --dry-run` (clears drift flagged by `pm health`/`pm validate`) |
| Register custom item type | `pm schema add-type <Name> --description "<text>" --default-status open` (then `pm create <Name> "..."`) |
| Remove custom item type | `pm schema remove-type <Name>` (warns if items still use it; built-ins refused) |
| Register custom status | `pm schema add-status <id> --role <active\|terminal\|...> --alias <name> --order <n>` |
| Remove custom status | `pm schema remove-status <id>` (warns if items use it; built-in statuses refused) |
| Agent plan create | `pm plan create --title "<scope>" --harness claude-code --scope "<short>" --claim` |
| Agent plan create with steps | `pm plan create --title "<scope>" --step "<step 1>" --step "<step 2>" --step "<step 3>"` (repeated `--step` seeds ordered steps) |
| Agent plan step update | `pm plan update-step <plan-id> plan-step-001 --step-status in_progress --step-evidence "<short>"` |
| Agent plan read | `pm plan show <plan-id> --depth brief` (or `--fields id,title,steps_summary`) |
| Materialize plan steps | `pm plan materialize <plan-id> --steps plan-step-002 --materialize-type Task` |
| Dependencies | `pm deps <id> --format tree` |
| Bulk update by id allowlist | `pm update-many --ids pm-a,pm-b --priority 1 --dry-run` (preview, then drop `--dry-run`) |
| Audited bulk close (sprint closeout) | `pm close-many --filter-sprint <s> --reason "<text>" --dry-run` (full `pm close` semantics per item; `--rollback <id>` to undo) |
| Local docs routing | `pm install guide-shell --project`, then `pm guide <topic>` |
| Compact mutation echo | `pm --no-changed-fields create "..."` (drops the redundant `changed_fields` array, keeps `changed_field_count`) |
| Minimal mutation echo | `pm --id-only create "..."` (prints only id and status for single-item mutations) |
| Duplicate close | `pm close <duplicate> --duplicate-of <canonical>` (or `-d <canonical>`) |
| Long body from a file | `pm create <Type> "<title>" --body-file ./spec.md` (also on `pm update`; mutually exclusive with `--body`) |
| Close with short flags | `pm close <id> -r "<reason>"` / `-m "<history msg>"` / `-d <canonical>` |
| Close via resolution only | `pm close <id> --resolution "<summary>"` (used as the close reason when one is required) |

Default TOON output is preferred for model-readable loops. Use `--json` only when strict parsing is needed.

`list`/`search` compact mode is intentionally token-light: it returns compact items plus only active filters (and runtime schema filters when present), omitting default projection/sorting/now trailer metadata.

Over MCP the mutation tools (`pm_create`/`pm_update`/`pm_append`/`pm_close`, and `pm_run` for `update-many`) are already compact by default: they return `changed_field_count` instead of the full `changed_fields` array. Pass `fullChangedFields=true` only when you need the explicit field-level delta, or `idOnly=true` for single-item id/status output.

`pm create --parent <id>` fails fast when the parent cannot be found. Use `--allow-missing-parent` only for deliberate imports or staged backlog reconstruction.

## Guide Routing for Agents

Use the canonical [guide topic map](README.md#guide-topic-map) when local in-CLI documentation routing is useful.

## Ownership Rules

- Claim before heavy edits.
- `pm claim <id>` can take over non-terminal work from another owner.
- Use `--force` only for explicit override paths.
- For append-only audit comments on another owner item, use `pm comments --allow-audit-comment`.
- To append audit evidence in one item update, use `pm update --allow-audit-update` with non-lifecycle metadata plus append-only `--comment`, `--file`, and `--doc`; use dedicated commands for tests, notes, learnings, lifecycle changes, and clear/replace operations.
- Release when pausing, handing off, or after close.

## Documentation Rules for Agents

- Keep [README](../README.md) short.
- Put details in focused docs under `docs/`.
- Keep reusable workflow prompts in `.agents/skills/*` and route via `pm guide skills` after `guide-shell` is installed.
- Use relative links such as `[Command Reference](COMMANDS.md)`.
- Add tracker references near the top of new docs when a task created the change.
- Link docs back to the active item with `pm docs`.
- Do not link public docs to ignored local operations artifacts or private evidence logs.

## Safe Defaults

Use these defaults unless the task requires otherwise:

- `PM_AUTHOR=<stable-agent-name>` for mutations.
- `node scripts/run-tests.mjs test` and `node scripts/run-tests.mjs coverage` for tests.
- `pm validate --check-resolution --check-history-drift` before closing broad work.
- `pm history-redact <id> --dry-run` before rewriting sensitive history payloads, then rerun without `--dry-run` once scope is confirmed.
- `pm history-repair <id> --dry-run` when `pm health` or `pm validate --check-history-drift` report drifted streams; it re-anchors the hash chain and reconciles with the on-disk item without touching item content. Rerun without `--dry-run` to apply.
- `pm schema list` and `pm schema show <Type>` before creating custom-domain work; they show built-in, persisted custom, and extension-provided item types without reading schema files by hand.
- `pm schema add-type <Name>` when `pm create`/`pm update` reject a project-specific type as invalid; it registers the type in `.agents/pm/schema/types.json` so `pm create <Name> "..."` works. Built-in types are reserved; the upsert is idempotent. `pm schema remove-type <Name>` removes a custom type (warns, non-blocking, if items still use it).
- `pm schema add-status <id> --role <role>` / `pm schema remove-status <id>` manage custom lifecycle statuses in `.agents/pm/schema/statuses.json`; roles come from the runtime status-role vocabulary, the upsert is idempotent, and built-in default statuses cannot be removed. `pm schema list` now reports statuses (builtin vs custom) alongside types.
- `pm init --type-preset agile|ops|research` for new projects that should start with domain item types instead of generic tasks only.
- After switching embedding provider/model, run `pm reindex --mode semantic --full` or `pm reindex --mode hybrid --full` to rebuild vectors completely; `pm reindex --mode keyword` ignores `--full` and now warns when ledger identity drift is detected.
- `pm normalize --dry-run --json` before lifecycle metadata cleanups.
- `pm health --check-only` when inspecting repository health without refresh side effects.
- Mistyped command names get a `Did you mean: <command>?` hint, including typos of the executable shortcut aliases — `pm shwo <id>` suggests `get` (the canonical of `show`/`view`), and `pm comemnt` suggests `comments`.

## Self-Repair Remediation

When gating on `pm health` / `pm validate`, read the executable fix command from the output instead of hardcoding a warning-code-to-command mapping:

- `pm health --json` per-check `details.remediation_map` maps each warning-code prefix to a `pm` fix command (for example `{ "history_drift_missing_stream": "pm history-repair <id>" }`). It is present in default/`--full` output and omitted in `--brief`/`--summary`. With more than one drifted stream the history_drift commands point at `pm history-repair --all` (one audited bulk pass) instead of the per-item template.
- `pm health` includes a read-only `locks` check (stale/unreadable/unparseable lock counts using the same classification `pm gc --scope locks` acts on); `locks_stale_count:<n>` remediates via `pm gc --scope locks`, `locks_unreadable:<n>` via `pm gc --scope locks --dry-run`.
- `pm validate --fix-hints` (read-only) adds `details.fix_hints[]` to each failing check — a uniform list of executable `pm` commands for that check's findings.
- `pm validate --auto-fix` applies the safe, deterministic subset of those fixes itself (resolution/close_reason backfills derived from the item's own fields) and reports every action in `fixes.planned_fixes[]` / `applied_fixes[]` (item id + field + equivalent `pm` command). Preview with `--dry-run`. Two scopes are gated (opt-in): structural lifecycle fixes (reparent an active child off a terminal parent, or clear the parent link) behind `--fix-scope lifecycle`, and per-type `estimated_minutes` backfills behind `--fix-scope estimates` (config-driven defaults via `validation.estimate_defaults_by_type`). Gated fixes appear in `planned_fixes[]`/`gated_fixes[]` until granted. `--fix-scope` is an exact allowlist (default: `metadata`, `resolution`), so `--fix-scope estimates` applies only estimate fixes. Acceptance criteria are deliberately hint-only (no deterministic source to derive from). Auto-fix never closes or deletes items.
- `pm validate --check-files` reports `details.missing_linked_path_rows` — owner attribution for every stale linked path (`<path>:<classification> owner=<id> status=… field=files|docs` one-liners by default; `--verbose-file-lists` for the full `{ path, classification, items: [...] }` objects) so an agent can fix the right item without a reverse lookup.
- `pm validate --prune-missing` removes stale linked-file/doc LINKS whose paths classify as `deleted` (no same-basename candidate left in the workspace scan); `moved` paths keep their relink candidate in `details.missing_linked_path_classifications` instead of being pruned. Honors `--dry-run`; never touches real files.

Both draw from the same remediation registry, so an agent can substitute the concrete `<id>` and run the command to auto-repair findings. Extension health checks expose their remediation under `details.triage.remediation` instead. See [Command Reference](COMMANDS.md#self-repair-remediation).
