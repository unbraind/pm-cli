---
description: Run the pm workflow loop — orient, claim, track, and close a pm item — with full hybrid TUI display. Accepts an optional item ID or description as argument.
---

Run the pm workflow loop using native MCP tools. Argument: `$ARGUMENTS` (item ID, keywords, or description of new work).

This is the general-purpose pm workflow command. For specialized loops use:
- `/pm-developer` — implementation/coding work
- `/pm-release` — release gates and publishing
- `/pm-planner` — backlog planning and decomposition
- `/pm-audit` — tracker health audit

**Steps:**

1. **Orient**:
   ```json
   { "tool": "pm_context", "args": { "options": { "limit": "10" } } }
   ```

2. **Find or create the item** from `$ARGUMENTS`:
   - pm ID → `pm_get`
   - Keywords → `pm_search` then pick the best match
   - Description of new work → `pm_search` first, then `pm_create` if no duplicate

3. **Claim** with `pm_claim` + `author: "claude-code-agent"`, then `pm_update` to `in_progress`.

4. **Sync to Claude Code task panel**:
   ```
   TaskCreate:
     subject: "[pm-xxxx] <item title>"
     description: "Tracking pm-xxxx"
     activeForm: "Working on pm-xxxx"
   ```
   Call `TaskUpdate(in_progress)`. Save taskId for this session.

5. **Do the work** — link evidence as you go:
   - Changed files: `pm_files`
   - Updated docs: `pm_docs`
   - Test commands: `pm_test`
   - Progress notes: `pm_comments`

6. **Verify** — `pm_validate` before closing.

7. **Close**:
   - `pm_close` with reason addressing acceptance criteria
   - `pm_release`
   - `TaskUpdate(completed)` using saved taskId

Report the item ID, title, and final status at the end.
