---
description: Triage a new request through pm — check for duplicates, create canonical parent lineage if needed, and produce a scoped child item with acceptance criteria. Pass the request description as argument.
---

Use native pm MCP tools to triage a request into pm tracking. Request: `$ARGUMENTS`

1. **Duplicate check** — `pm_search` with the most distinctive keywords from the request. Check first 10 results.
2. **Context** — `pm_context` to understand current workload and priorities.
3. **Decision**:
   - If a matching item exists: show it and ask if this is a duplicate or a related new item.
   - If no match: proceed to create.
4. **Parent lineage** — for net-new scope, check if there's an Epic or Feature parent. Create parent items if needed before the child.
5. **Create the item**:
   ```json
   {
     "tool": "pm_create",
     "args": {
       "author": "claude-code-agent",
       "options": {
         "title": "Concise, action-oriented title",
         "description": "What and why, one paragraph.",
         "type": "Task",
         "status": "open",
         "priority": "1",
         "tags": "relevant,tags",
         "acceptanceCriteria": "Specific, testable criteria.",
         "createMode": "progressive"
       }
     }
   }
   ```
6. **Link parent** if one exists: `pm_update` with `options: { parent: "pm-xxxx" }`.
7. **Report** the created item ID, title, and acceptance criteria.

Keep the item scoped — one work unit per item. Break large requests into Epic → Feature → Task hierarchy.
