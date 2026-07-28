# pm-guide-shell

Trackers: [pm-cb8qq2](../../.agents/pm/issues/pm-cb8qq2.toon), [pm-w7mqzt](../../.agents/pm/tasks/pm-w7mqzt.toon)

First-party package that restores optional guide and shell-completion UX in bare-core `pm`.

## Commands

- `pm guide [topic]`
- `pm completion [bash|zsh|fish]`
- `pm completion-tags`
- `pm completion-statuses`
- `pm completion-types`

Runtime command fields accept the same hyphenated, underscored, or
whitespace-separated spelling as CLI commands. Multi-word commands such as
`close-many`, `close_many`, and `close many` therefore resolve to the same
contract without package-owned special cases.

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
