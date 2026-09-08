# Install Plans and Update Evidence

Tracked by [pm-5bsofk](../.agents/pm/issues/pm-5bsofk.toon) and
[pm-gf5zw8](../.agents/pm/issues/pm-gf5zw8.toon), with claim controls tracked by
[pm-eqdo85](../.agents/pm/issues/pm-eqdo85.toon).

## Install planning

Preview an install with `pm package install ./local-package --project --dry-run`.
The `details.install_plan` receipt distinguishes directory, archive, npm, and
GitHub sources and reports logical file bytes, file/directory/link counts, and
the copy policy. External local directories are directory snapshots, including
development artifacts; nested destinations exclude `.agents`, `node_modules`,
and installer backup directories at every depth using the installer's filter.
Counts are lower bounds when `complete` is false, with `stop_reason`
identifying the entry or depth limit. A source-directory alias resolves to its
directory before copying; symlink entries inside the source remain links and
their targets are never traversed.
Planning writes no destination files, managed state, or activation settings;
archive and remote source resolution can still prepare temporary source files
and perform network or dependency-resolution work.

For development-heavy or incomplete local snapshots, `packed_alternative`
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

Use `pm package doctor --project --detail deep --json` to inspect activation
alongside update-check status totals. A strict doctor run may fail for partial
update coverage even when activation succeeds. Empty scopes and applicable
host-owned built-ins do not require third-party upstream checks.
