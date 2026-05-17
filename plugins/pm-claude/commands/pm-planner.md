---
description: Plan and organize pm work — triage requests, break epics into tasks, prioritize the backlog, and keep the tracker clean. Accepts an optional scope description as argument.
---

Run the pm planning loop using native MCP tools. Argument: `$ARGUMENTS` (optional: feature/epic description to decompose, or empty to survey and prioritize the backlog).

1. **Survey the backlog**:
   ```json
   { "tool": "pm_context", "args": { "options": { "depth": "standard", "limit": "20" } } }
   { "tool": "pm_list", "args": { "options": { "limit": "50" } } }
   ```

2. **If `$ARGUMENTS` describes new scope** — triage it:
   - `pm_search` with the most distinctive keywords to check for duplicates.
   - If no match, proceed to create. If match found, show it and ask: duplicate or related?

3. **Decompose** (if creating new scope):
   - Create Epic (if the scope spans multiple features)
   - Create child Features/Tasks with `parent` links
   - Use `pm_create` with `createMode: "progressive"` for each

4. **Sync to Claude Code task panel** for any item you claim this session:
   ```
   TaskCreate:
     subject: "[pm-xxxx] Plan: <title>"
     description: "Planning scope for pm-xxxx"
     activeForm: "Planning pm-xxxx"
   ```
   Call `TaskUpdate(in_progress)`. Save taskId.

5. **Prioritize** — review open items and update priorities with `pm_update`:
   - `0` = critical, `1` = high, `2` = normal, `3` = low, `4` = minimal

6. **Link parents** for all child items:
   ```json
   { "tool": "pm_update", "args": { "id": "pm-child", "author": "claude-code-agent", "options": { "parent": "pm-epic" } } }
   ```

7. **Validate** after batch creates:
   ```json
   { "tool": "pm_validate", "args": { "options": { "checkResolution": true } } }
   ```

8. **Dedupe check**:
   ```json
   { "tool": "pm_run", "args": { "action": "dedupe-audit", "options": { "mode": "parent_scope", "limit": "20" } } }
   ```

9. If you claimed a planning item: `pm_close` it, `pm_release`, then `TaskUpdate(completed)`.

10. **Report** — list all created/updated items with their IDs, types, priorities, and parent links.

## Living plan mode (`pm_plan`)

If the user wants a Codex-style ExecPlan / Claude Plan Mode / Cursor plan-and-edit flow rather than a flat backlog, use the built-in `Plan` item type via the `pm_plan` MCP tool. It records ordered steps, evidence, decisions, discoveries, validation, and supports materializing steps into real Tasks/Features.

```json
{ "tool": "pm_plan", "args": { "options": { "subcommand": "create", "title": "Plan title", "scope": "What this plan changes", "harness": "claude-code", "parent": "pm-epic1", "claim": true } } }
{ "tool": "pm_plan", "args": { "id": "pm-plan1", "options": { "subcommand": "add-step", "stepTitle": "Read affected files", "dependsOn": "pm-task1" } } }
{ "tool": "pm_plan", "args": { "id": "pm-plan1", "stepRef": "plan-step-001", "options": { "subcommand": "complete-step", "stepEvidence": "files reviewed" } } }
{ "tool": "pm_plan", "args": { "id": "pm-plan1", "options": { "subcommand": "approve" } } }
{ "tool": "pm_plan", "args": { "id": "pm-plan1", "options": { "subcommand": "materialize", "steps": "plan-step-002,plan-step-003", "materializeType": "Task" } } }
{ "tool": "pm_plan", "args": { "id": "pm-plan1", "options": { "subcommand": "show", "depth": "deep" } } }
```

Resume a plan after compaction:
```json
{ "tool": "pm_plan", "args": { "id": "pm-plan1", "options": { "subcommand": "resume", "resumeContext": "step 2 in progress; tests still failing on retry path" } } }
```
