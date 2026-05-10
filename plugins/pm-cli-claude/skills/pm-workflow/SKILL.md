---
name: pm-workflow
description: Use pm CLI natively in Claude Code through MCP tools for planning, tracking, mutation, validation, and reporting. Use this skill whenever work should be tracked through pm — before implementing, during implementation, and at close.
---

# pm Workflow

Use this skill for all pm-tracked work. Prefer native MCP tools over shell `pm` commands.

## Tool Preference

**Always use native MCP tools before falling back to Bash `pm` commands:**

| Purpose | Tool |
|---------|------|
| Orient / read state | `pm_context`, `pm_search`, `pm_list`, `pm_get` |
| Create / update | `pm_create`, `pm_update`, `pm_claim`, `pm_release`, `pm_close` |
| Evidence | `pm_comments`, `pm_files`, `pm_docs`, `pm_test` |
| Verify | `pm_validate`, `pm_health`, `pm_contracts` |
| Everything else | `pm_run` with an explicit `action` |

## Required Workflow Loop

1. **Orient** — run `pm_context`, `pm_search`, and `pm_list` before creating new work.
2. **Reuse** — claim an existing item when one matches instead of creating a duplicate.
3. **Claim** — call `pm_claim` with `author: "claude-code-agent"` before substantial edits.
4. **Sync TUI** — after claiming, call `TaskCreate` to mirror the item in Claude Code's task panel (see Hybrid TUI Sync below).
5. **Link evidence** — call `pm_files`, `pm_docs`, `pm_test` as work progresses.
6. **Add comments** — `pm_comments` for progress notes and verification results.
7. **Verify** — run `pm_validate` and project tests before closing.
8. **Close** — `pm_close` with reason, then `pm_release`, then `TaskUpdate(completed)`.

## Hybrid TUI Sync

pm is the **persistent store** (cross-session). Claude Code's task panel is the **live session view**.

### When claiming or creating an item

Call `TaskCreate` immediately after `pm_claim` (or after `pm_create` if starting fresh):

```
TaskCreate:
  subject: "[pm-xxxx] <item title>"
  description: "Tracking pm item pm-xxxx. AC: <acceptance_criteria if set>"
  activeForm: "Implementing pm-xxxx"
```

Save the returned `taskId` — you'll need it for `TaskUpdate` calls later in this session.

### When setting in_progress

Call `TaskUpdate` with `status: "in_progress"` using the `taskId` from above.

### When closing

Call `pm_close` then `pm_release`, then immediately call:
```
TaskUpdate:
  taskId: <saved taskId>
  status: "completed"
```

### Blocked items

If a pm item becomes blocked, call `TaskUpdate` with `status: "in_progress"` and add "(BLOCKED)" to the subject so it's visible in the panel.

## Tool Call Shape

Most tools accept `cwd`, `author`, and `options`:

```json
{
  "cwd": "/path/to/repo",
  "author": "claude-code-agent",
  "options": { "limit": "10" }
}
```

`pm_run` requires an `action` field:

```json
{
  "action": "calendar",
  "options": { "view": "week", "format": "markdown" }
}
```

## Common Patterns

**Get active work snapshot:**
```json
{ "tool": "pm_context", "args": { "options": { "limit": "10" } } }
```

**Search for existing work:**
```json
{ "tool": "pm_search", "args": { "query": "your keywords", "options": { "limit": "10" } } }
```

**Create a new item:**
```json
{
  "tool": "pm_create",
  "args": {
    "author": "claude-code-agent",
    "options": {
      "title": "Item title",
      "description": "What this item tracks.",
      "type": "Task",
      "status": "open",
      "priority": "1",
      "createMode": "progressive"
    }
  }
}
```

**Link changed files:**
```json
{
  "tool": "pm_files",
  "args": {
    "id": "pm-xxxx",
    "author": "claude-code-agent",
    "options": { "add": ["path=src/file.ts,scope=project,note=implementation"] }
  }
}
```

**Close with evidence:**
```json
{
  "tool": "pm_close",
  "args": {
    "id": "pm-xxxx",
    "reason": "All acceptance criteria met. Tests pass.",
    "author": "claude-code-agent"
  }
}
```

## Priority Reference

- `0` = critical, `1` = high, `2` = normal, `3` = low, `4` = minimal

## Safety

Do not pass `path` during real repository tracking. Only pass `path` for sandbox/test runs.
