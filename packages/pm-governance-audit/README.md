# pm-governance-audit

Trackers: [pm-fmy9ih](../../.agents/pm/tasks/pm-fmy9ih.toon), [pm-vjk3](../../.agents/pm/features/pm-vjk3.toon), [pm-mp49](../../.agents/pm/issues/pm-mp49.toon), [pm-v657](../../.agents/pm/issues/pm-v657.toon)

First-party package that restores optional governance audit surfaces in bare-core `pm`.

## Concurrent annotations under strict ownership

Tracked by [pm-nrkjik](../../.agents/pm/issues/pm-nrkjik.toon).

Merge-safe notes preserve independent entries during merging. Strict ownership
still applies to writes. For an approved append across owners, install this
package and use its narrow flag:

```bash
pm package install governance-audit --project
pm notes pm-example "Review observation" --allow-audit-comment
```

The same flag works for `comments` and `learnings`. It permits additions only:
edit and delete still require ownership, and the existing assignee is preserved.
For a non-terminal handoff, the current owner runs `pm release <id>`, then the
new owner runs `pm claim <id>`; claim refuses work still held by another owner.
This changes the assignee;
it is a different operation from appending an observation. Bare `--force` remains
an explicit override requiring approval. Body `append` is not merge-safe and has
no annotation bypass; use a note when the information is an independent event.

## Hooks

The package also registers default-inert `onRead` and `onWrite` hooks as the
first-party governance hook exemplar. Set `PM_GOVERNANCE_AUDIT_HOOK_LOG` to a
JSONL sidecar path to capture compact read/write records:

```bash
PM_GOVERNANCE_AUDIT_HOOK_LOG=.pm-local/governance-hooks.jsonl pm update pm-demo --status closed
```

Records include `kind`, `path`, `scope`, and write metadata such as `op`,
`item_id`, `item_type`, and `changed_fields`. They intentionally omit item
bodies and full before/after snapshots.

## Commands

- `pm item duplicates audit`
- `pm item duplicates merge`
- `pm item audit-comments`
- `pm ops normalize`

The package also augments existing commands with audit-only flags:

- `pm files <id> --audit` and `pm docs <id> --audit`
- `pm update` / `pm update-many`: `--allow-audit-update`, `--allow-audit-dep-update`
- `pm comments`: `--allow-audit-comment`
- `pm notes`: `--allow-audit-note`, `--allow-audit-comment`
- `pm learnings`: `--allow-audit-learning`, `--allow-audit-comment`
- `pm release`: `--allow-audit-release`

These flags are parsed and mapped by the package. The core command option types,
SDK results, contracts, MCP schema, completion, and bare CLI do not declare them.
`files/docs --audit` result aggregation also runs in the package through the
generic asynchronous command-result extension service; core `runFiles` and
`runDocs` return only their non-audit result contracts.

Package-decorated CLI results retain the optional compatibility markers
`audit_update: true` and `audit_release: true` when the corresponding package
bypass is used. Those fields are not part of the default SDK result types.

Without this package, those commands, flags, SDK runners, MCP parameters, and
completion entries are absent from the default pm distribution. Core retains
only generic ownership enforcement; `--force` is the explicit bare-core
override.

## Install

```bash
pm install governance-audit --project
# Short alias:
pm install audit --project
```

## Verify

```bash
pm item duplicates audit --mode parent_scope --status all --limit 20 --json
pm item duplicates merge --keep pm-canonical --close pm-duplicate --dry-run --json
pm item audit-comments --latest 3 --limit-items 20 --limit-rows 50 --json
pm ops normalize --dry-run --json
```

`dedupe-audit --status all` explicitly selects every status and is equivalent
to omitting the filter. The receipt retains `filters.status: "all"` for an
explicit all-status request. Configured status aliases and comma-separated OR
filters use the host SDK parser; combining `all` with another status or using
an unknown status fails. `--limit` caps returned clusters after the complete
matching item population is scanned, and unreadable source items fail the read.
Workflow terminality is captured per invocation so concurrent SDK calls cannot
exchange workspace policy. These contracts are tracked by
[pm-449do9](../../.agents/pm/issues/pm-449do9.toon).

For `comments-audit`, `--limit-items` caps item
scanning while `--limit-rows` caps emitted comment rows across the whole
result. The older `--limit` spelling remains a deprecated alias for
`--limit-rows`; do not combine the two row-limit spellings.

`pm normalize` remains a compatibility alias for `pm ops normalize`.

`dedupe-audit`, `dedupe-merge`, and `comments-audit` remain hidden compatibility aliases. Core `pm item duplicates` discovers bounded candidate clusters; this package adds detailed audit and explicit reconciliation. Comment coverage is an independent item audit, not a duplicate detector. SDK action names remain unchanged.
