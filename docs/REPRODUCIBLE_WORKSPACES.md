# Reproducible Workspaces and Snapshots

Tracked by [pm-rbcvt2](../.agents/pm/features/pm-rbcvt2.toon),
[pm-dkrmzv](../.agents/pm/features/pm-dkrmzv.toon), and
[pm-gh1089](../.agents/pm/issues/pm-gh1089.toon).

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
concurrent recipes do not share counters. Normal CLI and MCP execution still
uses the system clock and cryptographic randomness unless the process opts in
through the environment contract below.

`defineWorkspaceRecipe` immediately validates the clock, seed, tick, schema,
operation actions, and recursively JSON-compatible inputs. Its TypeScript
contract additionally rejects undeclared top-level recipe keys at compile time.
The returned recipe is detached and deeply frozen, so later caller mutations
cannot change a queued replay.

Store recipes in source control only when their inputs are safe to publish.
Seeds are reproducibility inputs, not secrets. A replay is byte-identical only
when it begins from equivalent authoritative state and invokes the same ordered
operations with the same recipe.

## CLI and MCP process configuration

Shell-based harnesses can install the same SDK-owned deterministic context for
the `pm` and `pm-mcp` processes without patching JavaScript globals:

```bash
PM_CLOCK=2026-07-28T10:00:00.000Z \
PM_CLOCK_TICK_MS=1 \
PM_SEED=example-fixture-v1 \
pm create --title "Deterministic task" --type Task --json
```

`PM_CLOCK` and `PM_SEED` are required together. `PM_CLOCK_TICK_MS` is optional,
defaults to `1`, and must be a non-negative integer. Partial or invalid input
fails before command dispatch with the stable
`invalid_reproducible_process_environment` code and recovery that names the
missing or invalid variable. Unset all three variables for normal interactive
behavior.

Every CLI process invocation begins a fresh deterministic scope. A workflow
that launches several CLI processes must derive a stable, distinct seed for
each ordered step; reusing one seed intentionally reproduces the same entropy
sequence and can reproduce an existing generated identifier. A long-lived MCP
server instead owns one process-lifetime sequence and advances it across its
serialized JSON-RPC requests. Two equivalent servers therefore produce the
same files without generating duplicate identifiers inside either server.

The public SDK exports `PM_REPRODUCIBLE_PROCESS_ENV`,
`resolveReproducibleProcessEnvironment`,
`runWithReproducibleProcessEnvironment`, and
`createReproducibleProcessRunner` for custom one-shot and long-lived process
transports.

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
