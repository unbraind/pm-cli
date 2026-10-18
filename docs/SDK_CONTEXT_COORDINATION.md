# SDK context coordination primitives

Trackers: [pm-e200](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-e200.toon), [pm-ez1dfg](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ez1dfg.toon), [pm-4ri6](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/features/pm-4ri6.toon), [pm-hcrmye](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-hcrmye.toon), [pm-gh1485](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-gh1485.toon), and [pm-xj80p9](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-xj80p9.toon).

Tracker records live in the repository and are excluded from the npm package.

`pm` treats project management as context management. These primitives let an
agent learn what changed, avoid creating redundant work, and keep that work
bounded at scale without shelling out from an SDK host.

## Agent quick context

- Use `pm events` for cross-process mutation facts instead of repeatedly
  requesting whole-workspace context.
- Persist the returned cursor and resume with `--since`; cursors are bound to
  their filters and cannot be reused for a different query accidentally.
- Duplicate governance is disabled by the minimal preset, advisory by default,
  and strict under the strict preset. Configure `advisory` to report likely
  matches or `strict` to require an explicit `--allow-duplicate` bypass.
- Authoritative TOON item documents and JSONL history remain the source of
  truth. SQLite indexes are rebuildable projections.

## Durable mutation events

Read committed history facts as newline-delimited JSON:

```bash
pm events --type create --author agent-a --limit 100
pm events --since <cursor> --item pm-abcd
pm events --since <cursor> --follow --interval-ms 250
pm events --cursor-mode row --since <cursor>
```

By default, event rows carry `item_id`, `version`, `ts`, `author`, `type`, and
`patch_count`, followed by one `pm.stream.trailer` record with `count`,
`has_more`, `next_cursor`, and `source`. Persist the trailer cursor only after
the batch is durable. A crash before cursor persistence can replay the last
batch repeatedly, including across multiple crashes. Consumers must process
idempotently or deduplicate replays. `--cursor-mode row` preserves the previous
shape with one `cursor` per event and no trailer for consumers that checkpoint
every row. Already issued version-1 cursors remain accepted by `--since`.

Version-1 cursor ordering uses recorded timestamps, stream ids, and offsets.
A fact committed later with an older timestamp falls before an advanced cursor.
Clock-independent ordering and late-commit recovery remain tracked by
[pm-10l1vm](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-10l1vm.toon). Hosts needing complete concurrent
observation can retain a fixed lower boundary and deduplicate snapshots by
`item_id` and `version` while work is being committed.

Runtimes exposing `node:sqlite` use the rebuildable SQLite event projection.
Runtimes without it transparently scan the authoritative history
streams with the same ordering, filters, pagination, and cursor contract; pages
identify that path with `source: "authoritative_history"`.
Writers without SQLite use the same pending and committed invalidation protocol,
so a later Node writer cannot certify a cache that omitted their facts.
Incremental writes also verify the previous size receipt before advancing it,
so merged history cannot be hidden by a later append. Upgraded runtimes rebuild
legacy projections that could contain omitted facts with apparently current
receipts; authoritative history does not require a format migration.

Index readers take a synchronous SQLite read transaction containing both event
rows and their stream-size receipts, then close the database before checking
authoritative files. They acquire neither history-index writer lock. File
identity and write timestamps, authoritative stream sizes, and pending or
committed invalidations must still match before a snapshot is returned. A
concurrent change refuses the optional snapshot; it cannot certify older rows
using a newer size receipt.

Incremental projection writes also use a zero SQLite busy timeout. Native
reader or writer contention falls back to the authoritative append and
invalidation protocol instead of spending a separate SQLite wait budget.
An unexpired, token-owned append lease marks ordinary incremental work as
active until its commit or invalidation completes. Native contention retains
the cache file and a committed contention marker; a zero-wait native probe
distinguishes an ongoing contender from settled damage before requesting repair.

Authoritative writers fail fast when an active owner holds the projection writer
lock, including when a full repair owns it. They publish an invalidation instead.
Stale-owner recovery follows the built-in lock policy. A repair
refuses publication if those markers changed during its scan. Full projection
construction yields between batches, and marker cleanup occurs outside the
short invalidation publication lock.
After a refused full publication or failed repair, a best effort per-tracker runtime receipt
defers automatic repair for five seconds. Busy periods therefore do not restart
a complete SQLite build on every read. Pages and recency reads continue using
authoritative history; after the cooldown, a later read can repair during a
quiet interval. This backoff bounds repair frequency, not index availability
during continuous writes.

Transient generation changes and SQLite contention use authoritative fallback
directly. Missing, incompatible, or damaged projections receive one optional
repair attempt without waiting for either projection lock. Repair failure or
invalidation after rebuilding
falls back to authoritative JSONL with the same filters and cursor format.
Pages may change `source` between calls. A fallback still reports malformed or
inaccessible authoritative history as an error. A successful repair may scan
the workspace; this protocol bounds lock waiting, not total execution time.

`--full` also includes the complete authoritative history entry.
`--type`, `--author`, and `--item` accept repeatable or comma-separated values.
`--since` accepts either a cursor or an ISO timestamp. The CLI emits only event
rows and the typed terminal record, so consumers can distinguish data from
recovery metadata without relying on position alone. Under `--follow`, every
non-empty page ends at the same batch boundary and an empty boundary is emitted
as an idle heartbeat.

