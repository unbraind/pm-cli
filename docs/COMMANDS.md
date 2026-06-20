# Command Reference

This is a task-oriented command guide. For exact flags, use runtime help because extensions and settings can change the active surface:

Tracked implementation updates: [pm-52eh](../.agents/pm/features/pm-52eh.toon), [pm-mcxr](../.agents/pm/issues/pm-mcxr.toon).

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
| Triage | `context`, `search`, `get`, `list*`, `aggregate`, `dedupe-audit`*, `dedupe-merge`* | find work, read a single item, and audit decomposition |
| Lifecycle | `create`, `copy`, `focus`, `claim`, `update`, `append`, `close`, `release`, `delete`, `start-task`, `pause-task`, `close-task` | mutate item state |
| Bulk | `update-many`, `close-many` | apply one change across a matched, dry-run-previewed set with a rollback checkpoint |
| Scheduling | `meet`, `event`, `remind` | low-friction Meeting/Event/Reminder creation |
| Planning | `plan create`, `plan add-step`, `plan update-step`, `plan complete-step`, `plan link`, `plan approve`, `plan materialize` | agent-optimized living plans with ordered steps, evidence, decisions, validation, and materialization |
| Logs | `comments`, `notes`, `learnings`, `comments-audit` | record progress and durable context |
| Links | `files`, `docs`, `test`, `deps` | connect items to artifacts, tests, and relationships |
| Verification | `test`, `test-all`, `test-runs`, `validate`, `gc` | run linked tests and repository checks |
| History | `history`, `history-compact`, `history-redact`, `history-repair`, `activity`, `restore`, `stats` | inspect, compact, redact, re-anchor, and recover item state |
| Schema | `schema add-type` / `remove-type` / `add-status` / `remove-status` / `add-field` / `remove-field` / `apply-preset` | manage config-driven custom item types (`.agents/pm/schema/types.json`), statuses (`.agents/pm/schema/statuses.json`), and custom metadata fields (`.agents/pm/schema/fields.json`); `apply-preset` adopts a domain type preset; `add-type --infer` derives types from title-prefix conventions |
| Calendar | `calendar`, `cal` | project deadlines, reminders, and events |
| Packages | `install`, `upgrade`, `package`, `packages`, `extension`, package/extension command groups | install, upgrade, manage, and run package-backed extension commands |
| Machines | `contracts`, `help`, optional `guide`/`completion` | command contracts plus optional guide-shell docs routing and shell helpers |

`*` `dedupe-audit` and `dedupe-merge` are provided by the optional `governance-audit` package (`pm install governance-audit --project`).

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
pm get pm-a1b2                          # read one item; add --fields/--depth for lower-token projections
pm get pm-a1b2 --tree --tree-depth 2    # item plus its descendant subtree
pm list-open --type Task --priority 1 --limit 20
pm list-in-progress --limit 20
pm aggregate --group-by parent,type --status open
pm aggregate --group-by parent,type --completion --include-unparented
pm install governance-audit --project   # if dedupe-audit / dedupe-merge are not available
pm dedupe-audit --mode parent_scope --limit 20
pm dedupe-merge --keep pm-canonical --close pm-duplicate --dry-run
```

Use `context` first for a compact active-work snapshot. Use `search` when the request names a concept, component, or prior issue.
Use `pm get <id>` to read a single item by ID — the single-item read primitive used throughout the agent loop. It accepts `--fields <list>` and `--depth brief|standard|deep|full` for token-minimal projections, and `--tree`/`--tree-depth <n>` to include descendants. `pm get <id> --json` returns the `body` inside the `item` object (`.item.body`); see [Full results, totals, and bodies](#full-results-totals-and-bodies). To duplicate an existing item as a starting point, `pm copy <id> --title "New title"` clones it into a fresh id with lifecycle fields reset.
`context` standard/deep views include high-level child completion counters plus `recently_created` and `unparented` sections, so agents can spot new orphan work before creating duplicates.
Use `pm aggregate --completion` when you need per-group `open`, `in_progress`, `closed`, `other`, and `completion_pct` progress context.
Each aggregate row carries an explicit `group_label`: a blank/null group value (e.g. unassigned items under `--group-by assignee`) renders as `(unassigned)`/`(untagged)`/`(unparented)` rather than an ambiguous empty key, while the structured `group` value keeps the raw `null` for machine consumers. Multi-field grouping joins each `field=value` pair into the label.

`--sort` accepts `priority|deadline|updated_at|created_at|title|parent`, plus the convenience aliases `updated` (→ `updated_at`) and `created` (→ `created_at`):

```bash
pm list-all --sort updated --order desc
```

### Incremental "what changed since" filters

Every `list*` command accepts `--updated-after`/`--updated-before`/`--created-after`/`--created-before`. `pm search` now supports the SAME filter surface as `pm list` (full parity): `--status`, `--type`, `--tag`, `--priority`, `--deadline-before`/`--deadline-after`, `--updated-after`/`--updated-before`, `--created-after`/`--created-before`, `--assignee`, `--sprint`, `--release`, and `--parent`, all with identical semantics. These keep a long-running agent's context focused on the slice it cares about instead of re-scanning the whole tracker:

```bash
# Items touched since my last context window (feed back the previous run's `now`)
pm list-all --updated-after 2026-06-04T15:18:32Z --brief

