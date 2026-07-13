# pm-governance-audit

First-party package that restores optional governance audit surfaces in bare-core `pm`.

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

- `pm dedupe-audit`
- `pm dedupe-merge`
- `pm comments-audit`
- `pm normalize`

The package also augments existing commands with audit-only flags:

- `pm files <id> --audit` and `pm docs <id> --audit`
- `pm update` / `pm update-many`: `--allow-audit-update`, `--allow-audit-dep-update`
- `pm comments`: `--allow-audit-comment`
- `pm notes`: `--allow-audit-note`, `--allow-audit-comment`
- `pm learnings`: `--allow-audit-learning`, `--allow-audit-comment`
- `pm release`: `--allow-audit-release`

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
pm dedupe-audit --mode parent_scope --limit 20 --json
pm dedupe-merge --keep pm-canonical --close pm-duplicate --dry-run --json
pm comments-audit --latest 3 --limit-items 20 --json
pm normalize --dry-run --json
```
