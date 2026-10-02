# Development dependency security

Tracked by [pm-r61juc](../.agents/pm/issues/pm-r61juc.toon).

Development tools execute during tests, benchmarks and release preparation.
Their dependencies have the same admission requirement as production packages:
no known advisory may pass the required static gate. Run:

```bash
pnpm install --frozen-lockfile
pnpm quality:dependencies
```

This runs the full `pnpm audit`, with no production-only or severity filter,
then verifies the installed CodSpeed bundle policy. Network/audit errors,
missing packages, incomplete policy entries, changed package files, and unreviewed
upgrades all fail. `quality:static` includes this command, so the existing CI,
nightly quality and release paths enforce it. The registry-owned local
preflight also requires the static gate and permits no skip. Trivy separately
includes development dependencies in its required repository scan.

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
Only package-manager-generated `node_modules/.bin` executable shims are outside
the owned inventory; the locked dependency graph is checked by the full audit. An
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
