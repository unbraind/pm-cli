---
description: Initialize pm in the current project — creates the .agents/pm/ tracker directory, sets up default settings, and shows a quick-start summary. Accepts an optional project name as argument.
---

Initialize pm project tracking using native MCP tools. Argument: `$ARGUMENTS` (optional project name).

1. **Check if already initialized** — look for `.agents/pm/settings.json` in the current directory:
   ```json
   { "tool": "pm_health", "args": {} }
   ```
   If health returns `ok: true`, pm is already initialized — show the current status with `pm_context` and stop.

2. **Run init** via `pm_run`:
   ```json
   { "tool": "pm_run", "args": { "action": "init", "options": {} } }
   ```

3. **Verify initialization** — call `pm_health` again to confirm `ok: true`.

4. **Create a first item** (optional) — if `$ARGUMENTS` is a project name or description, offer to create an initial Epic:
   ```json
   {
     "tool": "pm_create",
     "args": {
       "author": "claude-code-agent",
       "options": {
         "title": "<project name> — initial setup",
         "type": "Epic",
         "status": "open",
         "priority": "1",
         "description": "Top-level epic for tracking <project name> work.",
         "createMode": "progressive"
       }
     }
   }
   ```

5. **Show quick-start summary**:
   - pm initialized at `.agents/pm/`
   - Available slash commands: `/pm-status`, `/pm-new`, `/pm-start-task`, `/pm-close-task`, `/pm-list`, `/pm-search`, `/pm-triage`, `/pm-calendar`, `/pm-developer`, `/pm-planner`, `/pm-release`, `/pm-audit`, `/pm-workflow`
   - All 18 MCP tools available: `pm_context`, `pm_search`, `pm_list`, `pm_get`, `pm_create`, `pm_update`, `pm_claim`, `pm_release`, `pm_close`, `pm_comments`, `pm_files`, `pm_docs`, `pm_test`, `pm_validate`, `pm_health`, `pm_contracts`, `pm_guide`, `pm_run`
   - Next: use `/pm-new <title>` to create your first item, or `/pm-status` to see the tracker state

If initialization fails, report the error and suggest running `pm init` manually in the terminal.
