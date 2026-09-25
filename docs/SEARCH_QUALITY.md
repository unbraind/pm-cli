# Semantic Batching and Retrieval Quality

Tracked by [pm-vjgqj5](../.agents/pm/issues/pm-vjgqj5.toon) and
[pm-p1g43q](../.agents/pm/features/pm-p1g43q.toon).

## Agent Quick Context

Use `pm reindex --mode semantic --progress` to refresh stale embeddings and
`pm eval --queries ./queries.json --k 10` to measure retrieval. A successful
index refresh proves that vectors were written, not that relevant items rank
well. Evaluate quality separately.

## Independent Input and Request Limits

The built-in scheduler preserves `search.embedding_batch_size` as the maximum
number of input positions per planned batch. Per-input text truncation still
uses `search.embedding_corpus_max_characters` or the provider default.

Requests additionally have a 256 KiB encoded JSON byte ceiling. This counts
UTF-8, JSON escaping, array separators, and model metadata; it is independent of
the per-input character limit. OpenAI's single-string encoding and duplicate
input elimination can make the actual payload smaller than this conservative
planning bound. An individual input that cannot fit is refused before any
request is sent. Empty inputs are also refused rather than silently shifting
vector positions.

SDK hosts may supply `maxRequestBytes` to
`executeEmbeddingBatchesWithRetry`, exported by
`@unbrained/pm-cli/sdk/query`. The request ceiling is a transport
bound, not a model tokenizer or context-window claim. Model input limits remain
provider-owned. [Ollama's embedding API](https://docs.ollama.com/api/embed)
accepts arrays of inputs and describes its own context truncation behavior.

HTTP 413 and timeout failures split a multi-input batch in half. Both halves
complete in source order. Other failures use the configured bounded retry
policy. A singleton failure terminates the operation; failed execution never
returns a partial vector array. Sequential execution avoids creating a burst
of concurrent requests against a local embedding model.

HTTP status takes precedence over response text: a non-413 error containing
the word "timeout" does not trigger splitting. For a planned batch of `n`
positions, binary subdivision creates at most `2n - 1` request nodes, each
with at most `scanner_max_batch_retries + 1` attempts. SDK hosts accepting
untrusted workloads should constrain corpus size, retry settings and the
caller-supplied byte ceiling to their provider budget; this primitive does not
impose a universal account-level quota.

`pm reindex` exposes `semantic.batching` for built-in providers:

- `planned_batches` counts batches before adaptation;
- `requests`, `successful_batches`, `split_batches`, and `retries` describe
  actual execution;
- `batch_size_histogram` counts successful requests by input positions;
- `elapsed_ms` and `inputs_per_second` include retry backoff;
- `provider`, `model`, `max_request_bytes`, and `limit_source` explain the run.

These receipts contain no input text, credentials, or endpoint addresses.
Empty work retains the existing empty result; extension providers do not
receive a fabricated built-in batching receipt.

## Per-query Quality Floors

A golden query may declare a `minimum` object containing any of `ndcg`, `mrr`,
`precision`, and `recall`. Each value must be a finite number in `[0, 1]`.
Unknown metric names fail validation so a spelling error cannot remove a gate.

```json
[
  {
    "query": "snapshot restore durability",
    "relevant_ids": ["pm-snapshot", "pm-restore"],
    "mode": "keyword",
    "minimum": { "recall": 0.5, "mrr": 0.5 }
  }
]
```

Replace the example IDs with judgments from your workspace. `pm eval` compares
unrounded scores to these floors and reports `violations` on the affected query.
It exits nonzero if any floor fails, even when no `--fail-under` is supplied or
the aggregate nDCG passes. Existing query sets without floors retain their
aggregate-only behavior. The public query SDK exports `parseEvalMetricFloors`
and `evaluateMetricFloors` for package-owned evaluations.

The repository's `quality:retrieval-eval` gate also pins floors by query text
and retrieval mode. Missing, unexpected or duplicated identities and mismatched
declared row counts fail. Explicit
`--update` refreshes never lower a prior floor or discard a missing required
query. A baseline update is a reviewed policy change; it is not permission to
change relevance judgments until a score turns green.

## Verification Boundaries

Real loopback HTTP tests exercise batching, Unicode payloads, 413 recovery,
vector ordering, and pre-dispatch refusal. Evaluator tests exercise the case
where the macro average passes while one query fails. These are transport and
quality-contract proofs, not measured million-item model throughput, semantic
ranking improvements, parallel scheduling, or durable partial-run resume.
Those broader acceptance criteria remain tracked by the linked items.

## Portable Delivery Evidence

Workspace-owned custom types used by delivery records must be declared in the
tracked project schema. An ignored local extension installation does not make
its types available to a fresh CI checkout. This repository declares `Changeset`
in `schema/types.json` through `pm schema add-type`, and verifies changelog output
in a clean checkout with only the published changelog package installed.

Schema `--dry-run` applies to rename/remap migrations and workflow-policy
actions. Other schema operations refuse the flag before writing, through the
shared SDK guard used by CLI and SDK/MCP dispatch. For example,
`pm schema rename-type Spike --to Experiment --dry-run` previews a migration;
`pm schema add-type Spike --dry-run` is refused. Adding a type is an explicit
write operation. Tracked by [pm-s74dca](../.agents/pm/issues/pm-s74dca.toon).
SDK hosts can reuse `assertSchemaPreviewSupported(subcommand, dryRun)` from
`@unbrained/pm-cli/sdk` when dispatching built-in schema operations.
