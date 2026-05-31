# pm Calendar Package

`@unbrained/pm-calendar` provides agenda and calendar views as an installable pm package.

```bash
pm install calendar --project
# Or bootstrap all bundled package commands in a new project:
pm init --defaults --with-packages
pm calendar --view week --full-period
pm cal --json --view agenda --include reminders,events
```

The package owns presentation commands for deadline, reminder, and scheduled event views. Core pm still owns item metadata such as `deadline`, `reminders`, and `events`, plus create/update parsing for those fields.

Runtime sources are authored in TypeScript and use only the public `@unbrained/pm-cli/sdk` surface.

## Recurrence Notes

Recurring event `recur_count` values are counted from the event series `start`, not from the query window. For example, a daily event starting April 1 with `recur_count=3` has its counted occurrences on April 1, 2, and 3; querying April 10 does not restart the count.

`recur_exdates` exclude occurrences by instant. Equivalent timestamp spellings such as `2026-04-02T09:00:00Z`, `2026-04-02T09:00:00.000Z`, and `2026-04-02T09:00:00.000+00:00` match the same generated occurrence.
