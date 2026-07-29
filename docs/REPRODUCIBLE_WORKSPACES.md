# Reproducible Workspaces and Snapshots

Tracked by [pm-rbcvt2](../.agents/pm/features/pm-rbcvt2.toon) and
[pm-dkrmzv](../.agents/pm/features/pm-dkrmzv.toon).

These SDK primitives make a pm workspace reproducible without changing normal
interactive behavior. Recipes control time and identifier entropy only inside
an explicit async scope. Snapshots capture authoritative tracker data while
leaving clone-local caches and recovery state disposable.

## Reproducible recipes

```ts
import {
  PM_WORKSPACE_RECIPE_SCHEMA,
  executeWorkspaceRecipe,
  type WorkspaceRecipe,
} from "@unbrained/pm-cli/sdk";

const recipe: WorkspaceRecipe = {
  schema: PM_WORKSPACE_RECIPE_SCHEMA,
  seed: "example-fixture-v1",
  clock: "2026-07-28T10:00:00.000Z",
  tickMs: 1,
  operations: [
    { action: "create", input: { title: "Deterministic task" } },
  ],
};

const results = await executeWorkspaceRecipe(
  recipe,
  async ({ action, input }) => executeProjectAction(action, input),
);
```

The caller owns action dispatch. pm owns the deterministic execution context:
`nowIso()` advances from `clock` by `tickMs`, and generated item identifiers
derive from `seed`. Async scopes are isolated with `AsyncLocalStorage`, so
concurrent recipes do not share counters. Outside `runWithWorkspaceRecipe` or
`executeWorkspaceRecipe`, the CLI continues using the system clock and
cryptographic randomness.

`defineWorkspaceRecipe` immediately validates the clock, seed, tick, schema,
operation actions, and recursively JSON-compatible inputs. Its TypeScript
contract additionally rejects undeclared top-level recipe keys at compile time.
The returned recipe is detached and deeply frozen, so later caller mutations
cannot change a queued replay.

Store recipes in source control only when their inputs are safe to publish.
Seeds are reproducibility inputs, not secrets. A replay is byte-identical only
when it begins from equivalent authoritative state and invokes the same ordered
operations with the same recipe.

## Content-addressed snapshots

The SDK exports:

- `createWorkspaceSnapshot`
- `inspectWorkspaceSnapshot`
- `listWorkspaceSnapshots`
- `restoreWorkspaceSnapshot`
- `deleteWorkspaceSnapshot`
- `SNAPSHOT_SCHEMA`

The matching CLI surface is:

```bash
pm workspace snapshot create before-migration
pm workspace snapshot list
pm workspace snapshot inspect before-migration
pm workspace snapshot restore before-migration --dry-run
pm workspace snapshot restore before-migration --force --message "Restore verified checkpoint"
pm workspace snapshot delete before-migration
```

Each object is identified by a SHA-256 fingerprint over sorted
tracker-relative paths, file sizes, and bytes. Repeated captures of identical
state deduplicate. Optional names are mutable references to immutable objects;
delete a reference before deleting the object it protects. Names cannot use the
64-character lowercase hexadecimal fingerprint shape, keeping reference and
object addressing unambiguous.

Snapshots include authoritative tracker files, including item documents,
history, schema, settings, and installed project extension state. They exclude:

- `runtime/`
- `search/`
- `locks/`
- `transactions/`
- `checkpoints/`

Restore stages the complete authoritative payload beside the tracker, swaps it
into place with directory renames, preserves the snapshot object store, and
discards stale caches and locks. Restore is guarded: use
`pm workspace snapshot restore <target> --dry-run` to inspect exact changed,
added, and removed file counts plus affected history streams and entries.
Mutation requires `--force`, captures the pre-restore state as a recovery
snapshot, and appends a durable `_workspace` audit event containing both
fingerprints, the impact summary, author, and reason. The SDK exposes the same
contract through `planWorkspaceSnapshotRestore` and returns the recovery
fingerprint and audit coordinates from
`restoreWorkspaceSnapshotWithRecovery`. The original
`restoreWorkspaceSnapshot(pmRoot, target)` signature remains compatible, but
now also captures recovery state and audit evidence before returning its
manifest.

Symbolic links are rejected so a snapshot cannot escape the tracker root.
Snapshot storage is clone-local under
`.agents/pm/runtime/workspace-snapshots`; it must not be committed or treated as
a backup of credentials. `pm gc --scope runtime` removes interrupted
`.create-*` and `.ref-*` publications after 24 hours while retaining newer
entries that may still belong to active operations.

Use snapshots as short-lived migration, reproduction, and package-development
checkpoints. Git plus immutable pm history remains the durable collaboration
record.