# Relative offsets are SIGNED: -2h/-7d reach into the past, +1d into the future.
# Units are h/d/w/m (m = months — there is no minutes unit).
pm list-open --updated-after=-2h --brief
pm list-all --created-after=-7d --status open

# Search scoped to open work only (drops closed-history noise); statuses accept
# all (no lifecycle restriction), open/closed/canceled aliases, or configured
# ids, comma-separated, with a did-you-mean hint on typos.
pm search "reminder validation" --status open --limit 10

# Duplicate checks can deliberately scan every lifecycle bucket with one flag.
pm search "reminder validation" --status all --limit 10

# Full filter parity with list — scope retrieval before ranking.
pm search "calendar" --type Task --assignee alice --updated-after=-7d --parent pm-abcd
```

`pm get`, `pm history`, and `pm search` also accept command-local `--format json|toon`. `--format json` is equivalent to the global `--json` flag for that command, while `--format toon` keeps the default agent-readable output. Do not combine global `--json` with `--format toon`.

`list`/`search` full and fields projections echo full filter metadata. Compact mode emits only active filters (plus runtime schema filters when present) and omits the default projection/sorting/now trailer keys for lower token cost.

### Keyword relevance control (GH-181)

`pm search` ranks keyword hits by a weighted score and returns them sorted (highest first). Three controls tune matching and result volume:

- `--match-mode <and|or|exact>` — `or` (default) matches an item if ANY query token appears, but multi-token queries get an additive ALL-TERMS ranking bonus so items covering every token outrank partial matches. `and` HARD-FILTERS to items where every distinct token matched some field. `exact` requires the full normalized query to appear as a contiguous phrase (same as `--phrase-exact`).
- `--min-score <float>` — per-query minimum score threshold (finite, `>= 0`). Overrides the persistent `search.score_threshold` setting for this query only; the effective value is echoed in `filters.score_threshold`.
- `--count` — return ONLY the match count (post-filter, post-threshold, pre-limit) with no hit rows. Token-efficient for "how many" questions; the response sets `count_only: true` and `count`/`total` to the matched total.

Keyword mode now applies the configured `search.max_results` default (50) when `--limit` is omitted, so a broad query no longer returns every hit. When the limit drops rows the result adds a top-level `total` (pre-limit match count).

```bash
pm search "reminder validation queue" --match-mode and          # require all three tokens
pm search "exact title phrase" --match-mode exact               # contiguous-phrase match
pm search "calendar" --min-score 5                              # this-query threshold override
pm search "reminder" --count                                    # just the number
```

### Inline filter syntax and matched-text highlighting (GH-157, pm-ldr1)

Inline `field:value` tokens can be embedded directly in the query string and are parsed out as the equivalent filter. Recognized fields are `tag:`, `status:`, `type:`, and `priority:`; the value runs to the end of the token, so colon-bearing values like `tag:area:search` parse correctly. The remaining words drive keyword/semantic matching as usual:

```bash
pm search "auth tag:area:auth status:open"        # query "auth" + --tag area:auth --status open
pm search "ranking type:Task priority:1"          # query "ranking" + --type Task --priority 1
```

Precedence: an **explicit `--flag` always wins** over a conflicting inline token. When both are supplied, the flag value is used and the result carries a `search_inline_filter_ignored:<field>:flag_takes_precedence` warning so the override is observable. On the CLI, an unquoted `tag:value` token is already rewritten to `--tag value` by argument normalization; the in-query parser additionally covers quoted multi-word queries and the `pm_search` MCP tool, where the whole query arrives as a single string. A query consisting solely of inline tokens (no keyword terms) is rejected — use `pm list` with the equivalent `--tag`/`--status`/`--type`/`--priority` flags for pure filtering.

Pass `--highlight` to emit per-field matched-text snippets on each hit (off by default for token efficiency). Each matched field gets a `{ field, snippet }` entry under `highlights`, with the matching token runs wrapped in `«…»` and a `…` ellipsis where the field text was windowed:

```bash
pm search "auth" --highlight                       # adds highlights:[{field,snippet}] to each hit
pm search "auth" --full --highlight                # full hit payloads + highlight snippets
```

### Full results, totals, and bodies

`pm list*` returns every matched row when neither `--limit` nor `--offset` is set. When a `--limit`/`--offset` *does* drop rows, the result adds a top-level `total` (the pre-pagination match count) so an agent knows how many remain. Pass `--no-truncate` (alias `--all`) to force the entire matched set and override any `--limit` in one call — the canonical "give me everything" flag for large-corpus audits:

```bash
pm list-all --no-truncate --brief          # every matched row, ignoring any --limit
pm list-open --limit 20 --json             # result.total reports the full count when truncated
```

JSON output is compact by default (id/status/type/title) for token efficiency. To pull item bodies in bulk in a single call — instead of one `pm get` per item — add `--include-body`, which expands each row to the full field set plus `body`:

```bash
pm list-open --json --include-body         # full fields + body for every returned row
```

`pm get <id> --json` returns the item's `body` **inside** the `item` object (i.e. `.item.body`), matching where `list --include-body` places it and the long-form `description`/`acceptance_criteria` fields — so a single read exposes every field at a consistent path. Body is included at the default `standard` depth and above; `--depth brief` omits it.

### Output render formats (`--format`)

`pm list*` accepts `--format <csv|table|json|toon>` to choose how rows render. `csv` and `table` are **human export** modes — pipe them into a spreadsheet or read them directly in a terminal — while `json`/`toon` override the machine output format the same way the global `--json` flag does. The rendered columns follow the active projection, so combine `--format` with `--fields`/`--brief`/`--compact` to control exactly which columns appear:

```bash
pm list-open --format table                      # aligned, monospace-friendly columns
pm list-all --fields id,title,priority --format csv  # spreadsheet export with chosen columns
pm list-open --format csv > backlog.csv          # capture for reporting
```

CSV output is RFC 4180 compliant (values with commas, quotes, or newlines are quoted; array fields such as `tags` join with `;`). `--format csv|table` cannot be combined with `--stream` (which is line-delimited JSON and requires `--json`).

### Missing-metadata filters

Every `list*` command also accepts metadata-presence filters for governance backfill: `--filter-ac-missing` (no `acceptance_criteria`), `--filter-estimates-missing` (no `estimated_minutes`; singular `--filter-estimate-missing` is an alias), `--filter-resolution-missing` (terminal items with no `resolution`), and `--filter-metadata-missing` (the union — missing *any* of those). Specific flags AND together; combine them with any other filter. They surface in the result's `filters` echo (`filter_ac_missing` etc.).

The same `list*` commands and `pm search` extend this with governance-field presence selectors — `--filter-reviewer-missing`, `--filter-risk-missing`, `--filter-confidence-missing`, `--filter-sprint-missing`, and `--filter-release-missing` — each selecting items where that single field is unset.

```bash
# Find open Tasks that still need acceptance criteria
pm list-open --type Task --filter-ac-missing --brief

