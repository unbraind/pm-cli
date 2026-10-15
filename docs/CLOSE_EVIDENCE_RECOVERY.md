# Recovering missing close evidence

Tracked by [pm-ub1ott](../.agents/pm/issues/pm-ub1ott.toon) and
[pm-gh1464](../.agents/pm/issues/pm-gh1464.toon).

`pm close --validate-close warn` can close an item while reporting missing
resolution, expected outcome, or actual outcome. Its SDK result and compact CLI
output include an optional `follow_up` with `kind: complete_close_evidence`,
`missing`, `suggested_command`, and `suggested_command_args` when evidence is
incomplete. The close succeeded; do not retry it. The argument vector selects
the same tracker and uses `pm update` to add only the missing evidence fields.
Use `follow_up.suggested_command_args` as the authoritative argument vector. Replace
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
the original close. Failed terminal retries retain `recovery.suggested_retry_args`;
successful closes never emit failure recovery. Complete closes have no follow-up.

The update flags for the other missing fields are `--resolution` and
`--expected-result`; include them only when the generated recovery requests them.

For new work, include all three fields in the original close command so its
immutable event contains the full evidence:

```bash
pm close <item-id> "Delivered and verified" --resolution "What changed" \
  --expected "Required outcome" --actual "Observed outcome" --validate-close warn
```

Warning-mode follow-up exists for incomplete historical or interrupted workflows.
