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
3. **Claim** — call `pm_claim` before substantial edits.
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
    "reason": "All acceptance criteria met. Tests pass."
  }
}
```

## Priority Reference

- `0` = critical, `1` = high, `2` = normal, `3` = low, `4` = minimal

## Safety

Do not pass `path` during real repository tracking. Only pass `path` for sandbox/test runs.

## Progressive Disclosure and Token Discipline

Load the smallest thing that answers the question. Costs are measured.

| Need | Call | Cost |
|------|------|------|
| Pick or resume work | `pm_next`, or `pm_context` with `limit: 10` | ~2.1-2.5k tok |
| Exact flags for one command | `pm_contracts` with `command: "<name>", flagsOnly: true` | ~1-3.4k tok |
| The whole command surface with per-command ceilings | `pm_contracts` with `summary: true` | ~2.6k tok |
| An unfamiliar capability family | `pm_run` with `action: "guide", topic: "<topic>", depth: "brief"` | ~0.6-1k tok |

Guide topics: `quickstart`, `commands`, `workflows`, `sdk`, `extensions`,
`skills`, `harnesses`, `release`, `tokens`, `graph`, `assurance`, `merge`.

Never load `docs/COMMANDS.md` (~29k tok) or `docs/SDK.md` (~45k tok) whole.

Bound every read in this order: projection (`outputInclude`), then row limit
(`outputLimit` or `limit`), then `outputBudget`, then `outputCursor` to resume.
Read the `omission_receipt` before treating a result as complete — a
budget-truncated read is a claim about the part it withheld, and a truncated
list must never be summarized as if it were the whole population.

Author identity is detected automatically. Never pass `author` and never set
`PM_AUTHOR`; the harness, model, effort, role, and topic are probed and recorded
on every history entry.
