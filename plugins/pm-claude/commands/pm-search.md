---
description: Search pm items by keywords, tags, status, or type — returns ranked results with context. Pass the search query as argument.
---

Search pm items using native MCP tools. Query: `$ARGUMENTS`

1. **Parse the query** — extract key terms from `$ARGUMENTS`. If empty, ask the user what to search for.
2. **Run primary search** — call `pm_search` with the query:
   ```json
   { "tool": "pm_search", "args": { "query": "$ARGUMENTS", "options": { "limit": "15" } } }
   ```
3. **If query includes a status filter** (e.g. "open bugs", "blocked", "in progress") — also call `pm_list` with the matching status filter:
   ```json
   { "tool": "pm_list", "args": { "options": { "status": "blocked", "limit": "20" } } }
   ```
4. **Present results** — show each matching item as:
   - `[pm-xxxx]` **Title** (status, type, priority)
   - One line of description if relevant
5. **Offer to start, update, or triage** — after showing results, ask if the user wants to claim an item or create a new one if nothing matches.

Keep results concise — title + status + type per line. Group by status if there are many results.
