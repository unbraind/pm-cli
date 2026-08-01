# SDK entrypoint import costs

Tracked by [pm-38bskj](../../.agents/pm/tasks/pm-38bskj.toon).

This table measures fresh-process ESM import and module evaluation. The bare
Node v26.5.0 process floor on linux/x64
was 41 ms p50 (48 ms p95) across
5 measured runs after one warm-up. Focused entrypoints are
compared with the compatibility aggregate; negative reduction means the focused
entrypoint was slower in this sample.

| Package export | p50 | p95 | p50 above Node | Reduction vs aggregate |
|---|---:|---:|---:|---:|
| `./sdk` | 248 ms | 249 ms | 207 ms | 0% |
| `./sdk/authoring` | 71 ms | 76 ms | 30 ms | 85.5% |
| `./sdk/contracts` | 73 ms | 87 ms | 32 ms | 84.5% |
| `./sdk/core` | 221 ms | 255 ms | 180 ms | 13% |
| `./sdk/governance` | 154 ms | 161 ms | 113 ms | 45.4% |
| `./sdk/graph` | 87 ms | 87 ms | 46 ms | 77.8% |
| `./sdk/merge` | 111 ms | 122 ms | 70 ms | 66.2% |
| `./sdk/query` | 100 ms | 105 ms | 59 ms | 71.5% |
| `./sdk/runtime` | 251 ms | 289 ms | 210 ms | -1.4% |
| `./sdk/testing` | 241 ms | 307 ms | 200 ms | 3.4% |

The aggregate `@unbrained/pm-cli/sdk` remains supported for compatibility.
New packages should import the narrowest subpath that owns their capability.
The committed budget file is an upper-bound ratchet and must not be weakened to
hide a regression.
