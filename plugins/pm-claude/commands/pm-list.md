---
description: List pm items with optional status or type filter. Pass a filter like "open", "in_progress", "blocked", "bugs", or leave empty for active items.
---

List pm items using native MCP tools. Filter: `$ARGUMENTS`

1. **Parse filter** from `$ARGUMENTS`:
   - Status keywords: `open`, `in_progress`, `in-progress`, `blocked`, `draft`, `closed`, `canceled`, `all`
   - Type keywords: `task`, `bug`, `feature`, `epic`, `story`
   - Combined: e.g. "open bugs", "blocked features"
   - Empty: show active items (excludes closed/canceled)

2. **Call `pm_list`** with the parsed filter:
   ```json
   {
     "tool": "pm_list",
     "args": {
       "options": {
         "status": "<parsed status or omit>",
         "type": "<parsed type or omit>",
         "limit": "25"
       }
     }
   }
   ```
   For `all`, use `pm_list` with no status filter.

3. **If filter is empty** (active items) — also call `pm_context` for a richer summary:
   ```json
   { "tool": "pm_context", "args": { "options": { "limit": "10" } } }
   ```

4. **Present results** — format as a table or grouped list:
   | ID | Title | Status | Type | Priority |
   |----|-------|--------|------|----------|

5. **Show counts** — summarize: "X open, Y in_progress, Z blocked" at the top.

Keep the response under 400 words unless there are many items to show.
