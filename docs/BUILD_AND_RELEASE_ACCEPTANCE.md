# Build generations and registry acceptance

Trackers: [pm-cxc4jc](../.agents/pm/tasks/pm-cxc4jc.toon),
[pm-ygli86](../.agents/pm/tasks/pm-ygli86.toon),
[pm-63i8nr](../.agents/pm/tasks/pm-63i8nr.toon),
[pm-p5u6](../.agents/pm/chores/pm-p5u6.toon).

## Build ownership

Build/test/coverage sessions own `.cache/build-lease` through completion;
other producers/consumers wait twenty minutes. Nested readers inherit a verified
PID/token receipt; nested builds require independent workspaces. Direct stages
and arbitrary `dist` reads bypass this protocol.

Leases never expire or get stolen. Two matching reads proving PID absence fail
promptly with recovery guidance. Missing/malformed/changing/ambiguous receipts
use the timeout; PID reuse is ambiguous. Inspect owner and children before
abandoned-lease removal. Failed builds leave `.cache/build-incomplete`; prebuilt
tests refuse it until a successful build.

Interrupts stop the child and stage admission, allowing five seconds for
settlement, lease release and cleanup; unsettled children retain storage.
Subprocess tests cover build/prebuilt paths and installer exits bypassing
`finally`. [Storage lifecycle](SDK_STORAGE_LIFECYCLE.md) defines retention and
platform limits.

## Registry acceptance

Release publishes once, chooses the registry's closest older calendar version
and runs the same eleven-step session against control then candidate in separate
roots. Linux/macOS/Windows cover npm local/global and Bun local. Installed CLI/SDK
and selected runtimes have two-minute step deadlines, bounded output and token
receipts. Synthetic telemetry/external reporting are disabled.

Control failure indicates harness/environment problems; candidate-only failure
requires regression investigation. Both block advertisement, which requires every
matrix leg. Artifacts name manager/step. Immutable versions are never republished;
exact-tag recovery retains the reviewed control selector. Parent deadlines cover
preparation and publish/verify/advertise.

The artifact gate validates one npm array/keyed receipt, identity and size/file/map
limits. Release-note fixtures own generator/changelog/Git roots, isolating
dated/Unreleased over-budget cases from checkout regeneration.

```bash
npm run release:verify-installed-agent -- --version "$CANDIDATE" --previous-version "$CONTROL" --manager npm --global --json
npm run release:verify-installed-agent -- --version "$CANDIDATE" --previous-version "$CONTROL" --manager bun --json
```

Set both versions. Windows `npm run` supplies npm's JavaScript entrypoint.
See [packed first run](PACKED_FIRST_RUN.md) and [release policy](RELEASING.md).
