---
description: Quickly create a new pm item — duplicate-checks first, then creates with sensible defaults. Pass a title (or title + description) as argument.
---

Create a new pm item using native MCP tools. Input: `$ARGUMENTS`

1. **Parse input** — treat `$ARGUMENTS` as the item title. If it contains a pipe (`|`) or newline, split into title | description.
2. **Duplicate check** — call `pm_search` with the title keywords:
   ```json
   { "tool": "pm_search", "args": { "query": "$ARGUMENTS", "options": { "limit": "5" } } }
   ```
   If a close match exists, show it and ask: "Is this a duplicate, or is this a new separate item?"
3. **Get context** — call `pm_context` to understand current workload before creating:
   ```json
   { "tool": "pm_context", "args": { "options": { "limit": "5" } } }
   ```
4. **Create** — if no duplicate and user confirms, call `pm_create`:
   ```json
   {
     "tool": "pm_create",
     "args": {
       "author": "claude-code-agent",
       "options": {
         "title": "<from $ARGUMENTS>",
         "description": "<inferred or from input>",
         "type": "Task",
         "status": "open",
         "priority": "2",
         "createMode": "progressive"
       }
     }
   }
   ```
5. **Report** — show the created item ID, title, and ask if it should be claimed immediately.

If `$ARGUMENTS` is empty, ask for the title interactively before creating.