# Closed items that were never given a resolution
pm list-closed --filter-resolution-missing --json

# Open items that still need a reviewer assigned
pm list-open --filter-reviewer-missing --brief
```

### Content-field presence filters

`list*` and `pm search` also accept paired presence/absence selectors for each content field, so you can scope to items that *have* a given field populated or that are *missing* it: `--has-notes`/`--no-notes`, `--has-learnings`/`--no-learnings`, `--has-files`/`--no-files`, `--has-docs`/`--no-docs`, `--has-tests`/`--no-tests`, `--has-comments`/`--no-comments`, `--has-deps`/`--no-deps`, `--has-body`/`--empty-body`, and `--has-linked-command`/`--no-linked-command`. Requesting both the present and absent variant for the same field is a usage error. Multiple content filters AND together and compose with any other filter.

```bash
# Closed items that shipped no documented learnings
pm list-closed --no-learnings --brief

# Open work that has linked tests but no linked files yet
pm list-open --has-tests --no-files --json
```

## Bulk Operations

`update-many` and `close-many` apply one change across a matched set with a dry-run preview and a rollback checkpoint. Both share the `--filter-*` scoping family (`--filter-status/-type/-tag/-priority/-sprint/-release/-parent/-assignee/-deadline-before|after/-updated-after|before/-created-after|before`) plus `--ids` for an explicit comma-separated allowlist intersected with the other filters. `update-many` additionally accepts the missing-metadata selectors `--filter-ac-missing`/`--filter-estimates-missing`/`--filter-resolution-missing`/`--filter-metadata-missing` for bulk metadata backfill.

Both `update-many` and `close-many` also accept the governance-field selectors `--filter-reviewer-missing`/`--filter-risk-missing`/`--filter-confidence-missing`/`--filter-sprint-missing`/`--filter-release-missing` and the content-field presence selectors under the `--filter-` prefix: `--filter-has-notes`/`--filter-no-notes`, `--filter-has-learnings`/`--filter-no-learnings`, `--filter-has-files`/`--filter-no-files`, `--filter-has-docs`/`--filter-no-docs`, `--filter-has-tests`/`--filter-no-tests`, `--filter-has-comments`/`--filter-no-comments`, `--filter-has-deps`/`--filter-no-deps`, `--filter-has-body`/`--filter-empty-body`, and `--filter-has-linked-command`/`--filter-no-linked-command`. These mirror the list/search presence filters and intersect with the rest of the scoping family, so you can bulk-select (for example) closed Tasks with no documented learnings before applying a change.

```bash
# Bulk metadata update by explicit id allowlist (compose with search --json | jq)
pm update-many --ids pm-a,pm-b,pm-c --priority 1 --dry-run
pm update-many --filter-tag wave:7 --reviewer maintainer-review

# Bulk-backfill a placeholder estimate onto open Tasks that have none
pm update-many --filter-status open --filter-type Task --filter-estimates-missing --estimate 60 --dry-run

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

For long markdown bodies (multi-paragraph specs with code blocks or tables), load the body from a file with `--body-file <path>` on both `pm create` and `pm update` instead of escaping a huge inline `--body` string or issuing a second `pm append`:

