# SDK entrypoint import costs

Tracked by [pm-38bskj](../../.agents/pm/tasks/pm-38bskj.toon) and
[pm-cg1sjb](../../.agents/pm/issues/pm-cg1sjb.toon).

This table measures fresh-process ESM import and module evaluation. The bare
Node v26.5.0 process floor on linux/x64
was 44 ms p50 (56 ms p95) across
5 measured runs after one warm-up. Focused entrypoints are
compared with the compatibility aggregate; negative reduction means the focused
entrypoint was slower in this sample. The gate admits the median measured run
against the unchanged upper-bound budget and 30 ms scheduler margin. A single
cold or descheduled process therefore cannot fail the gate, while a majority of
over-budget samples still does; p95 remains visible as diagnostic evidence.

| Package export | p50 | p95 | p50 above Node | Reduction vs aggregate |
|---|---:|---:|---:|---:|
| `./sdk` | 320 ms | 348 ms | 276 ms | 0% |
| `./sdk/authoring` | 91 ms | 99 ms | 47 ms | 83% |
| `./sdk/contracts` | 152 ms | 156 ms | 108 ms | 60.9% |
| `./sdk/core` | 285 ms | 291 ms | 241 ms | 12.7% |
| `./sdk/governance` | 211 ms | 220 ms | 167 ms | 39.5% |
| `./sdk/graph` | 92 ms | 105 ms | 48 ms | 82.6% |
| `./sdk/merge` | 130 ms | 145 ms | 86 ms | 68.8% |
| `./sdk/query` | 132 ms | 156 ms | 88 ms | 68.1% |
| `./sdk/runtime` | 283 ms | 312 ms | 239 ms | 13.4% |
| `./sdk/testing` | 274 ms | 319 ms | 230 ms | 16.7% |

The aggregate `@unbrained/pm-cli/sdk` remains supported for compatibility.
New packages should import the narrowest subpath that owns their capability.
The committed budget file is an upper-bound ratchet and must not be weakened to
hide a regression.
