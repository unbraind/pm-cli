# pm-changelog Docs

Use this index first. Follow only the page needed for the current task.

## Agent Path

1. Install or run the package: [Usage](usage.md)
2. Check release automation or publishing: [Release and CI](release.md)
3. Change source, tests, or package metadata: [Development](development.md)
4. Review shipped changes: [Changelog](../CHANGELOG.md)

## Package Summary

`pm-changelog` provides:

- `pm changelog generate`, a pm-cli extension command.
- `pm-changelog`, a standalone CLI.
- Typed TypeScript APIs: `createChangelog()`, `generateChangelog()`, `mergeChangelog()`, `readPmItems()`, and `writeChangelog()`.

The extension is authored against the official `@unbrained/pm-cli/sdk` package. Source files are TypeScript. Built `dist/` files are tracked so pm package installs can run without a build step.
