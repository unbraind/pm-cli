---
description: Run pm release-readiness — validation, coverage gate, changelog check, GitHub CI verification — with live TUI tracking. Accepts an optional version or release item ID as argument.
---

Run the full pm release workflow using native MCP tools. Argument: `$ARGUMENTS` (optional: version like `v1.2.3`, or pm item ID for an existing release item).

1. **Find or create the release item**:
   - `pm_search` with query "release" to find existing release items.
   - If `$ARGUMENTS` is a pm ID: `pm_get` it directly.
   - If no match: `pm_create` with `type: "Chore"`, `title: "Release <version>"`, `priority: "0"`.
2. **Claim** with `pm_claim` and `author: "claude-code-agent"`.
3. **Sync to Claude Code task panel**:
   ```
   TaskCreate:
     subject: "[pm-xxxx] Release: <version>"
     description: "Release gate tracking — pm-xxxx"
     activeForm: "Running release gates"
   ```
   Call `TaskUpdate(in_progress)`. Save the taskId.
4. **Link release artifacts**:
   - `pm_docs` — link `CHANGELOG.md`
   - `pm_files` — link `package.json`
5. **Run gates** (all must pass before tagging):
   - `pnpm build`
   - `node scripts/run-tests.mjs coverage`
   - `pm_validate` with `checkResolution: true, checkHistoryDrift: true, checkFiles: true`
   - `pm_health`
   - `node scripts/release/run-gates.mjs` (if present)
6. **Record gate results** with `pm_comments`:
   ```
   "Release evidence: build ok. N tests pass. 100% coverage. pm validate ok. pm health ok."
   ```
7. **Tag and push** (if all gates pass):
   ```bash
   git tag v<version> && git push origin v<version>
   ```
8. **Verify CI** — `gh run list --limit 5` and confirm all checks are green.
9. **Post-CI evidence** — add a final `pm_comments` with CI run URL.
10. **Close** — `pm_close` with reason, `pm_release`, then `TaskUpdate(completed)`.

Do not tag if any gate fails. Report the failing gate and what's needed to fix it.
