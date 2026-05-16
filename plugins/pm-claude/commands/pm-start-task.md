---
description: Start a pm-tracked task — orient, find or create the right item, claim it, sync to TUI, and link initial scope. Accepts an optional item ID or keywords as argument.
---

Use native pm MCP tools to start a tracked task. Argument: `$ARGUMENTS` (item ID like `pm-xxxx`, or keywords to search, or empty to use context).

1. **Orient** — call `pm_context` with `options: { limit: "10" }`.
2. **Find the item**:
   - If `$ARGUMENTS` looks like an ID (starts with `pm-`): call `pm_get` with that ID.
   - If `$ARGUMENTS` has keywords: call `pm_search` with those keywords.
   - If empty: call `pm_list` to show open items and ask the user which to start.
3. **Claim** the selected item with `pm_claim` and `author: "claude-code-agent"`.
4. **Update status** with `pm_update` to `status: "in_progress"`.
5. **Sync to Claude Code task panel** — call `TaskCreate`:
   ```
   TaskCreate:
     subject: "[pm-xxxx] <item title>"
     description: "Tracking pm item pm-xxxx. AC: <acceptance_criteria if set>"
     activeForm: "Implementing pm-xxxx"
   ```
   Then call `TaskUpdate` with `status: "in_progress"` using the returned taskId.
6. **Add a start comment** with `pm_comments`: `"Starting work. Scope: <brief description of planned approach>."`
7. **Report** the claimed item's title, ID, and acceptance criteria.

If no matching item exists and the user wants to create one, collect title + description + type then call `pm_create` — then proceed from step 3.

The Claude Code task panel will now show the item with a spinner. Use `/pm-close-task pm-xxxx` when done to close both pm and the panel entry.