The public SDK provides bounded pages and an abortable async iterator:

```ts
import {
  listMutationEvents,
  subscribeMutationEventBatches,
  subscribeMutationEvents,
} from "@unbrained/pm-cli/sdk";

const eventTypes = ["create", "update"] as const;
let cursor: string | undefined;
let hasMore = true;
while (hasMore) {
  const page = await listMutationEvents({
    pmRoot,
    type: eventTypes,
    limit: 100,
    ...(cursor === undefined ? {} : { since: cursor }),
  });
  await consumeBatch(page.events);
  await persistCursor(page.next_cursor);
  cursor = page.next_cursor;
  hasMore = page.has_more;
}

const controller = new AbortController();
for await (const batch of subscribeMutationEventBatches({
  pmRoot,
  type: eventTypes,
  ...(cursor === undefined ? {} : { since: cursor }),
  signal: controller.signal,
})) {
  await consumeBatch(batch.events);
  await persistCursor(batch.next_cursor);
}
```

`subscribeMutationEvents` remains the per-event compatibility iterator and
defaults to row cursors. `subscribeMutationEventBatches` is the token-efficient
coordination primitive; it exposes the same boundaries used by the CLI.

The `pm_events` MCP tool exposes the same bounded page contract. Consumers such
as notification packages can store `next_cursor`, catch up after a restart,
then follow without requiring a daemon. A pm-slack migration can replace
workspace polling with this SDK iterator while keeping delivery state in the
package.

The derived event index orders every history stream by timestamp, stream id,
and stream offset. Appends update it incrementally; audited history rewrites
invalidate it; a missing or stale index rebuilds from JSONL. Cursor fingerprints
include the filters, preventing silent skips when a caller changes scope.

## Similarity and duplicate governance

Package authors can query the same scorer used by create/copy and the bundled
governance audit:

```ts
import { findSimilarItems, scoreItemSimilarity } from "@unbrained/pm-cli/sdk";

const score = scoreItemSimilarity("Fix OAuth refresh", "Fix oauth refresh");
const matches = await findSimilarItems(
  { title: "Fix OAuth refresh", excludeIds: ["pm-source"] },
  { pmRoot, threshold: 0.8, limit: 3 },
);
```

`findSimilarItems` returns deterministic ranked records with id, title, status,
and score evidence. A warm metadata query index uses bounded SQLite FTS
candidates. Explicit SDK queries can fall back to authoritative metadata when
that projection is unavailable. Exact normalized titles and matching issue
codes receive stable high-confidence scores; other lexical matches use token
overlap. `pm-governance-audit` imports these same pure runtime exports, so
create-time and post-hoc duplicate detection cannot drift.

Configure create/copy behavior with discoverable scalar settings:

```bash
pm config project set governance-duplicate-detection-mode advisory
pm config project set governance-duplicate-detection-threshold 0.8
pm config project set governance-duplicate-detection-limit 3
```

Modes:

- `off`: no create-path query; this is the minimal preset behavior.
- `advisory`: create/copy succeeds and reports the top matches in warnings and
  the structured `similarity_advisory` result.
- `strict`: a threshold match rejects the mutation unless the caller supplies
  `--allow-duplicate` (or `allowDuplicate: true` through SDK/MCP).

The strict governance preset enables strict duplicate detection. The bypass is
deliberate and visible at the mutation boundary; it does not claim
transactional content uniqueness, so post-hoc dedupe remains useful for truly
simultaneous creates.

The documented config spelling is kebab-case. Underscore spellings remain
accepted aliases for existing automation.

## Scale contract

The mixed-reader acceptance used 100 fixed-boundary snapshot observers,
five SDK writer lanes, and five CLI writer lanes, with five updates per lane.
Both separate traced and untraced cohorts passed 5,000 unique observations,
duplicate-free pages, strict history integrity, and a 2,000 ms first-observation
ceiling. These are bounded host measurements recorded in
[pm-gh1485](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-gh1485.toon).

The native regression suspends filesystem validation and requires an
authoritative writer to finish before that reader resumes. Run it with:

```bash
node scripts/run-tests.mjs test -- tests/unit/core/history/event-index-snapshots.spec.ts
```

Event catch-up reads from a persistent ordered projection and follows only new
rows. Similarity governance is zero-cost when off and index-bounded when
enabled on an indexed workspace. Production bundles are syntax-, whitespace-,
and identifier-minified, and command-family registration loads only the create
surface for a cold `pm create`.

The fixed 10,000-item latency, RSS, correctness, and token budgets remain
unchanged. See [Performance and scale](PERFORMANCE.md) for the reproducible
gate; never relax a budget to accommodate a new context primitive.

## Contract discovery

Do not copy flag or tool schemas into package code:

```bash
pm events --help --json
pm contracts --command events --flags-only --json
pm contracts --runtime-only --json
```

The main SDK barrel is the high-level application surface. Package adapters
that need dependency-light host primitives can import
`@unbrained/pm-cli/sdk/runtime`; the similarity scoring exports are available
there without importing the tracker query implementation.
