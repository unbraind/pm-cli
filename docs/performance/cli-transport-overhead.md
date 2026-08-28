# CLI transport overhead

Tracked by [pm-yse5dt](../../.agents/pm/tasks/pm-yse5dt.toon), with RSS
admission reliability owned by
[pm-pz49xc](../../.agents/pm/issues/pm-pz49xc.toon).

Each result starts from a fresh isolated workspace containing exactly one item.
The command runs in a fresh Node v26.5.0 process on
linux/x64; setup and fixture generation are
outside the timed interval. Short local gates use the best observed latency,
while the report retains p50 and p95 evidence. RSS admission uses the measured
median so one page-level outlier cannot false-fail the gate; the maximum remains
in the report as diagnostic evidence. Admission adds a fixed 512 KiB noise margin
without changing the committed budget; a majority persistent increase beyond
that bounded margin still fails.

| Command   |   best |    p50 |    p95 |
| --------- | -----: | -----: | -----: |
| `get`     | 269 ms | 316 ms | 388 ms |
| `list`    | 315 ms | 354 ms | 357 ms |
| `context` | 326 ms | 345 ms | 428 ms |
| `next`    | 332 ms | 339 ms | 352 ms |
| `create`  | 298 ms | 317 ms | 326 ms |
| `claim`   | 312 ms | 331 ms | 350 ms |

## Current attribution

- Node process and ESM loader floor is measured independently in the
  [SDK entrypoint table](sdk-entrypoint-import-costs.md).
- Static CLI bootstrap loads the shared error, output, telemetry, extension
  discovery, Commander, and SDK-client kernels before command registration.
- Command registration is already family-selective; only the family owning the
  requested command is loaded, while bare/root help intentionally registers the
  complete discoverable surface.
- Settings/schema reads and extension discovery happen after the module floor
  and remain observable through `--profile`; the one-item fixture keeps their
  data-dependent work negligible.
- Focused SDK entrypoints remove 40-98% of aggregate import overhead for
  governance, graph, merge, query, authoring, contracts, and testing consumers.
  The compatibility aggregate and core client remain intentionally broad.

The committed budget is a ratchet. Existing absolute scale budgets are not
relaxed, and scale reports additionally gate the CLI-minus-SDK delta for every
operation whenever both transports are measured. The generated scale workspace
has no installed extensions and its paired SDK client uses extension-free mode,
so the comparison excludes project package execution. It also leaves author
attribution to the CLI resolver instead of injecting `PM_AUTHOR`.
