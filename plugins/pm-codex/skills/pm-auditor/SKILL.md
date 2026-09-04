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
4. Convert each actionable finding into a pm item or append evidence to an existing item.
5. Keep sensitive operational data out of public docs and tracked comments.

## Evidence

Record exact verification commands and summarized results through `pm_comments`, and link touched files through `pm_files`.

## Progressive Disclosure and Token Discipline

Load the smallest thing that answers the question. Costs are measured.

| Need | Call | Cost |
|------|------|------|
| Pick or resume work | `pm_next`, or `pm_context` with `limit: 10` | ~2.1-2.5k tok |
| Exact flags for one command | `pm_contracts` with `command: "<name>", flagsOnly: true` | ~1-3.4k tok |
| The whole command surface with per-command ceilings | `pm_contracts` with `summary: true` | ~2.6k tok |
| An unfamiliar capability family | `pm_run` with `action: "guide", topic: "<topic>", depth: "brief"` | ~0.6-1k tok |

Guide topics are declared at runtime: `pm guide` prints the current index and
`pm guide <topic> --depth brief` expands one topic. Do not copy the list.

Never load `docs/COMMANDS.md` (~29k tok) or `docs/SDK.md` (~45k tok) whole.

Bound every read in this order: projection (`outputInclude`), then row limit
(`outputLimit` or `limit`), then `outputBudget`, then `outputCursor` to resume.
Read the `omission_receipt` before treating a result as complete — a
budget-truncated read is a claim about the part it withheld, and a truncated
list must never be summarized as if it were the whole population.

Author identity is detected automatically. Never pass `author` and never set
`PM_AUTHOR`; the harness, model, effort, role, and topic are probed and recorded
on every history entry.