```bash
pm create Feature "Search relevance overhaul" --body-file ./specs/search-relevance.md
pm update pm-a1b2 --body-file ./specs/updated-spec.md
```

`--body-file` is mutually exclusive with `--body` (passing both errors). Use `--body -` to read the body from piped stdin.

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

For audit evidence on an item owned by another agent, `pm update --allow-audit-update`
can make non-lifecycle metadata updates and append comments, linked files, and linked
docs in one audited history entry. It is intentionally append-only for evidence:
lifecycle/ownership fields, dependencies, tests, notes, learnings, reminders, events,
and all clear/replace operations stay restricted or use their dedicated commands.

```bash
pm update <id> \
  --allow-audit-update \
  --comment "Audit evidence: reproduced in staging" \
  --file "path=src/cli/commands/update.ts,scope=project,note=audit evidence" \
  --doc "path=docs/COMMANDS.md,scope=project,note=user-facing behavior" \
  --message "Append audit evidence"
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

`pm close` accepts short aliases for the common flags: `-m` (`--message`), `-r` (`--reason`), and `-d` (`--duplicate-of`). When `governance.require_close_reason` is enabled and no positional/`--reason` text is given, the close reason is derived from the next-best signal in priority order — explicit reason text, then `--duplicate-of` (`Duplicate of <id>`), then `--resolution` — so a single `pm close <id> --resolution "<summary>"` no longer hard-blocks. The resolution is still written to the item's `resolution` field.

When closing a blocker, `pm close` scans reverse `blocked_by` edges and auto-unblocks dependent items only when every resolvable blocker is now terminal. Each unblocked item is updated through the normal audited mutation path, gets an `unblock_note`, and the close result reports compact `auto_unblocked:<id>:resolved_blockers=<ids>` warnings. Items with another active blocker remain blocked.

Over MCP the mutation tools (`pm_create`/`pm_update`/`pm_close`/`pm_run` append/update-many) are compact by default; pass `fullChangedFields=true` to restore the full `changed_fields` delta, or `idOnly=true` for single-item id/status output.

## Focus (session default parent)

`pm focus` sets a session "focused" item so subsequent `pm create` calls default their `--parent` to it — project management is context management, and focus keeps new work attached to the active parent without restating `--parent` every time.

```bash
pm focus pm-epic1     # focus an item (validates it exists)
pm focus              # show the current focus (or a no-focus hint)
pm focus --clear      # clear focus; new items stop inheriting a parent
```

Behavior and guarantees:

- Focus is **session-local**: it is stored in `.agents/pm/runtime/session.json`, which is gitignored, so it never affects teammates or the tracker's git history.
- When a focus is set and `pm create` is run **without** `--parent`, the new item inherits the focused item as its parent and the result includes `"parent_source": "focus"` so agents can see the parent was inherited.
- An explicit `--parent` always overrides focus, including `--parent none` (create with no parent). An explicit but unresolvable focused parent produces the same missing-parent error/warning as an explicit stale `--parent` (it flows through the same `validation.parent_reference` policy).
- `pm focus <id>` validates the item exists and fails fast with a not-found error otherwise. `pm focus --clear <id>` is a usage error (choose either set or clear).

Over MCP the equivalent tool is `pm_focus` (`id` to set, `clear=true` to clear, neither to show current focus).

Tracker references: [pm-72xf](../.agents/pm/features/pm-72xf.toon).

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

After `pm create` of a workable item type, the result includes a non-binding `next_transition` hint (`pm start-task <id>` → `in_progress`) when the workflow defines a distinct in-progress status. This nudges agents to move work through `in_progress` instead of jumping straight from `open` to `closed`. Scheduling/reference types (Event, Meeting, Reminder, Milestone, Decision) never receive the hint. (GH-216)

## Scheduling Shortcuts

Low-friction creation for the scheduling item types so time-based tracking feels native. Each command translates friendly time flags into the canonical `--event`/`--reminder` fields and delegates to `pm create` (parent/focus inheritance, governance, and validation all still apply). The `lightweight` schedule preset is applied so progressive scheduling fields are not demanded up front. (GH-217)

```bash
pm meet "Sprint Planning" --start +1h --duration 1h          # Meeting (start defaults to now, duration to 1h)
pm event "Release v2" --start 2026-07-01T10:00:00Z --duration 2h --location "Room A"
pm remind "Review PR" --at +2d                               # Reminder (--at defaults to +1d, text defaults to the title)
```

- `--start`/`--at`/`--end` accept ISO timestamps, `now`, or relative tokens (`+1h`, `+2d`, `+2w`, `+6m`).
- `pm meet`/`pm event` take `--start`, `--duration` (or `--end`), `--location`, `--timezone`, and `--all-day`; passing `--end` overrides `--duration`.
- `--duration` accepts relative units (`h` hours, `d` days, `w` weeks, `m` months) plus sub-hour forms (`30min`, `PT30M`). Bare `m` remains months for backward compatibility (`45m` = 45 months).
- `pm remind` takes `--at` and `--text` (text defaults to the title).
- Common create flags also apply: `--parent`, `--allow-missing-parent`, `--tags`, `--priority`, `--body`, `--description`, `--author`, `--message`.

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
pm comments <id> --edit 2 "Corrected: the regression was in the parser, not the renderer."
pm comments <id> --delete 3
pm notes <id> --add "Keep renderer changes isolated to TOON output."
pm learnings <id> --add "Use runtime contracts instead of duplicating flag lists."
```

