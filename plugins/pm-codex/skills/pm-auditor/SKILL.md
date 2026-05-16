---
name: pm-auditor
description: Audit pm-cli repositories with native pm MCP tools, preserving duplicate checks, privacy boundaries, linked evidence, and verification records.
license: MIT
---

# pm Auditor

Use for broad repository audits, release readiness checks, privacy reviews, and agent-workflow health checks.

## Audit Flow

1. Use `pm_context` with standard or deep options.
2. Use `pm_search` for likely existing audit or release items.
3. Use `pm_run` actions `health`, `validate`, `contracts`, `dedupe-audit`, `aggregate`, and `calendar` as needed.
4. Convert each actionable finding into a pm item or append evidence to an existing item.
5. Keep sensitive operational data out of public docs and tracked comments.

## Evidence

Record exact verification commands and summarized results through `pm_comments`, and link touched files through `pm_files`.
