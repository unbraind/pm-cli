# Recovering missing close evidence

Tracked by [pm-ub1ott](../.agents/pm/issues/pm-ub1ott.toon),
[pm-gh1464](../.agents/pm/issues/pm-gh1464.toon) and
[pm-gh1676](../.agents/pm/issues/pm-gh1676.toon).

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

## Strict closes refused for missing evidence

`pm close --validate-close strict` refuses with
`close_validation_missing_fields` (exit 2) and writes nothing. Because
`pm close` accepts `--resolution`, `--expected-result` and `--actual-result`
itself, `recovery.suggested_retry_args` is the caller's own close invocation
with each missing flag appended. Every typed token is kept as it was: the item
id, reason, tracker selection, `--json`, `--expect-hash` and the rest. The
appended flag also overrides a blank value supplied for that field, because the
parser keeps the last value of a repeated option. When a `--` follows the
command, the flags go directly after the command token instead. When the
invocation named no tracker, the tracker an environment selection (`PM_PATH`)
resolved is prepended. Replace each `<value>` and run it: one write records the
evidence and the closure in the same history entry.

When the refused command cannot accept the missing fields itself (for example
`pm close-task`), or the flags cannot be placed safely, the refusal proposes no
retry rather than one that drops the caller's tokens. `recovery.missing` still
names the fields: record them with `recovery.next_best_command`, then repeat the
original command. An SDK close whose `lifecyclePolicy` override has no CLI
spelling likewise gets no CLI retry and is told to retry the SDK call with the
evidence supplied. An SDK or MCP retry carries the revision guards
(`--expect-hash=<id>=<hash>`) that the refused operation ran under.

```bash
pm --pm-path <tracker-root> close <item-id> "Delivered" --validate-close strict \
  --resolution "<value>" --expected-result "<value>" --actual-result "<value>"
```

`recovery.next_best_command` keeps the two-step route (`pm update` with the
missing fields, then the close) for callers that must record evidence before
deciding to close. It costs a second write and history entry.
