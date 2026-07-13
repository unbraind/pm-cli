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

## Built-in Plan workflow (`pm_plan` / `pm plan`)

For durable Codex-style ExecPlans, Claude-style Plan Mode, and Cursor-style editable checklists, pm exposes a first-class `Plan` item type plus a `pm plan` command family. Use [Command Reference: Plan Workflow](../../../../docs/COMMANDS.md#plan-workflow) as the canonical lifecycle recipe; this skill keeps only Claude-specific routing notes.

### When to use `pm plan` vs. `pm_create` + tasks

- `pm plan` — when you need a **living, resumable plan** with ordered steps, evidence, decisions, discoveries, validation, and the option to later materialize selected steps as real Tasks. Best for plan-then-execute workflows.
- `pm_create` (Epic/Feature/Task) — when the work is already decomposed and you just need persistent backlog items.

### Claude MCP routing

Call the same lifecycle through the `pm_plan` MCP tool. Use `harness: "claude-code"` on creation, `subcommand: "show"` with `depth: "brief"` for low-token reads, and `subcommand: "resume"` after compaction or handoff.

### Harness mapping cheatsheet

| Harness signal | pm_plan equivalent |
|----------------|--------------------|
| Codex `update_plan` step status | `subcommand=update-step` with `stepStatus` |
| Claude `TaskCreate` | `subcommand=add-step` |
| Claude `TaskUpdate(in_progress)` | `subcommand=update-step` with `stepStatus=in_progress` |
| Cursor edit a plan step | `subcommand=update-step` |
| Resume after compaction | `subcommand=resume` with `resumeContext` then `subcommand=show --depth deep` |
| Approve before edits | `subcommand=approve` |
| Convert checklist into real items | `subcommand=materialize` |

## Safety

- Never pass `path` during real repository tracking.
- Always `pm_search` before `pm_create`/`pm plan create` — avoid duplicates.
- Run `pm_validate` after batch changes.
- Set exactly one step `in_progress` per plan; pass `allowMultipleActive: true` only for explicit parallel branches.
- Use `pm_plan` `subcommand=resume` after long-running sessions so the next agent can pick up with a deterministic context.
