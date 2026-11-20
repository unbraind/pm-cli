# History read costs

Tracked by
[pm-gh1664](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-gh1664.toon)
(repository-only; PM records are excluded from the npm package).

`pm context --for orient --limit 3 --json` on a generated fixture with 2001 history
streams and 216.0 MiB of history
(100 archive entries per stream, each stream
ending at a distinct time), measured on Node v26.13.1
linux/x64. Each sample is a fresh CLI process.

| Path | runs | best | p50 | max |
|---|---:|---:|---:|---:|
| Bounded (trusted stream bounds) | 5 | 1027 ms | 1140 ms | 1478 ms |
| Full scan (summary removed before each sample) | 3 | 3332 ms | 3578 ms | 3902 ms |

The ceiling is a ratchet: `--update` keeps the committed ceiling when a
measurement would raise it, unless `--allow-increase <reviewed reason>` is
given.

The gate (`node scripts/bench/history-read-costs.mjs --check`, part of
`pnpm quality:static`) fails when the bounded p50 exceeds
0.6 of the same runner's
full-scan p50. On a runner whose bare-Node control is within its budget and
whose full scan exceeds the declared 2280 ms
ceiling plus a 100 ms noise margin, it also fails when
the bounded p50 exceeds that enforced ceiling. Where the full scan does not
exceed it, the absolute check could not detect a regression, so it is
reported as unverified and the fraction gate decides; `--update` refuses a
ceiling its own measurement cannot prove. The first read of a fresh fixture also builds the history event
index and is excluded from both samples.
