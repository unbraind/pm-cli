# Development dependency security

Tracked by [pm-r61juc](../.agents/pm/issues/pm-r61juc.toon) and
[pm-fnx3np](../.agents/pm/issues/pm-fnx3np.toon), with independent advisory evidence in
[pm-eqxjzl](../.agents/pm/tasks/pm-eqxjzl.toon) and MCP/Vite remediation in
[pm-5sgx37](../.agents/pm/issues/pm-5sgx37.toon).

Development tools execute during tests, benchmarks and release preparation.
Their dependencies have the same admission requirement as production packages:
no known advisory may pass the required static gate. Run:

```bash
pnpm install --frozen-lockfile
pnpm quality:dependencies
```

This collects the full `pnpm audit --json`, with no production-only or severity
filter, and queries every npm name/version in the pnpm v9 lockfile against
[OSV querybatch](https://google.github.io/osv.dev/post-v1-querybatch/). The inventory
includes development, optional and platform-specific packages. Either source's
positive result blocks, even when the other returns zero. Unsupported resolutions,
empty inventories, malformed or partial responses, pagination and network failures
also block. Collection has bounded batch sizes, deadlines and no automatic retries.
Only public npm names and versions are sent to OSV.

The ignored local `.cache/dependency-security/receipt.json` records input hashes,
complete per-package OSV coverage, feed retrieval times, registry counts and
advisory IDs. Collection invalidates the prior receipt before querying. Database
update times are explicitly unknown: fresh retrieval does not prove a feed is
current. The SDK-owned `repository-static-quality` assurance gate composes a
`repository-quality/dependency-advisories` provider that verifies this receipt
without network access. It rejects evidence older than fifteen minutes, changed
manifests or lockfiles, incomplete coverage and unavailable sources. Fresh evidence
is required again on each CI/static or release run. Static checks refresh collection
immediately before SDK assurance evaluation, which verifies advisory evidence
before slower providers. The blocking registry command settles before OSV starts
its network deadlines.

CI retains this single receipt after successful and failed static jobs, with a
separate artifact name for each run attempt and seven-day retention. Inspect both
feeds before diagnosing a blocked collector: a positive advisory is a refusal,
even when the other feed is clean.

The command then verifies the installed CodSpeed bundle policy. Network/audit errors,
missing packages, incomplete policy entries, changed package files, and unreviewed
upgrades all fail. `quality:static` includes this command, so the existing CI,
nightly quality and release paths enforce it. The registry-owned local
preflight also requires the static gate and permits no skip. Trivy separately
includes development dependencies in its required repository scan.

Composite action refs and their executed tool versions need separate review.
[pm-38w3ii](../.agents/pm/chores/pm-38w3ii.toon) pins TruffleHog's action
commit and explicitly selects scanner version `3.98.0`; the action otherwise
defaults to the `latest` image. The workflow contract checks both values on
every TruffleHog step. Recheck the action's executable selectors when renewing
its commit pin.

## Vitest mocker advisory pair

[pm-vitest4112](../.agents/pm/tasks/pm-vitest4112.toon) coordinates the
[manual-registration finding](../.agents/pm/issues/pm-vitestmanual.toon) and
[Windows redirect finding](../.agents/pm/issues/pm-vitestredirect.toon).
[GHSA-qxg6-89mg-rqv8](https://github.com/advisories/GHSA-qxg6-89mg-rqv8)
and [GHSA-xp26-3454-mjgp](https://github.com/advisories/GHSA-xp26-3454-mjgp)
affect the previously locked `@vitest/mocker` 4.1.11. The compatible Vitest and
coverage-provider pair now requires 4.1.12, whose shared mock-source generator
serializes module URLs and export names, including asynchronous rebinding, and
whose public redirect handler normalizes backslashes before the file allowlist
check. Both fixes apply to public mocker/interceptor WebSocket handlers. The
repository's Node test configurations do not register these handlers, so the
affected development dependency does not establish an exploitable CLI or SDK
route.

The retained hosted OSV receipt identified both advisories while the registry
audit returned zero. Keep full-lock admission mandatory and verify the patched
graph against both feeds. This patch keeps Vitest 4, the CodSpeed peer contract
and the Vite 7 override; the broader Vitest 5 migration remains separate. The
installed-handler regressions run in coverage and the required native Windows
cohort, whose aggregate refuses failed, canceled or skipped partitions. The
October 15 patch releases meet pnpm's one-day minimum age on October 21 without
an exclusion. Dependabot's seven-day scheduling cooldown is unchanged.

## Indexed source-map offsets

[pm-dba47](../.agents/pm/issues/pm-dba47.toon) tracks Dependabot alert 47 and
the new source-map cause of Scorecard alert 29.
[GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)
affects `source-map-js` before 1.2.2. Unchecked indexed-map section offsets can
block the event loop. The dependency is used by the development lint and test
graph through `@eslint/css-tree`, `magicast` and `postcss`; this inventory does
not establish a production exploit. The pnpm override requires a patched 1.x
release while retaining normal release-age policy and frozen installation.
The pinned pnpm 11 uses its default one-day minimum release age; the separate
seven-day Dependabot cooldown governs version-update scheduling. This repair
adds no age override or exclusion.

A clean audit feed is only evidence about that feed at its observation time.
GitHub and OSV reported this advisory while the npm audit response was still
empty. A freshly updated Trivy database also admitted both vulnerable and
patched temporary fixtures, so that scan did not establish regression sensitivity.
The independent safe constructor control rejected an oversized indexed-map
offset only on the patched version, without serializing the huge offset.
Read the actual locked graph and every available scanner report before
claiming that findings are retired. Native scans of merged main must confirm
retirement independently of green PR workflow jobs.

## Worker diagnostics

[pm-cql43](../.agents/pm/issues/pm-cql43.toon) tracks CodeQL alert 43 in the
test worker bridge. Its captured scanner flow contains a generated temporary
path, so it does not prove a credential leak. The debug path nevertheless
previously broadcast arbitrary CLI arguments and stderr. Debug failures now
emit only a fixed notification; the complete captured result remains available
to deliberate assertions. A real worker regression uses synthetic private
input and verifies both notification privacy and preserved result contents,
plus silence when debugging is disabled or the command succeeds. The harness
is excluded from the published package.

## File matching dependency removal

[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
affects `braces` 3.0.3, previously reachable through the production `fast-glob`
dependency. A pattern under 10,000 characters can exhaust the recursive brace
expansion stack. No fixed version was published when this change was verified.
The SDK and repository censuses now use `tinyglobby` 0.2.17, removing `fast-glob`,
`micromatch` and `braces` from the installed graph. Explicit
`expandDirectories: false` retains file-only semantics: a directory argument
does not silently become a recursive match. Dot files, brace and extglob
patterns, absolute paths and invocation-relative anchoring remain supported.
The regression uses a real temporary directory and the same deeply nested input
that failed before the replacement. Audit errors remain mandatory failures.

## CodSpeed 5.7.1 patch

CodSpeed's declared dependency previously resolved Axios 1.19.0, and both
`@codspeed/core` bundles embedded Axios 1.4.0. Updating the declared dependency
alone leaves those embedded implementations and their source-map contents
intact. The pnpm override selects Axios 1.20.0 or a newer compatible 1.x
release that satisfies the normal dependency cooldown. The exact-version
patch in [the patch file](../patches/@codspeed__core@5.7.1.patch) replaces the
embedded dependency section in both CJS and ESM entries with imports of the
declared `axios` and `form-data` packages. Each entry creates its own Axios
client and retains the cancellation constructor, preserving isolation from
application request and response interceptors.

The replacement boundary starts at `function bind$2(fn, thisArg)` and ends
immediately before `var __defProp$3 = Object.defineProperty`. Only `axios` and
`FormData$2` from that section are referenced by the retained code. The patch
preserves the preceding and following benchmark code, declarations, export
surface and native binaries. Each entry removes 19,201 embedded lines. Its map
retains 5,375 mappings, removes 39,536 obsolete mappings, and reduces its source
inventory from 131 to 21. Remaining generated positions are shifted by the
replacement's line delta; their original source, line, column and names are
preserved. Removed Axios, redirects, proxy and form-data sources are absent.
Both maps end with a newline; the integrity policy records the installed bytes.

[The integrity policy](../config/dependency-bundle-integrity.json) pins all twelve
package-owned files by SHA-256: both entries, both maps, all three native binaries,
the manifest, declarations and declaration map, license and README. Owned
artifacts must be regular files; symlinks cannot redirect their module resolution
to an unreviewed dependency tree even when their target bytes have the same hash. Admission
also checks the exact installed file inventory, so an added executable, map or
native payload fails even when the previously approved files are unchanged.
Package-local dependency overrides also fail inventory admission: an added
`node_modules/axios` could shadow the audited dependency resolved by the bundle.
Only the three `node-gyp-build` commands and their CMD/PowerShell variants may
appear directly in `node_modules/.bin`. Each must be a regular file whose complete
program matches the reviewed [shim templates](../config/codspeed-shims/), with
targets and module paths derived from the audited installed dependency. Arbitrary
names, nested payloads, links, altered programs and forged target markers fail;
these shims are outside the twelve package-owned hashes but are independently
validated. [pm-rnpmtp](../.agents/pm/chores/pm-rnpmtp.toon) renews the installer
to pnpm 11.28.5 and its bundled `bins/cmd-shim` generator. Separate complete shell
templates describe POSIX and Windows installations; only the host's template is
accepted. Windows shells pass Windows `NODE_PATH` values to native Node, and
Cygwin targets use Windows paths. CMD and PowerShell programs retain their
complete comparisons. Template changes require renewed real installation and
dependency-resolution evidence on POSIX, Git Bash and Cygwin, plus CMD and
PowerShell. The Windows script cohort downloads the archived Cygwin setup 2.937
installer and verifies its pinned SHA-512 before execution. To renew it, select
an eligible version from the official [setup archive](https://cygwin.com/setup/),
verify the executable against the archive's `sha512.sum`, and update the
versioned URL, pinned digest and workflow contract together. Preserve setup's
default package-signature verification and repeat native launcher acceptance.
Literal percent paths are exercised in disposable launcher fixtures;
the audited CodSpeed installation still refuses shell interpolation paths.
The CMD suffix follows the installed `PATHEXT` spelling, including `.CMD`;
format lookup folds its case while validating the complete program. All three
shell launchers are required, together with the CMD and PowerShell sets on
Windows. Any additional format must also contain all three commands. Missing
or duplicate launchers fail admission. Installation roots and rendered paths
containing shell interpolation syntax fail before template comparison;
ordinary paths containing spaces remain supported. Templates are comparison
data: the checker never rewrites pnpm-generated launchers.
The locked dependency graph is checked by the full audit. An
upstream upgrade requires a reviewed patch removal or refresh, renewed runtime
compatibility evidence, and a matching policy update. Never update hashes
merely to admit an unexplained difference.

## Verification and scope

The admission suite edits real temporary package copies and proves that each
changed package file and additional unreviewed payload is refused. The runtime
integration suite
uses both public entries in fresh processes, calls a real loopback HTTP server,
and verifies setup, benchmark start/stop, HTTP failure conversion, exports,
measurement conversions, root-frame wrappers and isolation from real application
interceptors. The server observes the
audited Axios transport rather than a mocked client. The existing CodSpeed
workflow continues to execute the native benchmark integration.

These findings establish vulnerable dependency inventory, not a demonstrated
production exploit. CodSpeed is a development dependency. Its Mongo
instrumentation transport requires an explicitly configured instrumentation
server; ordinary benchmarks do not configure one. Native Scorecard analysis
of the merged commit must confirm alert retirement independently of local
audits and PR checks.
