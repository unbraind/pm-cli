# Digital Twin SDK Exemplar

Tracked by [pm-kr3t](../../.agents/pm/features/pm-kr3t.toon) under the
[universal non-PM SDK story](../../.agents/pm/stories/pm-8ngt.toon).

`@unbrained/pm-digital-twin` is an installable production-facility model built
only with `@unbrained/pm-cli/sdk` and extension contracts. It proves that pm's
context primitives can represent stable identities, observations, topology,
point-in-time state, provenance, invariants, offline replicas, and
tamper-evident exports without importing CLI or core internals.

The bounded domain is a facility containing machines, sensors, and utilities.
Assets can feed downstream assets or depend on utilities. Every state or
topology mutation is an attributable immutable relationship event; current
state is a derived projection, never an overwritten source of truth.

## Install and initialize

```bash
pm install ./packages/pm-digital-twin --project
pm profile apply twin

pm twin entity-create facility-main \
  --external-id FAC-001 \
  --kind facility \
  --state running \
  --event-id facility-created \
  --observed-at 2026-07-23T08:00:00Z

pm twin entity-create utility-air \
  --external-id UTL-AIR \
  --kind utility \
  --facility facility-main \
  --state stopped \
  --event-id utility-created \
  --observed-at 2026-07-23T08:01:00Z

pm twin entity-create machine-cutter \
  --external-id MCH-CUTTER \
  --kind machine \
  --facility facility-main \
  --state running \
  --event-id cutter-created \
  --observed-at 2026-07-23T08:02:00Z
```

The explicit entity and event ids are idempotency keys. Stable ids let an
interrupted workspace transaction resume without creating a second identity or
state event.

## Topology, observations, and corrections

```bash
pm twin relate facility-main \
  --target machine-cutter \
  --kind contains \
  --event-id facility-contains-cutter

pm twin relate machine-cutter \
  --target utility-air \
  --kind utility \
  --event-id cutter-needs-air

pm twin observe utility-air \
  --state running \
  --event-id air-started \
  --counter 2 \
  --replica edge-a \
  --observed-at 2026-07-23T08:03:00Z

pm twin observe utility-air \
  --state degraded \
  --event-id air-reading-corrected \
  --counter 3 \
  --replica edge-a \
  --supersedes air-started \
  --observed-at 2026-07-23T08:03:30Z
```

`--expected-version` adds optimistic concurrency to observations and topology
events. Replica id plus monotonic counter surfaces same-counter conflicts and
counter gaps instead of silently choosing a writer. Corrections reference the
superseded event; history stays append-only.

Schema generation 1 used `idle`; generation 2 normalizes it to `standby`.
Unsupported future generations remain replayable but produce an explicit
invariant finding.

## Query temporal context

```bash
pm twin query machine-cutter
pm twin query machine-cutter --at 2026-07-23T08:02:30Z
pm twin query machine-cutter --limit 20 --max-depth 8 --json
```

The query returns:

- current or event-time state with author and source provenance;
- direct typed topology with explicit traversal cost;
- bounded downstream impact and exact explanation paths;
- replica conflicts and operational invariant violations.

Timestamp snapshots use event time across the entire immutable stream. A late
offline observation is visible at its historical time and never causes an
earlier append with a future timestamp to leak into the requested view. Append
sequence remains the authority for `atVersion` snapshots and cursor paging.

The exemplar evaluates two operational rules:

- a running asset cannot depend on a non-running utility;
- a running downstream asset cannot be fed by a non-running upstream asset.

These policies remain package-owned; the SDK provides the graph, history,
query, and attribution mechanics.

## Checkpoint, export, federation, and restore

```bash
pm twin verify
pm twin verify --at 2026-07-23T08:03:00Z
pm twin export --limit 100 --json
pm twin import --payload '<bundle-json>' --json
```

Exports contain the node universe, bounded immutable events, truncation state,
and a canonical SHA-256 checkpoint. Import rejects a modified checkpoint,
validates events through `RelationshipEventLog`, and publishes the batch
atomically with `skip_identical` resume semantics.

Offline replica streams are merged by event time and event id. Byte-equivalent
event ids deduplicate. Same ids with different content produce a deterministic
conflict surface and are not silently published. Reopening the durable store
replays from genesis; verified checkpoints prove the exported prefix has not
changed.

## SDK boundary

The package source imports only:

```ts
import {
  RelationshipEventLog,
  RelationshipGraph,
  RelationshipKindRegistry,
  analyzeGraphImpact,
} from "@unbrained/pm-cli/sdk";
```

Command handlers use the host-bound `context.sdk.client`,
`openRelationshipEventStore`, and `commitWorkspaceTransaction` services. The
package never reads tracker files, shells to `pm`, or imports `src/core` or
`src/cli`.

See [GAP_REPORT.md](GAP_REPORT.md) for the capability-by-capability result.
