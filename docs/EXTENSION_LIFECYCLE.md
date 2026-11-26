# Extension Lifecycle Contracts

Tracked by [pm-ig5cfe](../.agents/pm/issues/pm-ig5cfe.toon),
[pm-495lkc](../.agents/pm/issues/pm-495lkc.toon), and
[pm-miy5k6](../.agents/pm/issues/pm-miy5k6.toon).
Static inventory is tracked by [pm-lhhnx9](../.agents/pm/issues/pm-lhhnx9.toon).
Verified replacements and disabled compatibility findings are tracked by
[pm-c9wz5ef4ulnv](../.agents/pm/issues/pm-c9wz5ef4ulnv.toon) and
[pm-5xn8we1wue0m](../.agents/pm/issues/pm-5xn8we1wue0m.toon).

## Read-only configured inventory

Use `pm package list --project --json` (an alias of `pm package inventory`; or
`--global`) for a host GET route or agent read. Pass a name to receive an
explicit `absent` row, and `--fields name,version,update` for compact rows. The public SDK
equivalent is `inspectStaticExtensionInventory({ pmRoot, scope, name })` from
`@unbrained/pm-cli/sdk`. Both read settings, managed metadata, and manifests
without importing package entrypoints, running hooks, checking for updates,
adopting installs, or writing workspace files. An absent managed-state file is
reported separately from an invalid one. `complete: false` and `errors` mean
the list must not be treated as authoritative; the CLI also exits nonzero.

Each installed row carries `update`: the newer version the last
`pm package manage` freshness check observed for exactly that installation, or
`null` when none is known. `manage` records what each check answered in the
untracked `runtime/extension-update-observations.json` of the scope
(`.agents/pm/runtime/` or the global pm root). Under a per-scope lock the
record is rebuilt from the managed state on disk at that moment: each current
installation keeps the latest observation taken against it, from this check or
an earlier one, and rows for replaced or removed installations are dropped, so
concurrent checks keep each other's answers and the record never outgrows the
managed packages. A check that timed out or failed records nothing for that
package. An observation names the manifest version and the managed record's
`updated_at` it was taken against, so any install that changes the version or
the source, including a commit-only reinstall of a repository source, retires
it; reinstalling the identical version from the identical source keeps it,
because its answer still applies. A registry `latest` that is not
newer than the installed npm version under SemVer precedence is recorded as no
update, because upgrading to it would downgrade; `pm package manage` applies the
same verdict. A bounded (1 MiB) regular file is read only when the record
entry is a regular file and the opened descriptor is one too, and nothing is
written while `runtime/` is a link or not a directory (checked before and after
the lock is taken): a link, FIFO or oversized file reads as no knowledge. Node
has no directory-relative file API, so a process that can replace the
tracker's own `runtime/` between that check and the write could redirect it;
such a process already controls the tracker state the record describes. A
check time more than five minutes in the future reads as a clock error, and a
check under a pinned reproducible clock (`PM_CLOCK`/`PM_SEED`) records nothing,
because pinned times cannot order the record. The record is derived state: a failed write is the
warning `extension_update_observation_write_failed`, never a failed check.

`pm context` reads the same observations offline for its `extension_health`
block. Rows are `{name, scope, version, status, update, shadowed_by}`:
`shadowed_by` names the scope whose same-named copy the runtime loads instead
(project shadows global), so a copy installed in both scopes is told apart.
`updates_available` counts the copies static discovery selects (a shadowed or
disabled copy keeps its row but is not counted; this is static selection, not
activation truth, since no package module is imported) with a known update, and
`next` names one live check per scope with a known update, `pm package manage
--<scope>`, only when that count is above zero; the check re-reads the
registry and shows each package's update evidence (`update_available`,
`last_update_remote_version`), and its remediation says to reinstall the
updated sources (`pm package upgrade <name> --<scope>` upgrades one). The hint names no package, so
no manifest-controlled name can select another installation, become an option,
or lose its quoting, and the Markdown rendering puts each hint in its own fenced
block, which keeps line breaks and shell escapes verbatim (a tracker path with
any other terminal control character is not written raw; the Markdown points to
the exact JSON `next` value instead). Every hint names the
absolute tracker the read served (`--pm-path`), because manage's activation
probe resolves it even for a global check, and a caller's explicit
`--no-extensions` carries over, because manage's live check runs before that
probe. A global hint assumes the caller's
environment, like any command: under a relative `PM_GLOBAL_PATH`, run it from
the same directory. An npm source that is not a registry install
(classified with npm's own spec parser: a path, tarball, `file:`, git or URL
spec) is never compared with a registry release, by `manage` or by the offline
readers, and `pm package upgrade` reinstalls every such artifact from its own
spec instead of moving it to a registry tag. Corrupt or unreadable managed metadata in a scope means unknown
updates there, never a failed `pm context`. `pm package list` refuses the
row-shaping read-output controls it cannot apply (`read_output_surface_unsupported`) and
keeps `--output-format` and an unbounded `--output-budget`
([pm-gh1778](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-gh1778.toon),
tracker record excluded from npm).

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

## Verified replacements

`pm package install` and the SDK's `runExtension(source, { install: true }, global)`
retain the previous installation through fresh-module runtime verification and
contribution persistence. When a copied replacement fails to load or activate,
pm restores the previous package tree and exact managed/settings content. A
settings restoration appends a compensating workspace-history event.

The failed attempt still returns `ok: false` and its candidate diagnostics, with
`previous_state_preserved: true`, `overwritten: false`, and
`rollback.status: "restored"`. The previous command remains available in a new
process. Multi-target and install-all receipts retain these fields per package.
SDK `ExtensionCommandResult` / `PackageCommandResult` consumers can narrow
`details.rollback.status` to access typed recovery arguments on failed restoration.
These two diagnostic keys are now reserved typed fields. Code constructing
lifecycle result objects or test doubles must use the boolean and rollback
shapes, or rename custom metadata stored under those keys. Ordinary result
readers remain compatible; the runtime implementation is unchanged by this
declaration refinement.

If restoration fails, `previous_state_preserved` is false. The retained backup
and executable `rollback.recovery_args` / `rollback.recovery_command` identify a
source for reinstalling the previous package. Resolve the reported filesystem
failure first. Fresh installations and installations whose source is already
the destination retain failed code for diagnosis and report
`previous_state_preserved: false`; they have no earlier package version to
recover. Package code can have external side effects during activation; this
snapshot protects the installation and its managed/settings content.

## Disabled package compatibility

An explicitly disabled package remains visible in inventory and discovery.
Its host-version warnings use `extension_disabled_pm_*` codes and are advisory
in health, including `--strict-exit`. Each finding identifies the package,
required bound and scoped activation command to use after satisfying that
bound. Enabled packages retain the ordinary `extension_pm_*` compatibility
checks and blocking policy. Deactivation does not permit incompatible code to
load or suppress malformed-manifest, missing-entry or other unrelated findings.

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

Rollback failures retain the initial error as their cause and expose an original
typed refusal as `context.original_code`, while keeping the rollback code and
exit policy. This diagnostic boundary is tracked by
[pm-4vymxc](../.agents/pm/issues/pm-4vymxc.toon).
