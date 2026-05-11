# pm Todos Package

First-party pm package for Todo markdown import and export.

```bash
pm install ./packages/pm-todos --project
pm todos import --folder .pm/todos
pm todos export --folder .pm/todos
```

The package exposes the `todos import` and `todos export` extension commands through the `pm.extensions` package manifest.
