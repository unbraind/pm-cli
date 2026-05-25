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
- Evidence: `pm_comments`, `pm_files`, `pm_docs`, `pm_test`
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
  "author": "codex-agent",
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
