# Install Plans and Update Evidence

Tracked by [pm-erogk1](../.agents/pm/issues/pm-erogk1.toon),
[pm-5bsofk](../.agents/pm/issues/pm-5bsofk.toon) and
[pm-gf5zw8](../.agents/pm/issues/pm-gf5zw8.toon), with claim controls tracked by
[pm-eqdo85](../.agents/pm/issues/pm-eqdo85.toon) and Git metadata exclusion by
[pm-k7nxaz](../.agents/pm/issues/pm-k7nxaz.toon).

## Install planning

Preview an install with `pm package install ./local-package --project --dry-run`.
The `details.install_plan` receipt distinguishes directory, archive, npm, and
GitHub sources and reports logical file bytes, file/directory/link counts, and
the copy policy. External local directories are directory snapshots, including
development artifacts other than `.git`. All copied directory sources exclude
`.git` entries at every depth, including worktree files and symlinks, and count
those entries in `excluded_entries`. Nested destinations also exclude `.agents`,
`node_modules`, and installer backup directories at every depth using the
installer's filter.
The bounded planner can return lower-bound counts with `complete: false` and a
`stop_reason` when called directly. Installing a local directory now refuses
that incomplete scan in both dry-run and real modes before writing or
activating. SDK callers receive
`extension_install_incomplete_source_scan`; the CLI exits nonzero with the
entry or depth limit and a packed-archive recovery step. That recovery keeps
the requested `--project` or `--global` installation scope. A source-directory
alias resolves to its
directory before copying; symlink entries inside the source remain links and
their targets are never traversed.
Planning writes no destination files, managed state, or activation settings;
archive and remote source resolution can still prepare temporary source files
and perform network or dependency-resolution work.

For development-heavy local snapshots, `packed_alternative`
provides argument vectors for `npm pack --ignore-scripts --json` and archive
installation. Run packing in its reported `cwd`, substitute the returned
`pack_result[0].filename`, and install the resulting archive. Normal local
installs also return their pre-copy plan. SDK callers can use
`planExtensionDirectoryCopy(source, destination, { maxEntries, maxDepth, signal })`
or `PmClient.packageInstall(source, { project: true, dryRun: true, copyPlan })`;
the defaults inspect at most 10,000 entries and 64 directory levels.
Strict MCP requests use `install`, `package-install`, or `extension-install`
with `target` or `github` and `dryRun: true`. Generic `package` and `extension`
requests also require `install: true` and a source when enabling `dryRun`.

```bash
pm package install ./local-package --project --dry-run --json
npm pack --ignore-scripts --json
pm package install ./package-name-1.0.0.tgz --project
```

Run the last two commands in the reported packing directory and substitute the
actual archive filename. Packing applies the package's publish file selection;
inspect that selection when a package needs generated assets at runtime.
A plan is an observation, not a reservation: source files can change before
the actual copy. Normal install verification remains authoritative.

The SDK adds optional `copyPlan` controls and a typed optional
`details.install_plan`. Custom result constructors that previously placed an
unrelated value under that key must migrate to the declared plan type. Other
extension detail fields retain their open record contract.

The install-plan regression has a reproducible source-mutation control:

```bash
node scripts/release/package-install-plan-control.mjs
node scripts/release/package-install-plan-control.mjs --negative-control
```

The baseline exits zero. The negative control changes only a disposable source
copy to report a complete entry-limited scan, then runs the same real filesystem
test and exits one. The linked control test requires both outcomes; the checkout
and project tracker are never mutated by the control.

Claim receipts and update coverage have matching baseline/mutant controls:

```bash
node scripts/release/lifecycle-evidence-control.mjs
node scripts/release/lifecycle-evidence-control.mjs --negative-control
node scripts/release/lifecycle-evidence-control.mjs --update-coverage
node scripts/release/lifecycle-evidence-control.mjs --update-coverage --negative-control
```

Each baseline exits zero and each unsafe mutant exits one. The claim mutant
disables compact MCP envelopes; the update mutant falsely reports full coverage
for a skipped source. The linked test executes all four outcomes against real
SDK behavior in disposable source copies.

## Update verification

