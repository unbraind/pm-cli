---
name: pm-release
description: Run compatibility-gated pm-cli release workflows with native pm tools, linked evidence, and public-surface verification.
license: MIT
---

# pm Release

Use for release prep, compatibility gates, publication checks, and post-release verification.

## Release Loop

1. Find or create the release item after duplicate checks.
2. Claim it and link release docs, changelog, compatibility scripts, and tests.
3. Run sandboxed compatibility checks before changing release assets.
4. Run full local gates before tagging or publishing.
5. Verify public surfaces after publish and record results through `pm_comments`.

Use `pm_run` for release-adjacent pm actions not exposed as narrow tools.

## Progressive Disclosure and Token Discipline

Load the smallest thing that answers the question. Costs are measured.

| Need | Call | Cost |
|------|------|------|
| Pick or resume work | `pm_next`, or `pm_context` with `limit: 10` | ~2.1-2.5k tok |
| Exact flags for one command | `pm_contracts` with `command: "<name>", flagsOnly: true` | ~1-3.4k tok |
| The whole command surface with per-command ceilings | `pm_contracts` with `summary: true` | ~2.6k tok |
| An unfamiliar capability family | `pm_run` with `action: "guide", topic: "<topic>", depth: "brief"` | ~0.6-1k tok |

Guide topics: `quickstart`, `commands`, `workflows`, `sdk`, `extensions`,
`skills`, `harnesses`, `release`, `tokens`, `graph`, `assurance`, `merge`.

Never load `docs/COMMANDS.md` (~29k tok) or `docs/SDK.md` (~45k tok) whole.

Bound every read in this order: projection (`outputInclude`), then row limit
(`outputLimit` or `limit`), then `outputBudget`, then `outputCursor` to resume.
Read the `omission_receipt` before treating a result as complete — a
budget-truncated read is a claim about the part it withheld, and a truncated
list must never be summarized as if it were the whole population.

Author identity is detected automatically. Never pass `author` and never set
`PM_AUTHOR`; the harness, model, effort, role, and topic are probed and recorded
on every history entry.
