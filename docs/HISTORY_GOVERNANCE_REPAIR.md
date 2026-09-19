# History-derived governance repair

Tracked by [pm-wrbe](../.agents/pm/tasks/pm-wrbe.toon) and
[pm-pivf](../.agents/pm/chores/pm-pivf.toon).

Project history is context: maintenance must preserve when work happened and
why related occurrences share an identity.

## Recovering legacy closure dates

```bash
pm validate --check-metadata --fix-hints
pm validate --check-metadata --auto-fix --fix-scope timestamps --dry-run --json
pm validate --check-metadata --auto-fix --fix-scope timestamps --json
```

The `timestamps` scope is opt-in. It fills only missing `closed_at` fields on
terminal items. The exact scope allowlist leaves unrelated metadata, estimates,
resolution and lifecycle repairs gated. A dry run performs no item mutation.
Checks describe the pre-repair state; run validation again to prove convergence.

Dates come from verified replay of the item's complete available history,
including a comparison against the current item. The selected date is the first
transition in its final uninterrupted terminal interval. A reopen resets that
interval. Ordinary metadata edits do not advance it. Terminal creation counts;
a compaction or repair baseline carrying terminal state alone does not establish
when the original closure happened. Existing dates and `completed_at` are never
rewritten. Custom terminal statuses and their registered aliases are recognized.

Missing, unreadable, invalid or insufficient history is reported in
`closure_timestamp_residual` with a reason and total count. Bounded human output
marks truncated rows; JSON or `--verbose-diagnostics` restores full diagnostics
(subject to the separately declared output budget). `closure_history_inspected`
distinguishes a lightweight missing-date count from a verified derivation pass.

Every applied date is re-derived under the normal item mutation lock and appends
an audited `update` event. A stale proposal fails instead of assigning an
unverified date. Retrying an already repaired item is a no-op.

The public `@unbrained/pm-cli/sdk/governance` surface exposes
`deriveClosureTimestamp`, `scanClosureTimestamps`, `applyClosureTimestampFix`
and `runValidate`. SDK hosts can use `runValidate({checkMetadata: true,
autoFix: true, fixScope: ["timestamps"], dryRun: true}, {path: pmRoot})` to obtain
the same plan as the CLI; timestamp repairs do not need a CLI mutation adapter.

## Shared issue codes and typed lineage

Duplicate issue-code validation accepts explicit `discovered_from`, `supersedes`
and `incident_from` links targeting another item in the same issue-code group.
This joins the existing parent/child and adjudicated-duplicate rules. A follow-up
can retain its real upstream issue code without renaming historical work.

Derivation must reach a root. Cycles and their dependent followers remain
collisions, as do unrelated items, self references, references to different code
groups, and `related`, `implements` or ordering links. An independent collision
still appears when a group also contains legitimate follow-ups. No graph edges
are fabricated to satisfy validation.

## Repository backfill verification

Before applying a historical backfill, save the generated changelog's item-to-
release membership and inspect the complete repair preview. Regenerate with the
latest `pm-changelog` package afterward and compare membership. Row ordering may
change when a proven date replaces a mutable fallback; release attribution must
remain intact. Run history-drift validation and repeat the timestamp preview to
prove integrity and idempotence. Any generator defect belongs in `pm-changelog`.
