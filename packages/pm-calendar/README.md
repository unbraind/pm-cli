# pm Calendar Package

`@unbrained/pm-calendar` provides scheduling shortcuts, agenda, and calendar views as an installable pm package.

```bash
pm package install calendar --project
# Or bootstrap all bundled package commands in a new project:
pm init --defaults --with-packages
pm calendar --view week --full-period
pm cal --json --view agenda --include reminders,events
```

The package owns presentation commands for deadline, reminder, and scheduled event views. Core pm still owns item metadata such as `deadline`, `reminders`, and `events`, plus create/update parsing for those fields.

Runtime sources are authored in TypeScript and use only the public `@unbrained/pm-cli/sdk` surface.

## Scheduling commands

Tracking: [pm-o3fh](../../.agents/pm/tasks/pm-o3fh.toon),
[pm-jkjt](../../.agents/pm/issues/pm-jkjt.toon).

```bash
pm calendar meet "Planning" --start +1d --duration 30min --location "Room A"
pm calendar event "Release window" --start 2026-10-01T09:00:00Z --duration PT2H
pm calendar remind "Review release" --at +2d --text "Check acceptance results"
```

The legacy `pm meet`, `pm event`, and `pm remind` spellings remain aliases.
Install `calendar` in each project where these commands are needed; without the
package, the CLI provides an installation hint. Core `create` and `update` retain
scheduling metadata primitives. SDK integrations can continue calling `runMeet`,
`runEvent`, and `runRemind` directly without installing presentation commands.

Meetings and events default to a start of `now` and a duration of `1h`.
An explicit `--end` overrides the shortcut's duration. Reminders default to `+1d`
and use the title as their reminder text. All three commands support parent,
tags, priority, body, description, history message, and the host's global author
and output options. Use `pm contracts --command "calendar meet" --flags-only`
for the active project's exact contract.

### Duration decision

Accepted [duration ADR](../../.agents/pm/decisions/pm-j1vw3a.toon).

Event durations accept integer `min`, `mins`, `minute`, or `minutes`; `h`, `d`,
`w`, or explicit `mo` for calendar months; and ISO time durations such as `PT30M`
or `PT1H30M`. Bare `m`, including signed values such as `+5m`, is rejected with
`min`/`mo` alternatives before mutation. This resolves the ambiguity recorded in
pm-jkjt and supersedes the duration compatibility decision in
[pm-zoe4](../../.agents/pm/features/pm-zoe4.toon).

This rule applies to shortcut durations and the shared `create`/`update` event
parser. Other relative date fields retain `m` for calendar months. Zero duration
creates an instant event; an end before the start is rejected. Calendar month
arithmetic clamps to the last valid day of the target month; compound offsets
such as `+1d+2h` are rejected.

## Recurrence Notes

Recurring event `recur_count` values are counted from the event series `start`, not from the query window. For example, a daily event starting April 1 with `recur_count=3` has its counted occurrences on April 1, 2, and 3; querying April 10 does not restart the count.

`recur_exdates` exclude occurrences by instant. Equivalent timestamp spellings such as `2026-04-02T09:00:00Z`, `2026-04-02T09:00:00.000Z`, and `2026-04-02T09:00:00.000+00:00` match the same generated occurrence.
