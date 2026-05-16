---
name: pm-developer
description: Run the pm-cli developer execution loop — orient, claim, implement, link evidence, verify, and close — with native MCP tools. Use when coding, debugging, refactoring, or shipping changes tracked in pm items.
---

# pm Developer

Use this skill for implementation work that changes code, docs, tests, or release artifacts.

## Canonical Execution Loop

1. **Orient** — `pm_context` then `pm_search` for relevant existing items.
2. **Decide** — reuse an existing item when one matches; create only when needed.
3. **Claim** — `pm_claim` before any substantial edits.
4. **Sync TUI** — call `TaskCreate` to mirror the pm item in Claude Code's task panel (see Hybrid TUI Sync).
5. **Implement** — make the changes, link files/docs/tests as you go.
6. **Verify** — run linked tests plus local quality gates.
7. **Evidence** — `pm_comments` with what changed and what passed.
8. **Close** — `pm_close` then `pm_release` then `TaskUpdate(completed)`.

## Hybrid TUI Sync

pm is the **persistent store**. Claude Code's task panel is the **live session view**.

### After pm_claim (or pm_create when starting fresh)

```
TaskCreate:
  subject: "[pm-xxxx] <item title>"
  description: "Tracking pm item pm-xxxx. AC: <acceptance_criteria>"
  activeForm: "Implementing pm-xxxx"
```

Save the returned `taskId`. Then:

```
TaskUpdate: { taskId: <saved>, status: "in_progress" }
```

### After pm_close + pm_release

```
TaskUpdate: { taskId: <saved>, status: "completed" }
```

## Step-by-Step MCP Calls

### 1. Orient
```json
{ "tool": "pm_context", "args": { "options": { "limit": "10" } } }
{ "tool": "pm_search", "args": { "query": "task keywords", "options": { "limit": "10" } } }
```

### 2. Claim
```json
{ "tool": "pm_claim", "args": { "id": "pm-xxxx", "author": "claude-code-agent" } }
{ "tool": "pm_update", "args": { "id": "pm-xxxx", "author": "claude-code-agent", "options": { "status": "in_progress" } } }
```

Then immediately: `TaskCreate` → `TaskUpdate(in_progress)` as shown above.

### 3. Link Evidence (during implementation)
```json
{ "tool": "pm_files", "args": { "id": "pm-xxxx", "author": "claude-code-agent", "options": { "add": ["path=src/file.ts,scope=project,note=implementation"] } } }
{ "tool": "pm_docs", "args": { "id": "pm-xxxx", "author": "claude-code-agent", "options": { "add": ["path=docs/GUIDE.md,scope=project,note=updated"] } } }
{ "tool": "pm_test", "args": { "id": "pm-xxxx", "author": "claude-code-agent", "options": { "add": ["command=node scripts/run-tests.mjs test -- tests/unit/foo.spec.ts,scope=project,timeout_seconds=240"] } } }
```

### 4. Validate
```json
{ "tool": "pm_validate", "args": { "options": { "checkResolution": true, "checkHistoryDrift": true } } }
```

### 5. Add Evidence Comment
```json
{ "tool": "pm_comments", "args": { "id": "pm-xxxx", "author": "claude-code-agent", "options": { "add": "Evidence: changed src/foo.ts. All tests pass. pm validate ok." } } }
```

### 6. Close
```json
{ "tool": "pm_close", "args": { "id": "pm-xxxx", "reason": "Implementation complete. Acceptance criteria met.", "author": "claude-code-agent" } }
{ "tool": "pm_release", "args": { "id": "pm-xxxx", "author": "claude-code-agent" } }
```

Then: `TaskUpdate: { taskId: <saved>, status: "completed" }`

## Verification Defaults

Run these before closing any implementation item:
- `pnpm build` (or project build command)
- `node scripts/run-tests.mjs test -- <target>` (targeted test)
- `node scripts/run-tests.mjs coverage` (coverage gate)
- `pm_validate` with `checkResolution: true`

## Create When Needed

When no existing item matches:
```json
{
  "tool": "pm_create",
  "args": {
    "author": "claude-code-agent",
    "options": {
      "title": "Fix: concise description of the problem",
      "description": "Root cause and approach.",
      "type": "Task",
      "status": "open",
      "priority": "1",
      "tags": "relevant,tags",
      "createMode": "progressive"
    }
  }
}
```

Then call `TaskCreate` + `TaskUpdate(in_progress)` after claiming.
