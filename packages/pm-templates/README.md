# pm Templates Package

`@unbrained/pm-templates` provides reusable `pm create` templates as an installable pm package.

Install it with:

```bash
pm install templates
```

Commands:

```bash
pm templates
pm templates list
pm templates save release-defaults --type Task --priority 1 --tags release
pm templates show release-defaults
```

The package stores template documents in the active pm project root and uses only the public `@unbrained/pm-cli/sdk` runtime surface.
