---
name: pm-developer
description: Runs the pm-cli developer execution loop (orient, claim, implement, verify, close) with linked files/tests/docs evidence. Use when coding, debugging, refactoring, or shipping repository changes tracked in pm items.
license: MIT
compatibility: Works in terminal-based coding agents with bash, Node.js, and pnpm.
metadata:
  owner: unbrained
  domain: pm-cli
  scope: developer-workflow
---

# pm Developer Skill

Use this skill for implementation work that changes code, docs, tests, or release gates.

## Quick Start

```bash
pm context --limit 10
pm search "<task keywords>" --limit 10
pm list-open --limit 20
pm claim <ID>
pm update <ID> --status in_progress
pm guide workflows
```

## Canonical Workflow

1. **Orient**: pick an existing item when possible.
2. **Claim**: claim before substantial edits.
3. **Link context**: attach changed files/tests/docs while implementing.
4. **Verify**: run linked tests plus local quality gates.
5. **Close with evidence**: append what changed and what passed.
6. **Release claim**: release when paused, handed off, or closed.

## Workflow Prompts

Use one prompt template, then execute only the minimum required commands.

### Prompt: Implement Scoped Change

`Implement the requested change on <ID>. Keep edits scoped, link files/tests/docs, run targeted verification, and record closure evidence before releasing claim.`

### Prompt: Debug Regression

`Investigate failing behavior for <ID>. Reproduce first, add or update regression tests, patch root cause, and append evidence with exact command outputs.`

### Prompt: Documentation + Code Sync

`Update implementation and docs together for <ID>. Ensure docs route through pm guide topics and verify command examples still match pm contracts output.`

## Required Evidence Commands

```bash
pm files <ID> --add path=<path>,scope=project,note="<reason>"
pm test <ID> --add command="node scripts/run-tests.mjs test -- <target>",scope=project,timeout_seconds=240
pm docs <ID> --add path=<doc>,scope=project,note="<reason>"
pm comments <ID> "Evidence: <what changed + tests run>"
```

## Verification Defaults

```bash
pnpm build
node scripts/run-tests.mjs test -- <targets>
node scripts/run-tests.mjs coverage
pm validate --check-resolution --check-history-drift
```

## Progressive Disclosure References

- [Developer command playbook](references/COMMAND_PLAYBOOK.md)
- [Prompt templates and examples](references/PROMPTS.md)
