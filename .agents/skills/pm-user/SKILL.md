---
name: pm-user
description: Guides user- and operator-facing pm-cli workflows for intake, triage, prioritization, planning, and reporting under a bounded token budget. Use when routing requests into pm items, organizing a backlog, or reporting on state without implementing code changes.
license: MIT
compatibility: Works in terminal-based agent harnesses that execute pm CLI commands.
metadata:
  owner: unbrained
  domain: pm-cli
  scope: operator-workflow
---

# pm User Skill

Planning and coordination work where the output is clean tracker state, not
code. The tracker is the project's context: an item is well-formed when another
agent can rebuild the full situation from it alone.

## Load Order

| Tier | Load                                  | Cost      | When                           |
| ---- | ------------------------------------- | --------- | ------------------------------ |
| 0    | This file                             | ~650 tok  | Always.                        |
| 1    | `pm context --limit 10`               | ~2.1k     | Orient in an existing project. |
| 1    | `pm search "<terms>" --limit 10`      | ~0.5-1k   | Before creating anything.      |
| 2    | `pm guide <topic> --depth brief`      | ~0.6-1k   | An unfamiliar family.          |
| 3    | `references/*.md` below               | ~0.3-1k   | Procedure detail.              |

Optional deep routing that never goes stale:

```bash
pm package install guide-shell --project
pm guide quickstart
pm guide commands --depth brief
```

## Non-Negotiables

- Author identity is detected automatically. **Never pass `--author`, never set
  `PM_AUTHOR`.**
- Search before creating; record the duplicate check as a create-time comment.
- Never delete items by search match — only by exact id.
- Prefer appending (`pm comments`, `pm notes`) over rewriting item content.
- Never assert an item's state from memory. Read it live first.

## Intake Loop

```bash
pm context --limit 10
pm search "<request keywords>" --limit 10
pm list --status open --limit 20 --brief
# reuse if it exists; otherwise create with lineage
pm create --create-mode progressive \
  --title "..." --description "..." --type Task --status open \
  --parent <epic-or-feature-id> \
  --dep "id=<origin-item>,kind=discovered_from" \
  --ac "..." --priority 1 --risk medium --confidence medium
pm comments <ID> "Duplicate check: searched <terms>; nearest existing is <id> which covers <scope>."
```

## What Makes An Item Well-Formed

Use the metadata the tracker actually has. An item carrying only a title is a
placeholder, not a tracked unit of work.

| Field                                    | Why it matters                                     |
| ---------------------------------------- | -------------------------------------------------- |
| `--type`                                 | Routes into the right lifecycle and changelog bucket|
| `--parent`                               | Places the item in the ladder                       |
| `--dep "id=..,kind=.."`                  | Makes lineage machine-readable                      |
| `--ac`                                   | Defines done without argument                       |
| `--expected-result` / `--actual-result`  | Turns a defect into a reproducible claim            |
| `--priority`, `--risk`, `--confidence`   | Lets selection rank without a human                 |
| `--estimate`, `--deadline`               | Feeds scheduling and forecasting                    |
| `--resolution`, `--close-reason`         | Makes the closed record answerable later            |

`--risk` is an enum: `low`, `medium`, `high`, `critical`. `--ac` **replaces**
the criteria; `--dep` **appends**.

## Capability Map

| Need                        | Entry                                    | Guide topic  |
| --------------------------- | ---------------------------------------- | ------------ |
| What should I do next       | `pm next`                                | `quickstart` |
| Where does this project stand | `pm context`, `pm stats`               | `quickstart` |
| Find existing work          | `pm search`, `pm list`, `pm duplicates`  | `commands`   |
| Group and count             | `pm aggregate --group-by <field>`        | `commands`   |
| Lineage and ordering        | `pm deps`, `pm graph <verb>`             | `graph`      |
| Recent movement             | `pm activity`, `pm events`, `pm history` | `assurance`  |
| Durable lessons and records | `pm learnings`, `pm notes`, `pm history` | `evidence`   |
| Deadlines and meetings      | `pm remind`, `pm event`, `pm meet`       | `automation` |
| Data quality                | `pm validate`, `pm health`               | `assurance`  |
| Plan a multi-step change    | `pm plan`                                | `workflows`  |
| Custom types and statuses   | `pm schema`, `pm config`                 | `commands`   |
| Keep reads cheap            | `--output-*`, `--token-accounting`       | `tokens`     |

## Reporting Without Loading Rows

```bash
pm stats
pm aggregate --group-by status --json | jq '.groups'
pm list --status open --output-include id,title,priority --output-limit 20
```

`--group-by tags` groups by the whole tag **tuple**, not by individual tag.
Aggregate on a scalar field when a per-value count is what you want.

## References

| Need                              | Load                                          | Cost     |
| --------------------------------- | --------------------------------------------- | -------- |
| Triage and planning procedures     | [Workflows](references/WORKFLOWS.md)          | ~350 tok |
| Prompt templates                   | [Prompts](references/PROMPTS.md)              | ~250 tok |
| Backlog structure and item quality | [Backlog shaping](references/BACKLOG_SHAPING.md) | ~900 tok |
