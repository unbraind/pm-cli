---
name: pm-audit
description: Audit pm-cli repositories with native pm MCP tools — health checks, validation, duplicate detection, aggregation, privacy review, and workflow health. Use when performing broad repository audits, release readiness checks, or agent-workflow health reviews.
---

# pm Audit

Use for comprehensive repository audits, consistency reviews, and health diagnostics.

## Audit Flow

1. **Context snapshot** — `pm_context` with `depth: "standard"`.
2. **Search for existing audits** — `pm_search` to avoid duplicate tracking.
3. **Create or claim audit item** — then call `TaskCreate` to show in Claude Code's task panel.
4. **Health check** — `pm_health` for tracker diagnostics.
5. **Validation suite** — `pm_validate` with all checks enabled.
6. **Aggregate** — `pm_run` with `action: "aggregate"` for governance view.
7. **Dedupe review** — `pm_run` with `action: "dedupe-audit"`.
8. **Calendar** — `pm_run` with `action: "calendar"` for deadline view.
9. **Convert findings** — create pm items for each actionable finding.
10. **Evidence** — `pm_comments` with verification summaries.
11. **Close audit item** then `TaskUpdate(completed)`.

## Hybrid TUI Sync

After creating/claiming the audit tracking item:
```
TaskCreate:
  subject: "[pm-xxxx] Audit: pm tracker health"
  description: "Tracking full audit run — pm-xxxx"
  activeForm: "Running pm audit"
```
Save the `taskId`. Call `TaskUpdate(in_progress)`.
When closing: `TaskUpdate(completed)`.

For each **finding item** created during the audit, also create a matching `TaskCreate` if you plan to work on it this session.

## MCP Calls

### Full Audit Suite
```json
{ "tool": "pm_context", "args": { "options": { "depth": "standard", "limit": "20" } } }
{ "tool": "pm_health", "args": {} }
{ "tool": "pm_validate", "args": { "options": { "checkResolution": true, "checkHistoryDrift": true, "checkFiles": true, "scanMode": "tracked-all" } } }
{ "tool": "pm_run", "args": { "action": "aggregate", "options": { "groupBy": "status,type" } } }
{ "tool": "pm_run", "args": { "action": "dedupe-audit", "options": { "mode": "parent_scope", "limit": "20" } } }
{ "tool": "pm_run", "args": { "action": "calendar", "options": { "view": "week", "format": "markdown", "include": "deadlines,reminders" } } }
{ "tool": "pm_run", "args": { "action": "stats" } }
```

### Activity Review
```json
{ "tool": "pm_run", "args": { "action": "activity", "options": { "limit": "50" } } }
{ "tool": "pm_run", "args": { "action": "comments-audit", "options": { "limit": "20" } } }
```

### Contracts and Schema Check
```json
{ "tool": "pm_contracts", "args": {} }
```

## Finding Classification

| Severity | Action |
|----------|--------|
| Blocker | Create pm item with priority 0, status open |
| Warning | Create pm item with priority 1 |
| Info | Append to existing audit item comments |
| No issue | Log as evidence in audit comments |

## Evidence Format

```json
{
  "tool": "pm_comments",
  "args": {
    "id": "pm-xxxx",
    "author": "claude-code-agent",
    "options": {
      "add": "Audit evidence: health=ok, validate=ok (2 warnings), dedupe=5 candidates, items=681, tests=1087 passing."
    }
  }
}
```

## Privacy

Keep sensitive operational data (telemetry credentials, user PII, internal endpoints) out of public docs and tracked comments. Use `pm notes` for sensitive context instead of `pm comments`.
