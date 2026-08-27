# pm Beads Package

First-party pm package for lossless Beads migration through public pm SDK
contracts. The importer preserves issue identity, comments, structured events,
relationships, labels, and terminal closure evidence before reporting a
complete count-parity receipt.

## Migration

Use a current portable backup for lossless relational migration. The focused
[migration guide](docs/MIGRATION.md) covers installation, source validation,
ID preservation, legacy exports, parity receipts, and post-import checks.

The package exposes the `beads import` extension command through the
`pm.extensions` package manifest. Runtime sources are TypeScript and use only
the published `@unbrained/pm-cli/sdk` surface.
