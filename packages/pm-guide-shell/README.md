# pm-guide-shell

First-party package that restores optional guide and shell-completion UX in bare-core `pm`.

## Commands

- `pm guide [topic]`
- `pm completion [bash|zsh|fish]`
- `pm completion-tags`
- `pm completion-statuses`
- `pm completion-types`

## Install

```bash
pm install guide-shell --project
```

## Verify

```bash
pm guide --list --json
pm completion bash
pm completion-tags
pm completion-statuses
pm completion-types
```
