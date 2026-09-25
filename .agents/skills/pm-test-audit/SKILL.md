---
name: pm-test-audit
description: Use when writing, changing, reviewing, or auditing pm-cli tests. Checks regression value, duplicate coverage, implementation coupling, and test-only production seams while preserving SDK contracts, sandbox isolation, and exact coverage gates.
license: MIT
compatibility: Repository development with Node.js, pnpm, and the checkout-built pm CLI.
metadata:
  owner: unbrained
  domain: pm-cli
  scope: test-quality
---

# pm Test Audit

Tracker: [pm-xvibt6](../../pm/tasks/pm-xvibt6.toon).
Adapted from OpenClaw's [test-audit skill](https://github.com/openclaw/openclaw/blob/e0d80000067d224e93af6107ed093a21e046879f/.agents/skills/test-audit/SKILL.md);
upstream copyright and terms are in [LICENSE.txt](LICENSE.txt).

Use alongside [pm-developer](../pm-developer/SKILL.md). Project management is
context management: retain why a test exists, its contract owner, and the
regression evidence so the next audit need not rediscover them.

## Choose the Scope

- **Authoring:** apply the four questions below before adding or changing tests.
- **Audit:** read [audit evidence](references/AUDIT.md) before proposing removals.
- **Campaign:** also read [campaign procedure](references/CAMPAIGN.md) for a broad sweep.

Do not expand a focused request into a repository-wide deletion campaign.

## Four Questions Before Editing

1. What observable behavior, invariant, or independent contract does this prove?
2. What credible regression makes it fail? For a bug fix, demonstrate the intended
   failure before the fix and success afterward with the same test and harness.
3. Why does existing coverage not catch it? Choose one primary owner at the
   strongest useful boundary. An additional layer needs a distinct risk, such as
   CLI parsing, MCP transport, persistence, or package installation. Extend a
   table or shared fixture when the behavior and setup are already covered.
4. Does it demand a production export, flag, wrapper, or injection hook solely
   to observe private details? Prefer exercising the real boundary. Published
   `@unbrained/pm-cli/sdk/testing` helpers are public contracts, not automatically
   disposable test-only seams.

Domain semantics belong in the SDK; thin CLI/MCP adapters need their own transport
proof, not copies of every SDK case. Read complete tests and production owners
before editing, plus relevant callers, neighboring tests, history, and scoped
`AGENTS.md`. Inspect actual dependency types in `node_modules`; do not guess APIs.

## Verification and Safety

Follow [Testing](../../../docs/TESTING.md) for the affected surface. Use the
repository runner, which isolates tracker roots and builds the checkout:

```bash
node scripts/run-tests.mjs test -- <target>
node scripts/run-tests.mjs coverage
```

- Never run tests against the real `.agents/pm`. Manual dogfood uses a temporary
  workspace outside this checkout and its ancestor workspaces, with both
  `PM_PATH` and `PM_GLOBAL_PATH` isolated. Clean up only directories you created.
- Do not edit source while a runner or build owns it. Negative controls and
  pre-fix comparisons belong in an isolated copy/worktree, not a live checkout
  used by another command. Change the intended condition; unrelated setup
  failures do not establish regression sensitivity.
- Keep canonical full-source coverage at **100/100/100/100**. Do not shrink the
  denominator, add ignore directives, lower gates, or duplicate assertions to
  recover a number. Restore meaningful behavioral proof when coverage drops.
- Mocks may isolate external boundaries; they must not implement the behavior
  being tested. Use real temporary persistence when proving writes or recovery.
- Run relevant functional, integration, package, performance, and acceptance
  gates according to the changed contract. A focused green run is not a full
  suite result. [Quality evidence](../../../docs/QUALITY_EVIDENCE.md) defines the
  bounded mutation gate; do not describe it as whole-repository mutation proof.
- Preserve static quality, docstring, security, release, and public-surface gates.
  This skill does not grant exceptions to repository coding rules.

## PM Evidence and Handoff

Bootstrap and orient using root `AGENTS.md`; search all statuses before creating
work. Read the selected item's full metadata and history, follow omission
receipts, then claim/start only items actually being edited. Keep investigation
read-only until there is a justified change. Use typed relationships for real
ownership, dependencies, or verification; never manufacture graph depth.

Link files, docs, and sandbox-safe test commands through `pm`. Record retained
contracts, removed duplication, pre-fix failure and post-fix proof, commands and
results, and limitations. Reuse canonical follow-up items for product defects;
never delete a failing regression merely to make the suite green. Close with
structured evidence and release the claim, or return paused work to an appropriate
non-active state. Delivery and review follow the user's authorized scope and
[review loop](../../../docs/PR_REVIEW_LOOP.md).

For current command flags use command-specific help/contracts. Optional deeper
workflow guidance is available after installing guide-shell:

```bash
pm package install guide-shell --project
pm guide workflows --depth brief
```
