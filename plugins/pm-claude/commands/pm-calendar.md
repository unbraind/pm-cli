---
description: Show the pm calendar — upcoming deadlines, reminders, and scheduled events. Optionally pass a view like "week", "month", or a date range.
---

Show the pm project calendar using native MCP tools. View: `$ARGUMENTS`

1. **Parse view** from `$ARGUMENTS`:
   - `week` (default) — current and next 7 days
   - `month` — current month
   - `today` — just today's events
   - Empty — defaults to `week`

2. **Call `pm_run` with calendar action**:
   ```json
   {
     "tool": "pm_run",
     "args": {
       "action": "calendar",
       "options": {
         "view": "<parsed view, default: week>",
         "format": "markdown",
         "include": "deadlines,reminders,scheduled"
       }
     }
   }
   ```

3. **Also call `pm_context`** for active work context alongside the calendar:
   ```json
   { "tool": "pm_context", "args": { "options": { "limit": "5" } } }
   ```

4. **Present the calendar** — show:
   - A header: "📅 pm Calendar — [view] — [date range]"
   - Calendar events grouped by date
   - A brief summary of overdue items at the top if any
   - Active in-progress work below the calendar

5. **Flag overdue** — if any deadlines are past today, highlight them prominently.

Keep the response concise — use a table or compact list for calendar entries.
