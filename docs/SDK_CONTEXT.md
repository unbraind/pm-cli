# SDK context platform

Tracker: [pm-9hv1o7](../.agents/pm/issues/pm-9hv1o7.toon).

`pm` treats project management as context management. This task-oriented entry
point routes SDK hosts, package authors, CLI integrators, and agents to the
smallest authoritative context primitive.

## Choose the smallest authoritative read

- Use `PmClient.context()` for ranked working context and bounded workspace memory.
- Use `PmClient.listAllItemMetadataLight()` or
  `listAllItemMetadataLight(pmRoot)` for whole-project scalar metadata without
  bodies or heavy annotation/evidence collections.
- Use `PmClient.get(id, { depth: "deep" })` when one item needs its complete
  collections. Shallower reads carry an omission receipt naming every withheld
  group and the exact `--fields` restoration.
- Use mutation events for changes since a cursor instead of repeatedly loading
  a full workspace.

The root package, `sdk/runtime`, and `PmClient` expose the lightweight reader.
It distinguishes an empty tracker from a missing or invalid root and preserves
custom item-type folders from workspace settings.

## Rank and pack context

Context ranking combines recency, activity, graph proximity, priority, risk,
knowledge density, structural fit, and caller affinity. Derived signal snapshots
are rebuildable; item documents and history remain authoritative. Invalid,
stale, or unwritable snapshots return a stable warning, its meaning, an
executable recovery command, and the expected effect. Re-running `pm context`
confirms a successful rebuild as fresh.

Recency uses the public `classifyHistoryEvent()` contract and the most recent
substantive immutable event, with release-cohort and `created_at` fallbacks.
Explained ranking carries the selected coordinate, operation, and class.
`recordContextUsageServing()` plus `recordContextUsageDelivery()` expose the
same two-phase feedback boundary used by CLI and `PmClient`, so custom hosts can
correlate propensity rows with the exact result delivered after output budgets.

See [Context relevance and packing](CONTEXT_RELEVANCE.md) for signal and token
budgets, and [context coordination](SDK_CONTEXT_COORDINATION.md) for cursored
events and duplicate governance.

## Preserve truth at boundaries

Bounded reads disclose omissions. Bounded annotation mutations return the
changed entry instead of replaying complete history. Unknown-author findings
route directly to append-only attribution. Diagnostics remain read-only unless
a mutation is explicitly selected.

See [context integrity](SDK_CONTEXT_INTEGRITY.md) for output selectors,
annotation receipts, attribution coordinates, provider boundaries, and
replication enforcement; see [truth contracts](SDK_CONTEXT_TRUTH_CONTRACTS.md)
for tracker-root and merge-driver distinctions.

## Build package workflows

Use the root SDK for application workflows and `sdk/runtime` for dependency-light
host primitives. Runtime contracts are authoritative for active flags and
package-contributed commands:

```bash
pm <command> --help --json
pm contracts --command <command> --flags-only --json
pm contracts --runtime-only --json
```

Use `findSimilarItems` for one proposal, `findDuplicateClusters` for a bounded
whole-tracker sweep, and `prepareSimilarityText` with
`scorePreparedItemSimilarity` for custom pipelines. All paths share one
canonical Jaccard implementation and one canonical status-token normalizer.

See [context integrity primitives](SDK_CONTEXT_INTEGRITY_PRIMITIVES.md) for
duplicate batches, structured errors, Plan evidence, tombstones, linked-test
output, and extension output ownership.

## Validate and recover

Fast health projections use light metadata. Validation materializes collections
needed by evidence and relationship checks, but loads bodies only for strict
history-drift verification. Unknown-author remediation is shared:

```bash
pm health --verbose-author-events --json
pm history-author-acknowledge --all-actionable \
  --attributed-author "<principal>" \
  --reviewer "<reviewer>" \
  --reason "<evidence>"
```

Run repository gates after public SDK changes:

```bash
pnpm build
pnpm typecheck
pnpm quality:surface-replication
pnpm sdk:surface:check
node scripts/run-tests.mjs coverage
```

The replication gate reports an AST-derived denominator of repeated named rule
bodies and enforces a non-decreasing detector floor, so deleting declarations
cannot make recurring implementation rules disappear from governance reports.
