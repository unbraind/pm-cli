# Faithful package acceptance

Tracked by [pm-gh1391](../.agents/pm/issues/pm-gh1391.toon),
[pm-aiqmgj](../.agents/pm/issues/pm-aiqmgj.toon), and
[pm-dqej6b](../.agents/pm/issues/pm-dqej6b.toon), with scratch ancestry protection
tracked by [pm-runner-ancestor-tracker](../.agents/pm/issues/pm-runner-ancestor-tracker.toon).

Package tests that create their own disposable projects need an unset `PM_PATH`.
Otherwise a nested `pm init` follows the inherited tracker override and writes
outside the intended fixture. Use the shared SDK linked-test runner with a
disposable source snapshot:

```bash
pm test <item-id> --add-json '{"command":"npm run release:check","pm_context_mode":"none","workspace_context_mode":"snapshot","timeout_seconds":900}'
pm test <item-id> --run --progress
```

The same fields are supported by the SDK's `runTest` and MCP. See
[Testing](TESTING.md) for trust acknowledgements, assertions and run receipts.

Snapshots copy the current source files and keep root and nested `node_modules`
at their original relative paths. A Git workspace additionally receives an
independent clone of commit and tag objects, so release-tag checks and dependency
resolution work together. The clone uses no shared objects or source hooks,
does not inherit source-local Git configuration, and has no origin remote.
The internal remote name is explicit even with a custom `clone.defaultRemoteName`.
Its Git objects remain readable after the source checkout is removed.

The working tree excludes tracker and generated build/report directories.
Git objects contain repository history, including any historically tracked
files; a snapshot is an execution-isolation boundary, not a redaction mechanism.
Source aliases remain subject to containment checks. Installed dependency
directories are shared, so dependency-mutating tests need a separate installation.
Tests that depend on absolute checkout paths, source-local Git configuration,
submodule configuration, or exact dirty-status output must declare those
requirements separately. Cloning failures fail the linked run rather than
silently certifying a partial Git identity.

`PM_GLOBAL_PATH` remains isolated. `none` with a live source workspace and direct
PM commands remains refused. Existing command provenance and clone-local trust
checks still apply. The runner records the effective workspace and tracker
context on each execution so a green linked receipt identifies its boundary.
Repository acceptance also refuses scratch roots beneath any initialized
ancestor tracker before allocating fixtures, including external roots and
root-layout trackers. Choose a temporary hierarchy without workspace ancestry.

The optional SQLite accelerator filters Node's exact experimental announcement
only during synchronous native loading. Every other warning retains its original
arguments, and normal warning delivery is restored immediately, including after
a failed optional load. JSON refusals and clean mutation stderr therefore remain
usable on Node 22 and Node 24 without disabling application diagnostics.

The repository's scratch lifecycle keeps its original 15-second latency and
3,000-token output limits. Vitest schedules it in a separate project after the
parallel contract suite. Functional assertions and the all-source coverage
denominator stay intact; a real latency regression still fails admission.
