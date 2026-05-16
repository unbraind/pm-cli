---
description: Close a pm-tracked task with evidence — verify tests pass, link changed files, add closing comment, close and release in pm, then mark the Claude Code task panel entry as completed. Accepts an optional item ID as argument.
---

Use native pm MCP tools to close a tracked task with evidence. Argument: `$ARGUMENTS` (item ID like `pm-xxxx`, or empty to show in-progress items).

1. **Find the item**:
   - If `$ARGUMENTS` is an ID: call `pm_get` with that ID and confirm it's the right item.
   - If empty: call `pm_list` filtered to in_progress and ask the user which to close.
2. **Review acceptance criteria** from the item's `acceptance_criteria` field.
3. **Verify** — run linked tests with `pm_test` (with `run: true`) if any are linked.
4. **Validate** — call `pm_validate` with `options: { checkResolution: true }`.
5. **Link any missing files** with `pm_files` for changed source files.
6. **Add closing evidence** with `pm_comments`: a brief summary of what changed and what was verified.
7. **Close** with `pm_close` and a clear reason that addresses the acceptance criteria.
8. **Release** with `pm_release`.
9. **Sync TUI** — if a `TaskCreate` was called for this item during this session, call `TaskUpdate` with `status: "completed"` using the saved taskId. If no taskId is known, note the closure in the response.
10. **Report** confirmation with the item ID and closing reason.

Do not close if acceptance criteria are not met — instead report what's missing.