Update coverage describes checks actually completed. `checked` entries alone
contribute to known update counts; `skipped_unmanaged`, `skipped_non_github`,
`failed`, and `not_checked` remain distinct in `update_check_status_totals`.
Any actionable gap makes update coverage partial, even when no update is known.
Adoption records provenance but does not establish upstream freshness for local
or npm sources. Expected host-owned built-ins remain exempt from unmanaged
adoption warnings and adoption remediation. Runtime activation health and update freshness are separate
verdicts; inspect both before claiming that installed packages are current.

A failed check reports a stable `update_error` (also its
`update_check_reason`) and never the provider's command line, stderr or
environment
([pm-5kfzjh](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-5kfzjh.toon),
[pm-43p2c3](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-43p2c3.toon);
tracker records excluded from npm):

| Source | Lookup ran out of its budget | Other provider execution failure |
| ------ | ---------------------------- | -------------------------------- |
| npm    | `npm_registry_lookup_timed_out` | `npm_registry_lookup_failed` |
| GitHub | `github_remote_lookup_timed_out` | `github_remote_lookup_failed` |

A provider that runs but returns output that cannot be read reports its own
validation code instead (for example `invalid_npm_registry_metadata` or
`no_remote_reference_found`). A timed-out check also carries
`update_check_timeout_ms`, the budget that ran out. Each lookup settles at its
own deadline without waiting for teardown, so an SDK caller has its result at
once; the `pm` process itself may stay alive up to about four more seconds
while a timed-out provider is torn down (a teardown helper is bounded to two
seconds, and the wait for the killed provider to exit to two more); `pm package manage` returns once
every lookup has settled, and outside `--fix-managed-state` a queued lookup
starts only when a timed-out provider's teardown frees one of the four
provider slots. Each lookup (`npm view` or `git ls-remote`) has a 10-second budget by
default; set `PM_EXTENSION_UPDATE_CHECK_TIMEOUT_MS` to integer milliseconds
(clamped to 1000–25000, below the extension state lock's 30-second wait) for
a slow registry, proxy or cold start, for example on a Windows runner.
`pm package manage --fix-managed-state` runs its lookups while it holds that
lock, so it keeps the 10-second default and ignores the override
([pm-9x9drr](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-9x9drr.toon)
tracks moving them out of the lock; tracker record excluded from npm). A
result that arrives after the deadline counts as a timeout even if the host's
event loop was busy when the deadline passed. The deadline settles the check without waiting for the
provider's pipes, so a launcher such as `cmd.exe` or an npm shim cannot extend
it by exiting while a descendant keeps running. It then makes a best-effort
attempt to stop a provider that is still running and its live descendants
(`taskkill /T` on Windows, a tree walk over the system `ps` elsewhere): a
descendant is missed when that tool cannot run, and one whose launcher already
exited is not reached. The timeout result never depends on the teardown. A lookup still running at its deadline is reported as timed
out even if the provider then exits cleanly. A recorded `update_check_timeout_ms`
is kept only beside a timed-out reason. A provider whose failed exit is
observed before the deadline is reported as failed at once, even while a
descendant still holds its output.
The GitHub lookup runs with `GIT_TERMINAL_PROMPT=0` and
`GCM_INTERACTIVE=never`, so neither Git's terminal prompt nor Git Credential
Manager prompts interactively; a slow remote can still use up the budget, and
another askpass program or credential helper that prompts can still hold the
lookup until its budget runs out.
A GitHub remote that resolves no reference still reports
`no_remote_reference_found`, and one checked without an installed commit
reports `missing_installed_commit`. A GitHub failure that an earlier release
recorded as git's own command line and stderr is read back as
`github_remote_lookup_failed`. If a host exits before a timed-out provider's
deferred teardown runs, the provider itself is still killed through its
handle as the host exits. Inside a worker thread, where `terminate()` runs no
exit listener, the package action (`runExtension`, and `runAction` through it)
finishes every provider teardown before it returns, so a host may terminate
the worker as soon as the result arrives. Each lookup still settles at its
budget, and the wait happens after the extension state lock is released, so
the locked `--fix-managed-state` scan keeps its timing; the action itself
returns up to about 4 seconds later.

Lookups are neither detached nor hidden from the console: they stay in `pm`'s
process group (and console on Windows), so a terminal Ctrl-C reaches them as it
reaches `pm`, and `pm` installs no signal handlers for them.

Use `pm package doctor --project --detail deep --json` to inspect activation
alongside update-check status totals. A strict doctor run may fail for partial
update coverage even when activation succeeds. Empty scopes and applicable
host-owned built-ins do not require third-party upstream checks.
