# pm-governance-audit

First-party package that restores optional governance audit surfaces in bare-core `pm`.

## Commands

- `pm dedupe-audit`
- `pm comments-audit`
- `pm normalize`

## Install

```bash
pm install governance-audit --project
```

## Verify

```bash
pm dedupe-audit --mode parent_scope --limit 20 --json
pm comments-audit --latest 3 --limit-items 20 --json
pm normalize --dry-run --json
```
