# Bounded context reads and duplicate discovery

Tracked by [pm-pshhry](../.agents/pm/issues/pm-pshhry.toon),
[pm-ydshl9](../.agents/pm/issues/pm-ydshl9.toon),
[pm-bab3gb](../.agents/pm/issues/pm-bab3gb.toon),
[pm-fx80w2](../.agents/pm/issues/pm-fx80w2.toon),
[pm-gtw5zh](../.agents/pm/issues/pm-gtw5zh.toon), and
[pm-s8ybl9](../.agents/pm/issues/pm-s8ybl9.toon).

Project management is context management. Routine reads should pay for the
requested evidence, and derived feedback should not grow with every candidate
in a project's history. These primitives share SDK implementations across CLI,
MCP, and package consumers.

## Point reads

`pm get <id>` at standard depth reads the addressed item and its own history.
It does not enumerate unrelated items to compute child counts. `--depth brief`
and `--fields id,title` also omit claim-history work and heavy output facets.
The cost still depends on the addressed record, registered type directories,
and extension activation; this is not a constant-latency guarantee for arbitrary
extensions or unbounded individual history streams.

Request hierarchy work explicitly with `--fields id,children`, `--tree`, or a
deep/full container read. These paths preserve registered hierarchy semantics,
including inverse and custom relationship kinds, rather than treating only the
scalar `parent` field as authoritative. An omitted `children` facet carries a
restore selector in the omission receipt.

Caller-carried output sessions retain only portable item identities in
`next_state.seen_item_ids`. Workspace activity such as `_workspace` remains
visible in full on subsequent reads. It cannot become an invalid item reference
or make the next read reject a state produced by the previous read.

