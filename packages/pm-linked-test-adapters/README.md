# pm-linked-test-adapters

First-party package that restores optional linked-test background run management surfaces in bare-core `pm`.

## Commands

- `pm test-runs`
- `pm test-runs list`
- `pm test-runs status <runId>`
- `pm test-runs logs <runId>`
- `pm test-runs stop <runId>`
- `pm test-runs resume <runId>`

## Install

```bash
pm install linked-test-adapters --project
```

## Verify

```bash
pm test-runs list --json
```
