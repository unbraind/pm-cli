---
name: pm-release
description: Run pm-cli release-readiness workflows — validation, coverage gates, changelog, GitHub checks — using native MCP tools with linked evidence. Use when preparing releases, publishing, or verifying post-release state.
---

# pm Release

Use for release preparation, publication, and post-release verification.

## Release Loop

1. **Find or create** the release pm item (after duplicate check with `pm_search`).
2. **Claim** it — then call `TaskCreate` to show the release in Claude Code's task panel.
3. **Run local gates** before tagging:
   - `pnpm build` — clean build
   - `node scripts/run-tests.mjs coverage` — full coverage gate
   - `pm_validate` with all checks
   - `pm_health` for tracker status
4. **Tag and push** — let CI run.
5. **Verify GitHub checks** — `gh run list --limit 5` after push.
6. **Record evidence** with `pm_comments`.
7. **Close and release** the pm item, then `TaskUpdate(completed)`.

## Hybrid TUI Sync

### After claiming the release item
```
TaskCreate:
  subject: "[pm-xxxx] Release: <version>"
  description: "Release gate tracking for pm-xxxx"
  activeForm: "Running release gates"
```
Save the `taskId`. Then `TaskUpdate(in_progress)`.

### After pm_close + pm_release
```
TaskUpdate: { taskId: <saved>, status: "completed" }
```

## MCP Calls

### Pre-Release Validation
```json
{ "tool": "pm_validate", "args": { "options": { "checkResolution": true, "checkHistoryDrift": true, "checkFiles": true } } }
{ "tool": "pm_health", "args": {} }
{ "tool": "pm_context", "args": { "options": { "depth": "standard" } } }
```

### Link Release Artifacts
```json
{ "tool": "pm_docs", "args": { "id": "pm-xxxx", "author": "claude-code-agent", "options": { "add": ["path=CHANGELOG.md,scope=project,note=release-notes"] } } }
{ "tool": "pm_files", "args": { "id": "pm-xxxx", "author": "claude-code-agent", "options": { "add": ["path=package.json,scope=project,note=version"] } } }
```

### Record Evidence
```json
{
  "tool": "pm_comments",
  "args": {
    "id": "pm-xxxx",
    "author": "claude-code-agent",
    "options": {
      "add": "Release evidence: build ok. Tests pass. 100% coverage. pm validate ok. GitHub CI green. npm publish ok."
    }
  }
}
```

## Gate Script Reference

```bash
pnpm build                                   # TypeScript build
node scripts/run-tests.mjs coverage          # Full test + coverage
node scripts/release/run-gates.mjs           # All release gates
gh run list --limit 5                        # GitHub CI status
gh run view <run-id>                         # Detailed run status
```

## Safety

- Never set `path` for real repository tracking — only for sandbox tests.
- Run coverage gate before any `npm publish` or version tag.
- Confirm GitHub CI green before closing the release item.
