# Recovering missing close evidence

Tracked by [pm-ub1ott](../.agents/pm/issues/pm-ub1ott.toon).

`pm close --validate-close warn` can close an item while reporting missing
resolution, expected outcome, or actual outcome. Its SDK result and compact CLI
output now include `recovery.missing`, `suggested_retry`, and
`suggested_retry_args` when evidence is incomplete. The argument vector selects
the same tracker and uses `pm update` to add only the missing evidence fields.
Use `recovery.suggested_retry_args` as the authoritative argument vector. Replace
each `<value>` with the observed outcome before executing it; retain its tracker
selection and only the flags it supplies for missing fields. Do not add flags
for evidence already present, because `pm update` would overwrite that evidence.

For example, when only the actual outcome is missing, the recovery arguments
contain `--actual-result` alone (plus the item and tracker selection):

```bash
pm --pm-path <tracker-root> update <item-id> \
  --actual-result "Evidence update appended; original close event unchanged"
```

An attempt to close an already terminal item also returns evidence-update
recovery when applicable. `--force` is reserved for an intentional repeated
lifecycle transition. Adding evidence with `pm update` preserves the original
close timestamp, close reason, and immutable history event, then appends a
normal update event. It does not retroactively claim that evidence existed at
the original close. Complete closes have no extra recovery payload.

The update flags for the other missing fields are `--resolution` and
`--expected-result`; include them only when the generated recovery requests them.

For new work, include all three fields in the original close command so its
immutable event contains the full evidence. Warning-mode recovery exists for
incomplete historical or interrupted workflows.
