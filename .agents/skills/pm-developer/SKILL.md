---
name: pm-developer
description: Runs the pm-cli developer execution loop (orient, claim, implement, verify, close) with linked files/tests/docs evidence, under an explicit token budget. Use when coding, debugging, refactoring, or shipping repository changes tracked in pm items.
license: MIT
compatibility: Works in terminal-based coding agents with bash, Node.js, and pnpm.
metadata:
  owner: unbrained
  domain: pm-cli
  scope: developer-workflow
---

# pm Developer Skill

Implementation work that changes code, docs, tests, or release gates. `pm` is the
system of record: every change is linked to an item, and every mutation is
recorded in an append-only history stream.

## Load Order

Load only the tier the task needs. Costs are measured, not estimated.

| Tier | Load                                          | Cost      | When                                     |
| ---- | --------------------------------------------- | --------- | ---------------------------------------- |
| 0    | This file                                     | ~650 tok  | Always.                                  |
| 1    | `pm next` or `pm context --limit 10`          | ~2.1-2.5k | Pick or resume work.                     |
| 2    | `pm contracts --command <cmd> --flags-only`   | ~1-3.4k   | Exact flags for one command.             |
| 2    | `pm guide <topic> --depth brief`              | ~0.6-1k   | A capability family you have not used.   |
| 3    | `references/*.md` below                       | ~0.3-1k   | Repeatable procedure detail.             |
| 4    | `docs/*.md`                                   | 0.7k-45k  | Only when a reference routes you there.  |

Never load `docs/COMMANDS.md` (~29k) or `docs/SDK.md` (~45k) whole. Both are
routed into by section from the references below.

Optional deep routing that never goes stale:

```bash
pm install guide-shell --project
pm guide workflows --depth brief
```

## Non-Negotiables

- Author identity is detected automatically. **Never pass `--author` and never
  set `PM_AUTHOR`.** The harness, model, effort, role, and topic are probed and
  recorded on every history entry.
- Never edit files under `.agents/pm` directly. Every mutation goes through `pm`.
- Never claim an item's state from memory. Read it live before asserting it.
- Claim before substantial edits; release when paused, handed off, or closed.
- Search before creating. Record the duplicate check as a create-time comment.

## Canonical Loop

```bash
pm next                                   # or: pm context --limit 10
pm search "<task keywords>" --limit 10
pm claim <ID>
pm update <ID> --status in_progress --message "Start implementation"
# ...implement...
pm files <ID> --add path=<path>,scope=project,note="<why>"
pm docs  <ID> --add path=<doc>,scope=project,note="<why>"
pm test  <ID> --add command="node scripts/run-tests.mjs test -- <target>",scope=project,timeout_seconds=240
pm comments <ID> "Evidence: <what changed and what passed>"
pm test <ID> --run --progress
pm close <ID> "<reason with evidence>" --validate-close warn
pm release <ID>
```

## Capability Map

Capability families and their commands are generated from the public SDK
contract. Start with `pm guide capabilities`, expand only the family the task
enters, and use these drift-gated references:

- [Capability routing](../../../docs/generated/AGENT_CAPABILITY_ROUTING.md)
- [Visibility tiers and families](../../../docs/generated/AGENT_COMMAND_SURFACE.md)

`pm help` shows the bounded core tier. Use `pm guide capabilities`, `pm
contracts --summary`, or `pm <command> --help --json` for progressive
disclosure into the wider surface.

## Token Discipline

Every read declares a default ceiling and degrades deterministically rather
than truncating silently. Choose in this order:

1. **Projection** — ask for fewer fields: `pm get <ID> --output-include id,title,status,dependencies`.
2. **Row limit** — `--output-limit 20`, or the command's own `--limit`.
3. **Budget** — `--output-budget <tokens>` only when the first two are set.
4. **Continuation** — when a response carries `output_budget_truncation`, use
   the declared `--output-cursor`. Re-running with `--output-budget unbounded`
   can cost orders of magnitude more.

Always read the `omission_receipt` before treating a result as complete. See
[Token budgets and read output](references/TOKEN_BUDGETS.md).

## Verification Defaults

```bash
pnpm build
node scripts/run-tests.mjs test -- <targets>
node scripts/run-tests.mjs coverage
pm validate --check-resolution --check-history-drift
pm health --summary
```

Repository-wide gates before proposing a merge: `pnpm quality:static`.

## References

| Need                                             | Load                                                     | Cost     |
| ------------------------------------------------ | -------------------------------------------------------- | -------- |
| Command recipes for the developer loop            | [Command playbook](references/COMMAND_PLAYBOOK.md)        | ~275 tok |
| Prompt templates                                  | [Prompts](references/PROMPTS.md)                          | ~250 tok |
| Bounded reads, cursors, projections, receipts     | [Token budgets](references/TOKEN_BUDGETS.md)              | ~900 tok |
| Typed edges, traversal, planning analytics        | [Relationship graph](references/GRAPH_AND_RELATIONSHIPS.md) | ~900 tok |
| Branching, merging, concurrent agents             | [Multi-agent and merge](references/MULTI_AGENT_MERGE.md)  | ~800 tok |
| Composing pm with grep, jq, xargs, and scripts    | [Scripting](references/SCRIPTING_COMPOSITION.md)          | ~800 tok |
