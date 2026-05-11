# pm Beads Package

First-party pm package for importing Beads JSONL records.

```bash
pm install ./packages/pm-beads --project
pm beads import --file .beads/issues.jsonl
```

The package exposes the `beads import` extension command through the `pm.extensions` package manifest.
