# Build generations and registry acceptance

Tracked by [pm-cxc4jc](../.agents/pm/tasks/pm-cxc4jc.toon) and
[pm-ygli86](../.agents/pm/tasks/pm-ygli86.toon).

## Complete build ownership

`pnpm build` owns one checkout-local lease from build-cache preparation through
TypeScript compilation, bundling, and finalization. The sandboxed test runner
uses the same lease for the entire test and coverage session. A second producer
or consumer waits up to twenty minutes instead of reading partially rewritten
JavaScript. The lease is under `.cache/build-lease`; its owner receipt records a
process identifier and an opaque inheritance token.

Nested read-only test runners inherit the verified live-owner receipt. Starting
a build inside a test session is refused: rebuilding shared artifacts while
other test workers consume them would violate the generation boundary. Fixtures
that exercise the build orchestrator must use independent temporary workspaces.

The lease never expires based on its age and is never automatically stolen.
After an interrupted process, inspect the owner and its children before removing
an abandoned lease. A failed build leaves `.cache/build-incomplete`; prebuilt
tests refuse that generation until a successful `pnpm build` clears the marker.
Direct invocations of individual build stages or arbitrary reads of `dist` do
not participate in this protocol. Use the build and test entrypoints for
concurrent validation.

## Published candidate and control

The Release workflow publishes npm artifacts once, verifies executors, and
selects the closest older calendar version from the public registry inventory.
It then runs the same eleven-step agent session against the control first and
the candidate second in independent temporary installation roots.

The matrix covers Linux, macOS, and Windows with npm local, npm global, and Bun
local installations. Each session initializes, orients, creates, claims,
annotates, links evidence, closes, validates, reads the closed item and context,
and verifies a complete corpus read through the installed public SDK. Each
subprocess has a two-minute deadline; command output has per-step bounds and the
report records estimated token cost. Telemetry and external error reporting are
disabled in these acceptance workspaces.

GitHub release advertisement is a separate job that depends on every matrix
leg succeeding. A failed control identifies a harness or environment problem;
a passing control followed by a failing candidate identifies a candidate
regression to investigate. Neither failure permits advertisement. Reports are
retained as workflow artifacts; failures also name the manager and failing step.
Existing npm versions are never republished during exact-tag recovery.

The prepublication artifact gate accepts both npm's array report and npm 12's
package-keyed report. It requires exactly one artifact, validates keyed package
identity, and applies the same file, source-map, and size limits to either shape.
Exact-tag recovery preserves the reviewed control selector before checking out
older unpublished source. The automatic-release parent budgets the complete
publish, acceptance, and advertisement sequence plus its preparation work.

Run the same comparison locally:

```bash
npm run release:verify-installed-agent -- --version 2026.9.16 --previous-version 2026.9.15 --manager npm --global --json
npm run release:verify-installed-agent -- --version 2026.9.16 --previous-version 2026.9.15 --manager bun --json
```

Use `npm run` on Windows so the verifier receives the actual npm JavaScript
entrypoint. CLI and SDK execution use the installed package and the selected
runtime rather than assuming shell shim names.
