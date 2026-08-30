# Multiple Agents, Branches, and Merges

Tracker data is versioned alongside the code, so several agents can work on
separate branches and merge without hand-resolving item files. Full contract:
[docs/MERGE_SAFETY.md](../../../../docs/MERGE_SAFETY.md) (~4.4k tok).

## Once Per Clone Or Worktree

The `.gitattributes` merge fence is committed, but the driver definitions it
names are clone-local git config. A fresh clone or worktree merges tracker data
textually until the installer has run:

```bash
pm merge install
pm merge install --dry-run     # preview
```

Skipping this is the single most common cause of tracker merge conflicts.

## Ownership Across Agents

- `pm claim <ID>` before substantial edits. A claim is a recorded lease, not a
  lock file, and it survives branching.
- `pm release <ID>` when pausing, handing off, closing, or canceling.
- `pm list --status in_progress` shows what the fleet currently holds.
- Never force an ownership or lock override without explicit human approval.

Author identity is detected per invocation — harness, model, effort, role, and
topic — so two agents on the same branch remain distinguishable in history
without anyone passing `--author`.

## What Merges Field-Aware

The driver resolves four artifact classes: `item`, `history`, `relationship`,
and `json`. Set-valued fields such as tags and dependency rows union rather
than collide. Scalar fields follow the recorded field policy.

Two properties to keep in mind when designing concurrent work:

- **Additive beats rewriting.** `pm comments`, `pm notes`, and `--dep` append.
  Rewriting a description or replacing acceptance criteria on two branches is a
  genuine conflict that no driver can invent an answer for.
- **Independent ids do not collide** unless two branches mint the same id for
  unrelated items. Prefer creating items on a branch that has seen the other
  branch's ids when doing bulk creation.

## After A Merge

A clean field-aware merge can still leave history streams needing
reconciliation. Always run the post-merge gate:

```bash
pm merge report
pm merge reconcile --message "Post-merge history reconciliation"
pm validate --check-history-drift
pm health --check-only
```

`pm merge report` lists what the driver decided and what it discarded. Review
it before reconciling; reconciliation is an audited write.

## Proving Nothing Was Lost

```bash
pm validate --check-resolution --check-history-drift
pm graph audit
pm activity --limit 20
```

History is append-only and hash-chained. `--check-history-drift` compares each
stream's recorded chain against its contents, so a silently rewritten entry
fails the check rather than passing unnoticed.
