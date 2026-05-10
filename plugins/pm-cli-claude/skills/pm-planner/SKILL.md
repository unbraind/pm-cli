---
name: pm-planner
description: Plan and organize pm CLI work — triage requests, break epics into tasks, prioritize the backlog, and keep the tracker clean. Use when decomposing features, planning sprints, or organizing incoming requests.
---

# pm Planner

Use this skill when decomposing features, organizing backlogs, triaging incoming work, or planning multi-item projects.

## Planning Loop

1. **Survey** — `pm_context` then `pm_list` with no filter to see the full active backlog.
2. **Deduplicate** — `pm_search` before every create to avoid duplicate items.
3. **Decompose** — break large items into Epic → Feature → Task hierarchy.
4. **Prioritize** — use `pm_update` to set priority (`0`=critical … `4`=minimal).
5. **Link parents** — always set `parent` on child items via `pm_update`.
6. **Sync TUI** — call `TaskCreate` for any item you claim during this session (see Hybrid TUI Sync).
7. **Validate** — `pm_validate` after batch creates to check consistency.

## Hybrid TUI Sync

pm is the **persistent store**. Claude Code's task panel is the **live session view**.

When you claim a planning item or start active decomposition work:
```
TaskCreate:
  subject: "[pm-xxxx] Plan: <epic/feature title>"
  description: "Planning pm-xxxx — decomposing into child items"
  activeForm: "Planning pm-xxxx"
```
Save the `taskId`. Call `TaskUpdate(in_progress)` when active.
Call `TaskUpdate(completed)` when the planning item is closed.

## MCP Call Patterns

### Survey the Backlog
```json
{ "tool": "pm_context", "args": { "options": { "depth": "standard", "limit": "20" } } }
{ "tool": "pm_list", "args": { "options": { "limit": "50" } } }
```

### Deduplicate Before Creating
```json
{ "tool": "pm_search", "args": { "query": "feature keywords", "options": { "limit": "10" } } }
```

### Create Epic → Feature → Task Hierarchy
```json
{
  "tool": "pm_create",
  "args": {
    "author": "claude-code-agent",
    "options": {
      "title": "Epic: Authentication system overhaul",
      "type": "Epic",
      "status": "open",
      "priority": "1",
      "description": "High-level initiative description.",
      "createMode": "progressive"
    }
  }
}
```
Then for each child feature/task, set `parent: "pm-xxxx"` via `pm_update`.

### Prioritize the Backlog
```json
{ "tool": "pm_list", "args": { "options": { "status": "open", "limit": "30" } } }
{ "tool": "pm_update", "args": { "id": "pm-xxxx", "author": "claude-code-agent", "options": { "priority": "0" } } }
```

### Link Parent
```json
{ "tool": "pm_update", "args": { "id": "pm-child", "author": "claude-code-agent", "options": { "parent": "pm-epic" } } }
```

### Run Dedupe Audit After Batch Work
```json
{ "tool": "pm_run", "args": { "action": "dedupe-audit", "options": { "mode": "parent_scope", "limit": "20" } } }
```

### Validate After Batch Creates
```json
{ "tool": "pm_validate", "args": { "options": { "checkResolution": true } } }
```

## Item Type Guide

| Type | When to use |
|------|------------|
| `Epic` | Large initiative spanning multiple features (weeks/months) |
| `Feature` | Distinct capability under an epic (days) |
| `Task` | Atomic unit of implementation work (hours) |
| `Bug` | Defect with reproduce steps |
| `Story` | User-facing narrative unit |

## Priority Reference

- `0` = critical — blocking release or other work
- `1` = high — important, should be done soon
- `2` = normal — standard priority (default)
- `3` = low — nice to have
- `4` = minimal — defer unless time allows

## Acceptance Criteria Best Practice

Write AC as numbered, testable assertions:
1. Given [precondition], when [action], then [result].
2. All existing tests pass.
3. Coverage gate maintained.

Set via `pm_create` with `acceptanceCriteria` field or `pm_update` with `options.acceptanceCriteria`.

## Safety

- Never pass `path` during real repository tracking.
- Always `pm_search` before `pm_create` — avoid duplicates.
- Run `pm_validate` after batch changes.
