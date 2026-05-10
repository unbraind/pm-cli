---
description: Run the pm-cli developer execution loop — orient, claim, implement, link evidence, verify, and close — with native MCP tools and live TUI tracking. Accepts an optional item ID or keywords as argument.
---

Run the full pm developer loop using native MCP tools. Argument: `$ARGUMENTS` (item ID like `pm-xxxx`, keywords, or empty to orient from context).

1. **Orient**:
   ```json
   { "tool": "pm_context", "args": { "options": { "limit": "10" } } }
   { "tool": "pm_search", "args": { "query": "$ARGUMENTS", "options": { "limit": "10" } } }
   ```
2. **Find or create the item**:
   - If `$ARGUMENTS` is a pm ID: `pm_get` it directly.
   - If keywords: pick the best match from search or ask the user.
   - If no match: `pm_create` with progressive mode.
3. **Claim** with `pm_claim` and `author: "claude-code-agent"`, then set `status: "in_progress"` with `pm_update`.
4. **Sync to Claude Code task panel**:
   ```
   TaskCreate:
     subject: "[pm-xxxx] <item title>"
     description: "Developer loop — pm-xxxx. AC: <acceptance_criteria>"
     activeForm: "Implementing pm-xxxx"
   ```
   Call `TaskUpdate(in_progress)`. Save the taskId for the session.
5. **Implement** — make the changes. Link evidence as you go:
   - `pm_files` for changed source files
   - `pm_docs` for updated documentation
   - `pm_test` for test commands
6. **Verify**:
   - Run the project build and tests
   - `pm_validate` with `checkResolution: true`
7. **Record evidence** with `pm_comments`: what changed, what was tested, results.
8. **Close**:
   - `pm_close` with reason
   - `pm_release`
   - `TaskUpdate(completed)` using the saved taskId

If `$ARGUMENTS` is empty, call `pm_list` to show active items and ask which to work on.
