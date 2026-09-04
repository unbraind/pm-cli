---
name: pm-native
description: Use pm-cli natively in Codex through bundled MCP tools for planning, tracking, mutation, validation, and reporting without invoking the pm shell command.
license: MIT
---

# pm Native Workflow

Use this skill whenever a Codex task should be tracked through pm.

## Tool Preference

Use MCP tools before shell commands:

- Orient: `pm_context`, `pm_search`, `pm_list`, `pm_get`
- Mutate: `pm_create`, `pm_update`, `pm_claim`, `pm_release`, `pm_close`
- Evidence: `pm_comments`, `pm_notes`, `pm_learnings`, `pm_files`, `pm_docs`, `pm_test`
- Verify: `pm_validate`, `pm_health`, `pm_contracts`
- Everything else: `pm_run` with an explicit `action`

Do not pass `path` during real repository work. For tests, pass a sandbox `cwd` or `path`.

## Required Loop

1. Run `pm_context`, `pm_search`, and `pm_list` before creating work.
2. Reuse an existing item when one matches.
3. Claim the item with `pm_claim`.
4. Link changed files/docs/tests as work proceeds.
5. Add concise evidence with `pm_comments`.
6. Run linked and project verification.
7. Close with `pm_close` and release with `pm_release`.

## Native Argument Shape

Most tools accept:

```json
{
  "cwd": "/repo/root",
  "options": {
    "limit": "10"
  }
}
```

`pm_run` accepts an `action` plus `options`:

```json
{
  "action": "calendar",
  "options": {
    "view": "week",
    "format": "markdown"
  }
}
```

## Plan workflow (`pm_plan`)

Codex-style living ExecPlans are first-class via the `Plan` item type and the `pm_plan` MCP tool. Use [Command Reference: Plan Workflow](../../../../docs/COMMANDS.md#plan-workflow) as the canonical lifecycle recipe; this skill keeps only Codex-specific routing notes.

Use `pm_plan` for plan-then-execute workflows; use `pm_create` with type Task/Feature/Epic for already-decomposed backlog work.

Invariants:

- One step `in_progress` at a time by default; pass `allowMultipleActive: true` for explicit parallel branches.
- Use `subcommand: block-step` with `stepBlockedReason` when discovery flips a step.
- Use `subcommand: materialize` once steps are concrete enough to become Tasks.

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