The optional SQLite projection binds each FTS document to the corresponding
`items.rowid`. Maintenance resolves the indexed item identity and deletes the
single FTS row, avoiding a scan of the unindexed FTS `id` column on every insert,
update, or deletion. Derived index version 5 rejects older projections and
rebuilds them from authoritative metadata. Real SQLite query-plan tests retain
the old predicate as a negative control and verify search results after updates
and deletions. SQLite documents the distinction between
[FTS columns and row identity](https://www.sqlite.org/fts5.html).

## Exact duplicate candidates

```bash
pm duplicates --status all --threshold 0.8 --json
pm duplicates --status open --exhaustive --json
```

The default algorithm orders title tokens by corpus frequency and uses a
Jaccard prefix join. For a set of size `n` and threshold `t`, a prefix of length
`n - ceil(t*n) + 1` must intersect the similarly ordered prefix of every
qualifying set. The length filter rejects impossible token matches before
scoring. Exact normalized titles, issue codes, and empty-token matches retain
the canonical scorer's separate rules. This follows the established
[all-pairs similarity-search approach](https://research.google/pubs/scaling-up-all-pairs-similarity-search/).

Both modes retain exact recall relative to the canonical title scorer.
`cost` discloses `algorithm`, `item_count`, `possible_pairs`, `candidate_pairs`,
`scored_pairs`, `pair_limit`, and `recall_guarantee`. The one-million-candidate
safety ceiling remains enforced. Dense duplicate output or a zero threshold
can still require quadratic work; the command refuses without returning a
partial answer. Exact recall is not a claim that every semantic duplicate has
similar titles. Review the actual item evidence before merging or closing.

Packages with remote or custom stores can use the same kernel without building
a filesystem tracker:

```ts
import { analyzeDuplicateItems } from "@unbrained/pm-cli/sdk/query";

const result = analyzeDuplicateItems([
  { id: "work-a", title: "Publish research protocol", type: "Task", status: "open" },
  { id: "work-b", title: "Publish research protocol", type: "Task", status: "closed" },
]);
console.log(result.clusters, result.cost);
```

The function preserves its input, validates unique nonempty identifiers, and
returns deterministic components and scored pair evidence. The filesystem
`findDuplicateClusters`, `PmClient.duplicates`, CLI and MCP adapters reuse it.
Record the algorithm and cost receipt in create-time duplicate-check evidence.

## Feedback storage

Serving receipts retain the full candidate population in memory for final
delivery validation. Persisted events retain only the first 256 candidate rows,
with explicit population and omission counts. Only sampled ids observed in the
final emitted result can train affinity. This deterministic sample has no
unbiased-propensity claim. Unknown row properties are not persisted.

`CONTEXT_USAGE_LIMITS` publishes a 256 KiB physical ceiling, a 32 KiB individual
event ceiling, 2,048 retained events and a 30-day default horizon. Writers share
a cross-process lock. High-water compaction atomically replaces the ledger with
a suffix of at most half the byte ceiling, leaving append headroom. Readers
consume at most the byte ceiling even for an oversized legacy file. Custom
retention controls can tighten the limits; invalid controls fail before I/O.

Serving receipt `storage` reports actual `written_bytes`, `ledger_bytes`,
`compacted`, and `lock_wait_ms`. Written bytes count ledger data rather than lock
metadata or filesystem block allocation. The receipt is attached to results
through a non-JSON symbol and does not inflate normal CLI output. Storage is
derived and disposable; item history remains independent.

## Reproducible measurements

```bash
pnpm build
node scripts/bench/context-read-costs.mjs 10000 100000 1000000
node scripts/bench/point-read-costs.mjs 100 10000 100000
```

The script uses paired titles with common project vocabulary, compares a
1,000-item subset against exhaustive scoring, and runs four concurrent writers
for 40 serves per tier in temporary storage. It asserts exact reference equality,
expected pair counts, reachable byte ceilings, and append headroom. Property
tests additionally vary thresholds, Unicode, punctuation, and issue identifiers.

The point-read script holds the addressed Epic constant while varying corpus
size. Its explicit child scan must observe every generated item. Fixture setup
registers all generated types, including `Story`, through the live SDK schema
and uses deterministic SDK execution for byte-reproducible workspace history.

The 2026-09-05 filesystem run observed the following timings (10 reads per
projection, including feedback writes). The explicit scan includes the cold
derived-index rebuild; these are host observations rather than latency gates.

| Corpus items | Standard p95 | Brief p95 | Fields p95 | Explicit full scan | Verified scan rows |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 4.53 ms | 4.24 ms | 3.54 ms | 48 ms | 100 |
| 10,000 | 3.61 ms | 3.03 ms | 4.08 ms | 4.91 s | 10,000 |
| 100,000 | 3.69 ms | 11.00 ms | 3.11 ms | 48.59 s | 100,000 |

Measured on 2026-09-05 with Node 26.7.0; these are observations, not portable
latency guarantees. Duplicate timings exclude filesystem ingestion.

| Items | Possible pairs | Scored pairs | Analysis time | Mean bytes written per serve | Compactions / serves | Final ledger bytes |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10,000 | 49,995,000 | 5,000 | 92 ms | 18,138 | 2 / 40 | 237,785 |
| 100,000 | 4,999,950,000 | 50,000 | 864 ms | 18,149 | 2 / 40 | 237,821 |
| 1,000,000 | 499,999,500,000 | 500,000 | 10,367 ms | 18,135 | 2 / 40 | 237,857 |

The same four-writer runs include full in-memory candidate validation and final
delivery recording. Throughput therefore still falls with candidate population.

Lock-wait percentiles use the empirical nearest rank across all 40 serving
receipts; these are four concurrent tasks sharing a cross-process lock, not a
measurement of four separate OS processes.

| Candidate rows per serve | Serves/s/workspace | Minimum wait | p50 wait | p95 wait | Maximum wait |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 10,000 | 46.73 | 3.11 ms | 25.15 ms | 84.97 ms | 105.66 ms |
| 100,000 | 20.82 | 18.29 ms | 50.10 ms | 193.86 ms | 229.60 ms |
| 1,000,000 | 1.92 | 198.10 ms | 809.52 ms | 1,367.67 ms | 1,622.77 ms |

Reference recall was 100% at every tier. The million-item batch does not meet
the broader one-second project target; persistent incremental ingestion and
analysis remain necessary for that target. Full candidate validation still
costs O(candidate count) in memory even though persisted feedback is bounded.
On the live 2,638-item corpus, default discovery completed after scoring 3,136
of 3,478,203 possible pairs; the prior algorithm refused at its safety ceiling.
