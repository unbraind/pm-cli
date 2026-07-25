# SDK entrypoint import costs

Tracked by [pm-38bskj](../../.agents/pm/tasks/pm-38bskj.toon).

This table measures fresh-process ESM import and module evaluation. The bare
Node v26.5.0 process floor on linux/x64
was 63 ms p50 (72 ms p95) across
5 measured runs after one warm-up. Focused entrypoints are
compared with the compatibility aggregate; negative reduction means the focused
entrypoint was slower in this sample.

| Package export     |    p50 |    p95 | p50 above Node | Reduction vs aggregate |
| ------------------ | -----: | -----: | -------------: | ---------------------: |
| `./sdk`            | 338 ms | 386 ms |         275 ms |                     0% |
| `./sdk/authoring`  |  82 ms |  97 ms |          19 ms |                  93.1% |
| `./sdk/contracts`  |  67 ms |  74 ms |           4 ms |                  98.5% |
| `./sdk/core`       | 344 ms | 389 ms |         281 ms |                  -2.2% |
| `./sdk/governance` | 227 ms | 245 ms |         164 ms |                  40.4% |
| `./sdk/graph`      | 119 ms | 130 ms |          56 ms |                  79.6% |
| `./sdk/merge`      | 167 ms | 183 ms |         104 ms |                  62.2% |
| `./sdk/query`      | 143 ms | 158 ms |          80 ms |                  70.9% |
| `./sdk/runtime`    | 319 ms | 355 ms |         256 ms |                   6.9% |
| `./sdk/testing`    |  85 ms |  95 ms |          22 ms |                    92% |

The aggregate `@unbrained/pm-cli/sdk` remains supported for compatibility.
New packages should import the narrowest subpath that owns their capability.
The committed budget file is an upper-bound ratchet and must not be weakened to
hide a regression.
