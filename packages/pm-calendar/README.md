# pm Calendar Package

`@unbrained/pm-package-calendar` provides agenda and calendar views as an installable pm package.

```bash
pm install calendar
pm calendar --view week --full-period
pm cal --json --view agenda --include reminders,events
```

The package owns presentation commands for deadline, reminder, and scheduled event views. Core pm still owns item metadata such as `deadline`, `reminders`, and `events`, plus create/update parsing for those fields.

Runtime sources are authored in TypeScript and use only the public `@unbrained/pm-cli/sdk` surface.
