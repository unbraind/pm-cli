---
description: Run a comprehensive pm repository audit — health, validation, duplicates, aggregate counts, calendar, and activity. Produces a structured finding report with tracked pm items for actionable issues.
---

Use native pm MCP tools to audit the repository's pm tracker state.

1. **Check for existing audit items** — `pm_search` with query "audit" to avoid duplicate tracking.
2. **Create an audit tracking item** if none exists (or reuse a recent one):
   ```json
   { "tool": "pm_create", "args": { "author": "claude-code-agent", "options": { "title": "pm tracker audit", "type": "Task", "status": "open", "priority": "1", "createMode": "progressive" } } }
   ```
3. **Claim** the audit item.
4. **Run the audit suite** in order:
   - `pm_health` — tracker diagnostics
   - `pm_validate` with `checkResolution: true, checkHistoryDrift: true, checkFiles: true, scanMode: "tracked-all"`
   - `pm_run` with `action: "aggregate", options: { groupBy: "status,type" }` — count breakdown
   - `pm_run` with `action: "dedupe-audit", options: { mode: "parent_scope", limit: "20" }` — duplicates
   - `pm_run` with `action: "stats"` — storage metrics
   - `pm_run` with `action: "calendar", options: { view: "week", include: "deadlines,reminders" }` — upcoming
5. **Classify findings** — create child pm items for any blocker or warning findings.
6. **Record evidence** with `pm_comments`: summary of all checks and findings.
7. **Report** a structured audit summary:
   - Health status
   - Validation results (pass/warn/fail per check)
   - Item counts by status
   - Duplicate candidates found
   - Overdue or upcoming deadlines
   - Any created finding items

Format the output as a markdown table for the validation results.
