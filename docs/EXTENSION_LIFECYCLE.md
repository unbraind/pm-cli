# Extension Lifecycle Contracts

Tracked by [pm-ig5cfe](../.agents/pm/issues/pm-ig5cfe.toon),
[pm-495lkc](../.agents/pm/issues/pm-495lkc.toon), and
[pm-miy5k6](../.agents/pm/issues/pm-miy5k6.toon).
Static inventory is tracked by [pm-lhhnx9](../.agents/pm/issues/pm-lhhnx9.toon).

## Read-only configured inventory

Use `pm package inventory --project --json` (or `--global`) for a host GET route
or agent read. Pass a name to receive an explicit `absent` row. The public SDK
equivalent is `inspectStaticExtensionInventory({ pmRoot, scope, name })` from
`@unbrained/pm-cli/sdk`. Both read settings, managed metadata, and manifests
without importing package entrypoints, running hooks, checking for updates,
adopting installs, or writing workspace files. An absent managed-state file is
reported separately from an invalid one. `complete: false` and `errors` mean
the list must not be treated as authoritative; the CLI also exits nonzero.

`configured_enabled` is the effective saved enablement setting, while
`runtime_active` is always `null`. The static read does not prove that a package
will activate successfully. `pm package explore`, `manage`, `doctor`, and
`describe` probe runtime state and may execute installed package code. Run
those commands only when an activation probe is intended.

## Explicit Install-Source Identity

A bare target may name both a bundled alias and an already-installed npm
package. pm preserves the bundled-first compatibility rule but never hides the
choice. Install results include `source_resolution` with the selected source,
an `ambiguous` indicator, every matching candidate, and an explicit command for
each. Use `pm install npm:<package>` to force npm identity or the reported bare
alias command to force the bundled package. Install-all results carry the same
receipt on every package row.

## Durable Extension Migrations

Active packages register schema migrations through `api.registerMigration`.
Runtime preflight applies runnable migrations, and operators can plan or apply
the same registrations explicitly:

```bash
pm package migrate --project --dry-run --json
pm package migrate --project --json
pm health --check-only --json
```

`pm extension migrate` is the compatibility spelling. The SDK exposes
`runExtensionMigrations`, `PmClient.packageMigrate`, and the one-shot
`packageMigrate`/`extensionMigrate` helpers. Dry-run never invokes package code
or writes state. Apply records deterministic per-migration receipts in
`.agents/pm/extension-migrations.json` through workspace history. Successful
migrations become idempotent `skipped` rows in later processes. Failures retain
their error for health diagnostics and are retried on the next apply. Project
scope includes active project and global packages because both affect that
workspace; `--global` restricts execution to global registrations.

## Scoped Preflight Ownership

`definePreflightOverride` and `api.registerPreflight` accept
`{ commands, run }`. Command paths are normalized, disjoint registrations
compose without warnings, and runtime invokes only the matching owner. Empty or
omitted command ownership retains the legacy global behavior and collides with
every other override. Activation summaries and persisted contribution
inventories expose `preflight_ownership` for static doctor and tooling output.
