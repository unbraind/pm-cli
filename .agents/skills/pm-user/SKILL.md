---
name: pm-user
description: Guides user- and operator-facing pm-cli workflows for planning, triage, prioritization, and task lifecycle management with minimal token usage. Use when routing requests into pm items without implementing code changes.
license: MIT
compatibility: Works in terminal-based agent harnesses that execute pm CLI commands.
metadata:
  owner: unbrained
  domain: pm-cli
  scope: operator-workflow
---

# pm User Skill

Use this skill for planning and coordination work where the main output is clean tracker state.

## Quick Start

```bash
pm guide quickstart
pm context --limit 10
pm search "<request keywords>" --limit 10
pm list-open --limit 20
pm list-in-progress --limit 20
```

## Primary Use Cases

- Intake a new request and decide whether an item already exists.
- Create parent lineage (`Epic` -> `Feature` -> `Task`) for net-new scope.
- Prioritize and schedule work with deterministic metadata.
- Maintain clear ownership and handoff notes.

## Workflow Prompts

### Prompt: New Request Triage

`Triage this request using pm only. Reuse an existing item if relevant; otherwise create canonical parent lineage and a scoped child item with duplicate-check evidence.`

### Prompt: Prioritization Sweep

`Review open and in-progress items, normalize priority/status metadata, and leave append-only notes explaining why any prioritization changed.`

### Prompt: Handoff Preparation

`Prepare handoff for <ID>: summarize state in comments, ensure linked files/tests/docs are complete, and release claim when ready.`

## Deterministic Metadata Commands

```bash
pm update <ID> --description "..." --ac "..." --estimate 60
pm update <ID> --deadline +2d --priority 1 --status open
pm comments <ID> "Decision log: <why this status/priority>"
pm notes <ID> --add "Context for next owner."
```

## Progressive Disclosure References

- [Triage and planning workflows](references/WORKFLOWS.md)
- [Operator prompt templates](references/PROMPTS.md)
