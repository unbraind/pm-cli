# Performance and scale

Tracker: [pm-mi2x](../.agents/pm/chores/pm-mi2x.toon) under the [pm-9rxu scale-out initiative](../.agents/pm/epics/pm-9rxu.toon).

`pm` treats wall time, memory, and agent token cost as one performance contract: project management is context management, so a fast command that emits an unbounded payload is still slow for its caller.

## Current targets

Every measured CLI and SDK operation targets:

- p95 wall time at or below 1,000 ms;
- default output at or below 5,000 estimated tokens;
- no feature, flag, output, history, or validation loss.

The committed regression budgets in [`scripts/bench/scale-budgets.json`](../scripts/bench/scale-budgets.json) protect the current baseline while the product targets stay fixed. Short local checks use the best observed latency as a regression floor; statistically meaningful runs of 20 or more use p95. Both receive 25% baseline headroom plus a 25 ms scheduler/filesystem noise margin. Reports always retain min/p50/p95, and product-target status always uses p95. This lets a busy workstation detect deterministic code slowdowns without pretending that three samples produce a meaningful p95 or hiding the real tail-latency target.

## Reproducible fixtures

Generate a deterministic isolated workspace without touching the current tracker:

```bash
pnpm build
pnpm benchmark:scale:generate --output /tmp/pm-scale --items 10000 --mode direct
PM_PATH=/tmp/pm-scale/.agents/pm PM_GLOBAL_PATH=/tmp/pm-scale-global pm validate --json
```

Named tiers are `smoke` (100), `ci` (10,000), `large` (100,000), and `million` (1,000,000). The `ci` name describes the fixture size for compatibility with existing benchmark data; these performance workloads run locally and are intentionally absent from GitHub Actions. `direct` writes bounded batches for large fixtures; `sdk` uses the public SDK atomic-write and history primitives. Both modes serialize the same deterministic item and history bytes.

The fixture models built-in item types, open/in-progress/blocked/closed/canceled states, parents, dependencies, tags, bodies, comments, notes, learnings, and one valid history stream per item. It refuses to generate inside this repository. `--force` replaces a non-empty target only when that target already contains the scale-fixture manifest, so a mistyped arbitrary directory is never recursively removed.

## Benchmark runner

Run CLI cold-process and SDK warm-process measurements together:

```bash
pnpm benchmark:scale --items ci --iterations 3 --transport both --check
```

The JSON report records fixture generation time plus one excluded warmup observation and measured p50/p95/min/max latency, peak RSS on Linux, output bytes, and estimated tokens for `list`, `get`, `next`, `context`, `search`, `create`, and `claim`. The warmup exposes initial index-build cost while regression percentiles measure the continuously warm derived-index contract across real cold CLI processes and in-process SDK calls. Run the committed local regression check with `pnpm benchmark:scale:check`. GitHub-hosted runners do not execute the scale suite, which keeps expensive performance work off Actions and avoids consuming hosted-runner capacity.

The metadata read cache is rebuildable derived state. Workspaces with at least
500 indexed items use its directory-validated fast path to avoid per-item
stats; validation and recovery can force a canonical source scan. Every
metadata, body, and collection tier carries one `source_cursor`. A small
manifest exposes the base cursor and item count without parsing the full index.
A supported create, update, move, or delete acquires the cross-process
derived-index writer lock before the authoritative item commit and atomically
publishes one collapsed delta containing every compatible tier projection,
directory signatures, and the next cursor before releasing the lock. Mutation
cost therefore follows changed items rather than total workspace size. A torn,
corrupt, or base-mismatched delta is rejected and rebuilt from source.

SDK hosts that commit authoritative item documents outside the stock mutation
commands use `acquireItemMetadataDerivedIndexLock` and
`refreshItemMetadataDerivedIndex` from `@unbrained/pm-cli/sdk` around the same
commit boundary. Repeated writes collapse by item path in the delta instead of
growing an event log; a later source scan compacts the projection into fresh
base tiers. Projection failure removes the rebuildable tiers, delta, and
manifest and returns a warning; it never rolls back or outranks the
authoritative item/history write. Small workspaces without an active index
receive a no-op release function and retain direct external-edit detection.

Context-signal snapshots follow the same rule: they are versioned and
cursor-stamped, never authoritative, and rebuild from the metadata index or
source-scan fallback when missing, stale, or corrupt. The stock `context` and
`next` projections use separate snapshot namespaces, persist only
caller-independent signals, and recompute author, time, semantic, and usage
overlays on every read. SDK hosts can use `readWorkspaceContextSignals` for the
same automatic cursor binding or compose `ContextSignalStore` directly, while
retaining explicit `fresh`/`rebuilt` and `derived_index`/`scan_fallback`
diagnostics. See [Context relevance and packing](CONTEXT_RELEVANCE.md).

To refresh a baseline after an intentional, measured improvement:

```bash
pnpm benchmark:scale --items ci --iterations 5 --transport both --update --headroom 1.25
```

Review the report and budget diff together. Never update a budget merely to silence a regression.

## Startup and observability

Sentry is loaded only when an error-reporting path actually initializes it. Disabled and normal successful commands do not resolve or compile the `@sentry/node` → OpenTelemetry → Undici graph. The loader uses the package's supported CommonJS export after the opt-out gate, preserving the repo-wide ban on dynamic/inline imports while keeping enabled capture, sanitization, and flush behavior intact.
