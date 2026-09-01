# Context relevance and packing

Tracked by [pm-4k6b](../.agents/pm/features/pm-4k6b.toon), [pm-07pt16](../.agents/pm/issues/pm-07pt16.toon), [pm-wv47pf](../.agents/pm/issues/pm-wv47pf.toon), [pm-3hps](../.agents/pm/tasks/pm-3hps.toon), and [pm-801d](../.agents/pm/features/pm-801d.toon).

`pm context` and `pm next` share one public SDK relevance pipeline. The built-in
commands assemble authoritative item metadata, load rebuildable signal rows,
apply caller-dependent overlays, run the active relevance scorer, and pack the
ranked result within an explicit token budget.

```text
item metadata -> signal snapshot -> dynamic overlays -> scorer -> token packer
```

## CLI controls

Use `--explain-ranking` when a client needs score contributions, packing
accounting, and feature-store provenance. Compact output omits this diagnostic
envelope. Both commands accept `--token-budget <n>` so an agent can bound the
estimated tokens spent on ranked rows independently from the row limit.

```bash
pm context --limit 10 --token-budget 1200 --explain-ranking --json
pm next --ready-only --limit 5 --token-budget 480 --explain-ranking --json
```

The response echoes the effective budget in `filters.token_budget`. Explained
responses include `packing.token_budget` plus `ranking.feature_store` with:

- `source`: `derived_index` or `scan_fallback`;
- `cache_status`: `fresh` or `rebuilt`;
- `source_cursor`: the exact metadata projection cursor;
- `generated_at`: snapshot creation time.

Missing, stale, corrupt, or unwritable derived data never outranks authoritative
item files. The command rebuilds or degrades with a warning instead.

## SDK primitives

Package authors can use the same stages without importing CLI internals:

- `readWorkspaceContextSignals(items, options)` selects metadata-index
  provenance automatically, persists a workspace-bound snapshot, and returns
  scorer-ready candidates;
- `ContextSignalStore` and `JsonFileContextSignalStoreAdapter` support custom
  storage hosts with explicit cursors;
- `buildItemContextRelevanceCandidates` derives the canonical dynamic signals;
- `scoreContextCandidates` and
  `scoreContextCandidatesWithActiveExtensions` run the default or governed
  scorer;
- `packRankedContextItems` applies a deterministic estimated-token budget;
- `readItemMetadataDerivedIndexState` exposes the effective rebuildable cursor
  without exposing runtime file layout.
- `readWorkspaceMemory`, `selectWorkspaceMemoryRollups`, and
  `searchWorkspaceMemory` expose the large-workspace historical tier without
  expanding the complete closed corpus into an agent packet.

`readWorkspaceContextSignals` accepts `storeKey` when one workspace serves
different candidate corpora. The stock commands use separate `context` and
`next` namespaces so an identical cursor cannot accidentally reuse rows from a
different projection.

## Stable and dynamic signals

Snapshots persist only metadata-derived, caller-independent values: recency,
activity density, graph proximity, priority pressure, risk pressure, and
knowledge density. Claim focus, deadline pressure, author affinity, usage
affinity, and semantic similarity are recomputed or overlaid for every read.
This keeps a fresh snapshot reusable across agents without leaking one caller's
identity, clock, or serving history into another caller's ranking.

The stock activity density normalizes comments, notes, learnings, and test runs.
Graph proximity normalizes parent and dependency degree. SDK hosts can supply
their own pre-normalized signal maps when their project model has richer
activity, graph, semantic, or usage data.

### Substantive recency

Recency is a property of what happened, not of the last file write. Every new
history entry declares `event_class: substantive|maintenance` through the
versioned `classifyHistoryEvent()` SDK contract. Legacy entries are classified
by the same declared operation and patch-field policy; unknown operations fail
closed as substantive. Package and extension scorers can therefore reuse the
core vocabulary instead of maintaining private operation lists.

The signal selects the most recent substantive history event, then a stamped
calendar release cohort such as `v2026.7.20`, then `created_at`. It never ranks
bare `updated_at`, so release attribution, relationship enrichment,
normalization, linked-artifact updates, and history maintenance cannot promote
otherwise unchanged work. The rebuildable v4 history-event index stores the
declared class and retrieves one latest substantive row per requested stream;
individual immutable streams remain the authoritative fallback. Rebuilds,
indexed validation reads, and compliant history appends share one cross-process
coordination lock, while each append also commits its projection row and stream
size in one SQLite transaction.

Explained ranking includes `recency.source`, `coordinate`, and, for history,
`history_op` plus `event_class` on every served scorer row. Signal snapshots
persist that evidence alongside the normalized value so a fresh snapshot keeps
the same explanation as the ranking it serves.

### Delivered usage feedback

Usage affinity learns from post-egress delivery rather than pre-budget packing.
A versioned serve event records the full propensity rows and a correlation id;
CLI and `PmClient` egress append a delivery event containing the final
`result_omitted` decision and exact emitted item ids. A whole-result omission
therefore delivers zero items even when the packer selected rows earlier.

Direct `runContext` and `runNext` calls remain valid delivery boundaries and
record their assembled rows on the serve event. A later CLI or client
projection supersedes that initial decision with its correlated delivery.
Legacy serve events have no correlation marker, so the affinity reader ignores
their inclusion flags and reports them as `untrusted_serving_events` instead of
training on unverifiable phantom serves.

For corpora of at least 10,000 items, `context` automatically allocates a
bounded fraction of its token budget to recent calendar-epoch and epic-lineage
rollups. `search` attaches only matching rollups. The projection contains
bounded item references, completion outcomes, and knowledge-entry counts; it is
versioned and tied to the same source cursor as the metadata index. Small
workspaces return no memory block, avoiding derived-state and token overhead.

## Correctness contract

The feature store is optimization state, not a second source of truth. A
metadata-index cursor changes with supported item mutations. Scan fallback uses
a deterministic corpus cursor. Snapshot rows are accepted only when format,
signal-set version, source, cursor, item identities, timestamps, and normalized
signal values validate. Dynamic overlays always use the current item objects.

Run the repository's context evaluation and scale gates when changing this
pipeline:

```bash
pnpm quality:context-eval
pnpm quality:token-budget
pnpm benchmark:scale:check
```
