# Recovering missing close evidence

Tracked by [pm-ub1ott](../.agents/pm/issues/pm-ub1ott.toon).

`pm close --validate-close warn` can close an item while reporting missing
resolution, expected outcome, or actual outcome. Its SDK result and compact CLI
output now include `recovery.missing`, `suggested_retry`, and
`suggested_retry_args` when evidence is incomplete. The argument vector selects
the same tracker and uses `pm update` to add only the missing evidence fields.
Replace each `<value>` with the observed outcome before executing it.

```bash
pm update <item-id> --resolution "Implemented the recovery contract" \
  --expected "Preserve the original close event" \
  --actual "Evidence update appended; original close event unchanged"
```

An attempt to close an already terminal item also returns evidence-update
recovery when applicable. `--force` is reserved for an intentional repeated
lifecycle transition. Adding evidence with `pm update` preserves the original
close timestamp, close reason, and immutable history event, then appends a
normal update event. It does not retroactively claim that evidence existed at
the original close. Complete closes have no extra recovery payload.

For new work, include all three fields in the original close command so its
immutable event contains the full evidence. Warning-mode recovery exists for
incomplete historical or interrupted workflows.
