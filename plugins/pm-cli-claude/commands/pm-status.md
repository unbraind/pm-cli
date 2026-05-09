---
description: Show a compact pm project status snapshot — active items, blocked work, and upcoming deadlines.
---

Use native pm MCP tools to show project status:

1. Call `pm_context` with `options: { limit: "10", depth: "standard" }` to get the active work snapshot.
2. Call `pm_run` with `action: "calendar"` and `options: { view: "week", format: "markdown", include: "deadlines,reminders" }` to show upcoming events.
3. Present a compact summary:
   - Count items by status (in_progress / open / blocked)
   - List the top 3 active items with title, assignee, and deadline
   - Note any overdue or blocked items
   - Show the next 3 calendar events if any

Keep the response concise — under 300 words unless there are many items. Do not show closed or canceled items.
