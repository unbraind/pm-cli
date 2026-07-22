# Context relevance and packing

Tracked by [pm-4k6b](../.agents/pm/features/pm-4k6b.toon), [pm-3hps](../.agents/pm/tasks/pm-3hps.toon), and [pm-801d](../.agents/pm/features/pm-801d.toon).

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
