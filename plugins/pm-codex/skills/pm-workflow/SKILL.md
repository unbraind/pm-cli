---
name: pm-workflow
description: Use when starting, resuming, or handing off work in a repository managed by pm. Orient from live context, reuse existing items, and leave evidence for the next agent.
license: MIT
---

# pm Workflow

Project management is context management. Read the live tracker before describing
work as open, blocked, or done. Use the bundled pm MCP tools when available;
use the pm CLI with the same contracts when they are not.

## Orient

1. Read pm_context with a bounded limit, then pm_list for open and in-progress work.
2. Search all statuses before creating an item. Inspect the candidate's full
   metadata, comments, notes, learnings, dependencies, and history.
3. Follow omission receipts and cursors before making a completeness claim.
4. Cross-check release, CI, package, or infrastructure claims against the live
   system that owns them.

## Work and hand off

Claim only an item being actively edited. Link files, docs, tests, and typed
relationships that express a real dependency or outcome. Record concise
evidence, then close with resolution, expected, and actual results when the
acceptance criteria are met. Release the claim when stopping.

For handoff, report the item IDs, exact current status, last verified result,
remaining work, and the next read command. Do not copy the entire tracker.

## Host adapters

In Claude Code, mirror a claimed item in the task panel when TaskCreate and
TaskUpdate are available. Keep pm as the durable source of truth. In Codex,
use the native MCP tools and the same claim, evidence, close, and release loop.

Use pm_contracts for exact active flags and pm_run for actions without a narrow
tool. Never set a static author; let the host identity be detected.