Use comments for progress and evidence, notes for implementation context, and learnings for durable future guidance. For comments, choose exactly one input source (`[text]`, `--add`, `--stdin`, or `--file`) per invocation. To clean up obsolete orchestration notes, `--edit <index>` rewrites the comment at a 1-based index (replacement text from `[text]`/`--add`/`--stdin`/`--file`) and `--delete <index>` removes it; both record history and honor ownership rules (`--allow-audit-comment` for non-owner audits).

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

Structured key/value forms reject unrecognized keys with an `Allowed keys: …` error (matching `test --add`), so a typoed key (`lable=` instead of `label=`) fails fast instead of being silently dropped: `--add`/`--file`/`--doc` accept `path,scope,note`; `--add-glob` accepts `pattern,glob,path,scope,note`; `--remove` accepts `path`; `--migrate` accepts `from,to`; `--dep` accepts `id,kind,type,author,created_at` (plus `source_kind` on update); `--reminder` accepts `at,date,text,title`; `--event` accepts `start,date,end,duration,title,description,location,timezone,all_day` and the `recur_*` recurrence keys. Bare values (`--add src/cli/main.ts`) skip key validation.

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

Linked test commands should be sandbox-safe. Prefer `node scripts/run-tests.mjs ...` for repo-local test suites; normal package-manager scripts such as `pnpm test` and `npm run test` are accepted because linked-test execution injects temporary `PM_PATH` and `PM_GLOBAL_PATH`. Direct runner binaries such as `vitest` or `node --test` still need the wrapper or explicit inline sandbox env. The two-token form `--add command "npm test -- parser"` (and `--add path "..."` / `--remove command "..."`) is accepted when the value is quoted into a single shell argument; it is normalized to `--add command=...` before parsing. Use `--add-json` when command strings contain commas, nested quotes, shell variables, or `--` separators that are awkward to preserve through CSV-style `--add` parsing. `--match`, `--only-index`, and `--only-last` select which linked tests execute without mutating the stored linked-test list.

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
pm context --depth full                  # every section, no per-section row cap
pm context --parent pm-epic1 --depth deep # scope the snapshot to one item's subtree
pm context --fields id,title,priority    # project focus rows to a field subset
```

`pm context --depth full` returns the comprehensive snapshot: every known section
with no per-section row cap (overridable with an explicit `--limit`). `pm context
--parent <id>` scopes the focus items, hierarchy, agenda, and all derived sections
to that item plus its transitive descendants — the "what is the status of this
epic?" view for large trackers.

`pm context --fields <a,b,c>` projects the focus rows (high-level, low-level,
blocked-fallback, recently-created, unparented) to a chosen subset of fields for
low-token reads — the same shaping `pm list --fields` and `pm get --fields`
provide. Selectable fields: `id`, `title`, `type`, `status`, `priority`, `order`,
`deadline`, `assignee`, `tags`, `updated_at`, `parent`, `children_total`,
`children_closed`, `completion_pct`, `created_at`. The projection applies across
the markdown, TOON, and JSON renderings and is also available on the `pm_context`
MCP tool via `options.fields`.

`calendar` defaults to markdown for human and agent readability. Other commands default to TOON unless configured otherwise.
For `--include events` without explicit `--to`, `--recurrence-lookahead-days`, or `--occurrence-limit`, recurring expansion is intentionally capped to a bounded default window and emits a warning with retry hints for broader windows.

## Validation and Maintenance

```bash
pm validate --check-resolution --check-history-drift
pm validate --check-files --scan-mode tracked-all
pm validate --check-resolution --fix-hints --json
pm validate --auto-fix --dry-run --json
pm validate --auto-fix --fix-scope lifecycle
pm validate --auto-fix --fix-scope estimates --dry-run --json
pm validate --prune-missing --dry-run --json
pm normalize --dry-run --json
pm gc --dry-run
pm gc --scope locks --dry-run
```

Use dry-run modes before broad lifecycle or cleanup changes.

`pm gc` accepts `--scope` values `index`, `embeddings`, `runtime`, `locks`, and `checkpoints` (comma-separated or repeatable); with no `--scope` it sweeps all of them. The `runtime` scope clears `runtime/test-runs/` and `runtime/history-drift-cache.json`; removing the drift cache forces the next `pm health` run to perform a full history-drift re-scan. The `embeddings` scope removes the keyword/semantic index artifacts (`search/embeddings.jsonl`, `search/vectorization-status.json`, `search/lancedb/`) **and** the background-refresh queue (`search/pending-refresh.json`) and its gate so a worker draining a stale queue cannot rebuild a partial index against an empty ledger; it invalidates the entire semantic index, so run `pm reindex --mode keyword` (and `--mode semantic` when enabled) afterwards. The `locks` scope removes only **expired** lock files in `locks/` — those whose own embedded `created_at + ttl_seconds` has elapsed (debris left by crashed processes). Active locks and any lock file that cannot be parsed are always retained (never deleted when staleness cannot be proven), and the result includes a `locks` summary (`scanned`/`removed`/`retained`).

The `checkpoints` scope prunes bulk-mutation rollback checkpoints under `checkpoints/` (written by `pm update-many`/`pm close-many`) that are older than `checkpoints.retention_days` (default 14; set via `pm config <scope> set checkpoints_retention_days <n>`). Checkpoints whose `created_at` cannot be parsed are retained (safety-first, like the locks sweep), and the result includes a `checkpoints` summary (`scanned`/`removed`/`retained`/`retention_days`). Removing aged checkpoints permanently closes their `--rollback` window.

`--fix-hints` is a read-only flag: each failing check gains `details.fix_hints`, an array of `pm` command templates derived from the warning codes it raised (for example `pm history-repair <id>` for history drift, or `pm update <id> --reviewer "<name>"` for a missing reviewer). Generic hints may contain `<id>`/`<field>`/`<path>` placeholders the agent substitutes from the check's detail rows; the resolution check aliases concrete per-row commands and marks `fix_hints_truncated` when the list is summarized. It never mutates items. The mapping comes from the shared remediation registry that also backs `pm health --json` (see Self-Repair Remediation below), so agents gating on `pm validate` can auto-repair findings without hardcoding warning-code-to-command lookups.

`pm validate --check-metadata` also groups missing-required-field counts per item type in `details.missing_by_type` (for example `{ "Task": { "close_reason": 3 } }`) — counts only, zero-suppressed, and limited to the active metadata profile's required fields, so remediation can be targeted by type without verbose row dumps.

By default the human view caps each diagnostic `*_item_ids` list at 5 entries and sets the matching `*_truncated` flag. `--json` **never** truncates those lists (machine consumers always receive the complete arrays), and `--all-affected-ids` (equivalent to `--verbose-diagnostics`) emits the full lists in human mode too — so bulk remediation can pipe every affected id straight into `pm update-many`:

```bash
pm validate --check-metadata --all-affected-ids
pm validate --check-metadata --json | jq -r '.checks[] | select(.name=="metadata") | .details.missing_acceptance_criteria_item_ids[]'
```

`--auto-fix` applies the safe, deterministic subset of those remediations automatically and reports the result under a top-level `fixes` object (`planned_fixes[]`, `applied_fixes[]`, `gated_fixes[]`, `failed_fixes[]` — each row lists the item id, check, field, and the equivalent standalone `pm` command). Safe means derivable and non-destructive: a closed item missing `resolution` is backfilled from its own `close_reason` (or the `"completed"` default), and a closed item missing `close_reason` is backfilled from its existing `resolution`. Auto-fix NEVER closes, cancels, or deletes items, and every applied fix runs through the normal audited `pm update` path. Two scopes are opt-in. Structural lifecycle fixes — an active item whose parent is terminal gets reparented to its active grandparent or has its parent link cleared — are always *planned* but only *applied* under an explicit `--fix-scope lifecycle`. Estimate backfills — an item missing `estimated_minutes` gets a config-driven per-type default — are likewise *planned* but only *applied* under `--fix-scope estimates` (estimates are heuristic per-type guesses, not derived facts, so they are never auto-granted). The defaults are `Epic`/`Milestone` 2880, `Feature`/`Story` 480, `Task`/`Plan` 120, `Issue`/`Bug` 60, `Chore` 30, `Decision` 15, and a 120-minute fallback for any other type; override them per type with the `validation.estimate_defaults_by_type` setting (a `{ "<Type>": <minutes> }` map). `--fix-scope` is an exact allowlist of what `--auto-fix` may mutate (`metadata`, `resolution`, `estimates`, `lifecycle`; comma-separated or repeatable) — `--fix-scope estimates` alone applies *only* estimate fixes; omitting the flag grants the safe field-backfill scopes (`metadata`, `resolution`) and neither estimates nor lifecycle. `--dry-run` previews the full plan without mutating anything. With `--auto-fix` and no explicit `--check-*` flags, only the fix-capable checks (metadata, resolution, lifecycle) run. The `checks` in the output always describe the pre-fix state; re-run `pm validate` to confirm convergence.

> Note: acceptance-criteria gaps are intentionally **not** auto-fixed. Unlike resolution/close_reason (derivable from the item's own fields) or estimates (a config-driven type default), acceptance criteria have no deterministic source — synthesizing them from the description would fabricate content rather than derive it, violating the auto-fix safety invariant. They remain `--fix-hints`-only.

`pm validate --check-lifecycle` detects dependency cycles from explicit dependency edges, scalar `blocked_by` item ids, and exact pm-id references in `definition_of_ready`. That catches logical deadlocks such as A blocked by B while B's readiness text names A; `--dependency-cycle-severity off|warn|error` still controls whether those cycles warn, error, or remain informational in details.

`pm validate --check-files` classifies every stale linked path in `details.missing_linked_path_classifications` as either `moved` (a file with the same basename still exists in the scan — the row carries the top relink candidate, e.g. `old/path.md:moved:new/path.md`) or `deleted` (no candidate anywhere, e.g. `old/path.md:deleted`). It also reports `details.missing_linked_path_rows` — owner attribution so cleanup is evidence-based without a reverse lookup. By default these are token-efficient one-liners (`<path>:<classification> owner=<id> status=<status> field=<files|docs> title="…"`); `--verbose-file-lists` expands them to the full structured shape (`{ path, classification, items: [{ id, type, title, status, field }] }`). Orphaned existing files get the same treatment through `details.orphaned_path_classifications` and `details.orphaned_path_rows`; classifications start with `docs_unowned`, `tests_unowned`, `source_unowned`, or `unlinked_existing`, and rows include a concrete `pm docs|files <id> --add ...` hint when a likely owner is found from nearby linked paths. `--prune-missing` bulk-removes the stale links classified `deleted` from their items (link removal only — real files are never touched; `moved` links are kept so their relink candidates are not lost) and reports each removal in `fixes.applied_fixes[]` as the equivalent `pm files <id> --remove <path>` / `pm docs <id> --remove <path>` command. It honors `--dry-run` and implies `--check-files`.

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
- `stats` groups queued local telemetry events by command name. Each bucket also reports an always-available, zero-network performance and outcome signal derived from the bucket's `command_finish` payloads: latency percentiles (`duration_p50_ms`, `duration_p95_ms`, `duration_max_ms`, nearest-rank, present only when a finish event carries a finite `duration_ms`), success/failure tally (`ok_count`, `error_count`, `error_rate`; a finish event whose `ok` is missing or not strictly `true` is counted conservatively as an error), and `command_resolution_counts` (resolution → count, present only when non-empty). `command_start`/`command_error` events are excluded from these aggregates.
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
pm history-compact --all-over 500 --dry-run
pm history-compact --closed --message "compact closed-item streams"
pm history-compact --ids pm-a1b2,pm-c3d4 --dry-run
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
pm stats --metadata-coverage --json
pm stats --field-utilization --json
pm stats --by-assignee --by-priority
pm stats --by-tag --tag-prefix domain: --json
```
For governance dashboards, `--metadata-coverage` adds a `metadata_coverage` block reporting per-field `present`/`applicable`/`percent` for `acceptance_criteria`, `estimated_minutes`, `resolution`, `tags`, and `parent` — overall and `by_type` (resolution coverage is scoped to terminal items, its only applicable population). `--field-utilization` adds a `field_utilization` block reporting `present`/`total`/`percent` for each content field (`notes`, `learnings`, `files`, `docs`, `tests`, `comments`, `deps`, `body`, `linked_command`) across all items, so under-documented content dimensions are visible at a glance and pair naturally with the `--has-*`/`--no-*` list filters for drill-down. `--by-assignee`, `--by-tag`, and `--by-priority` add a `breakdowns` block with lifecycle-bucketed rows (`open`/`in_progress`/`blocked`/`draft`/`closed`/`canceled`/`other` + `total`) per group; blank keys render an explicit `(unassigned)`/`(untagged)` label. `--by-tag` accepts `--tag-prefix` to restrict counting to a tag namespace (for example `domain:`). All of these sections are gated behind their flags so the default `pm stats` stays token-light; the per-status/per-type distributions (already in `by_status`/`by_type`) zero-fill every configured state so underutilized lifecycle states and item types are visible at a glance.
`history-redact` rewrites matching history payloads deterministically, recomputes hash chains, and appends an auditable `history_redact` marker entry when changes are applied.
`history-compact` rewrites long streams into a synthetic checkpoint baseline plus a retained tail (`--before` accepts a 1-based version or ISO timestamp), re-anchors hashes, verifies integrity, and appends an auditable `history_compact` marker when applied.
`history-compact` bulk mode (mutually exclusive with a positional `<id>`) compacts many streams in one audited pass. Select with `--ids <a,b,c>` (an explicit list — used on its own, not combined with the scan selectors below), or a scan: `--all-over <N>` (every stream with more than N entries) and/or a lifecycle filter `--closed` (terminal items only) or `--all-streams` (every stream). `--closed` and `--all-streams` are mutually exclusive. `--min-entries <N>` (default 3) skips already-compact streams; when `history.compact_policy` is enabled and `--all-over` is omitted, the policy's `max_entries` becomes the default threshold. `--before` is single-id only and is rejected in bulk mode. Each selected stream runs the same single-item compaction; one failing stream never aborts the rest — the result reports `totals` (`streams_considered`/`selected`/`items_compacted`/`items_skipped`/`items_errored`) plus one row per stream (`compacted`/`skipped` with a `skip_reason`/`errored`), and the command exits non-zero only if any stream errored.
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
pm schema add-field severity_level --type string --commands create,update --description "Bug severity" --required-on-create
pm schema list-fields
pm schema show-field severity_level
pm schema remove-field severity_level
pm schema apply-preset agile
pm schema add-type --infer --min-count 10
pm schema add-type --infer --apply
pm create Spike "Investigate retry backoff"
```

- `pm schema list --json` returns `{ builtin, custom, extension, counts, statuses: { builtin, custom, counts }, fields: { custom, counts } }` for compact machine parsing. Each status entry includes `id`, `source` (`builtin`/`custom`), `roles`, and `aliases`; each field entry includes `key`, `type`, `commands`, `cli_flag`, `cli_aliases`, and the required/allow_unset flags.
- `pm schema show <Type> --json` returns the resolved definition, including folder, aliases, default status, required create options, type options, command-option policies, and extension provenance when applicable.
- `pm schema show-status <id> --json` returns one resolved status definition (builtin or custom) including `id`, `source`, `roles`, `aliases`, optional `description`, and optional `order`. Status aliases resolve automatically.
- `add-type` is an idempotent UPSERT keyed on the type name (case-insensitive); re-running it merges aliases and overrides supplied fields while preserving everything else.
- `remove-type <Name>` removes a custom type definition (case-insensitive). Built-in types are refused. It WARNS (non-blocking) with `items_using_type:<N>` when items of that type still exist, then removes the definition.
- `add-status <id>` writes a custom lifecycle status (idempotent UPSERT keyed on the normalized id; re-adding sets `replaced: true`). Roles are validated against the runtime status roles: `draft`, `active`, `blocked`, `terminal`, `terminal_done`, `terminal_canceled`, `default_open`, `default_close`, `default_cancel`.
- `remove-status <id>` removes a custom status. The five built-in default statuses (`open`, `in_progress`, `blocked`, `closed`, `canceled`, plus `draft`) are refused. It WARNS (non-blocking) with `items_using_status:<N>` when items currently use that status.
- Built-in types (Chore, Decision, Epic, Event, Feature, Issue, Meeting, Milestone, Plan, Reminder, Task) are reserved and cannot be redefined or removed.
- `add-field <key>` registers a custom metadata field in `.agents/pm/schema/fields.json` (shape: `{ "fields": [RuntimeFieldDefinition...] }`). Each custom field dynamically registers a CLI flag on create/update (and any other commands you list) so projects can capture typed project-specific metadata without hand-editing JSON. It is an idempotent UPSERT keyed on the normalized key, and refuses keys that shadow a built-in field. `list-fields` / `show-field <key>` inspect registered fields; `remove-field <key>` drops one and WARNS (non-blocking) with `items_using_field:<N>` when items still carry a value. See [CONFIGURATION.md](CONFIGURATION.md) for the full `schema/fields.json` format.
- `apply-preset <agile|ops|research>` batch-registers a domain type preset into an already-initialized project (the same vocabulary `pm init --type-preset` seeds); it is idempotent (re-running reports `replaced` entries) and shares its definitions with init.
- `add-type --infer` scans existing item titles for stable `PREFIX-`/`PREFIX:` conventions and proposes them as custom types. It previews candidates by default (dry-run); pass `--apply` to register the non-shadowing candidates and `--min-count <n>` to tune the per-prefix threshold (default 10). Candidates whose name resolves to a built-in type are reported and skipped.
- Field flags (`add-field`): `--type <string|number|boolean|string_array>`, `--commands <list>` (repeatable/comma; defaults to create,update), `--cli-flag <flag>`, `--alias <flag>` (extra CLI flag aliases), `--required`, `--required-on-create`, `--no-allow-unset`, `--required-types <list>`.
- Flags: `--description <text>`, `--default-status <status>`, `--folder <dir>`, `--alias <name>` (repeatable), `--role <value>` (repeatable; add-status), `--order <n>` (add-status), plus `--author`/`--force` governance flags. Add `--json` for the machine envelope.
- When `pm create`/`pm update` reject an unknown type, the error now points back here: `To register a custom type, run: pm schema add-type "X" (writes .agents/pm/schema/types.json).`

`pm init --type-preset agile|ops|research` registers common domain types during initialization:

- `agile`: Story, Spike
- `ops`: Incident, Runbook
- `research`: Experiment, Hypothesis

The option composes with `--defaults`, `--preset`, `--author`, `--agent-guidance`, and `--with-packages`; re-running it is idempotent and reports `registered_type_preset` in JSON output. Already-initialized projects can adopt the same presets without re-running init via `pm schema apply-preset agile|ops|research`.

## Plan Workflow

`pm plan` is the agent-optimized planning loop built on the first-class `Plan` item type. Plans persist ordered steps, evidence, decisions, discoveries, validation, and resume context. Each mutation appends a history entry; full hash-chain replay is preserved.

```bash
pm plan create --title "Refactor lock retry" --scope "Improve retry semantics" --harness claude-code --parent pm-epic1 --related pm-rel1,pm-rel2 --claim
pm plan create --title "Fix flaky retry test" --step "Read lock.ts" --step "Write the fix" --step "Run the tests"
pm plan create --title "Investigate release failure" --template bug-investigation
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
- `create --template <name>` seeds ordered pending steps from a built-in template. Available templates are `bug-investigation`, `feature-implementation`, and `refactoring-sprint`; templates cannot be combined with explicit `--step` or `--step-title` values.
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
