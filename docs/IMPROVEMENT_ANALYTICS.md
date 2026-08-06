# Improvement Ledger and History Analytics

Tracker references: [pm-chahyq](../.agents/pm/features/pm-chahyq.toon), [pm-1wiugq](../.agents/pm/issues/pm-1wiugq.toon), [pm-gw6uyq](../.agents/pm/features/pm-gw6uyq.toon)

`pm` treats project management as context management. Improvement observations and fleet analytics therefore remain attached to authoritative project context: observations are audited workspace state, while provenance and outcome analytics are bounded projections of immutable history.

## Agent Quick Context

- Record quantitative evidence with `pm stats --analytics '{...}'`; do not hand-edit `.agents/pm/improvement-ledger.json`.
- Request ledger and history projections through the single typed `--analytics` JSON object. This keeps the agent-facing command contract bounded while the SDK and MCP retain their fully typed fields.
- Ledger reads are newest-first and bounded; trends still use every matching retained observation.
- Use an explicit metric direction. `lower` is the default; `target` requires a threshold and measures convergence toward it.
- Use `provenanceCoverage` to find declared-but-inert or undeclared provenance dimensions.
- Use `fleetAttribution` for observational comparisons only. It must never authorize, assign, route, rank, or evaluate an individual agent.
- Bound history work with `since`, `eventLimit`, and `minimumSample`.

## Audited improvement observations

```bash
pm stats \
  --analytics "$(jq -cn --arg revision "$(git rev-parse HEAD)" '{
    observe: ["quality.coverage.lines=100,unit=percent,threshold=100"],
    direction: "higher",
    measurementSource: "pnpm coverage",
    measurementItem: "pm-example",
    measurementRevision: $revision,
    measurements: true
  }')" \
  --json
```

Each observation records a content identity, metric, finite value, direction, timestamp, revision provenance, author, and optional unit, threshold, source, and owning item. When no revision is supplied, `pm` uses Git HEAD when available and otherwise records an explicit `unversioned` marker.

Retries are idempotent by revision, metric, source, and owner. Reusing that key with different numeric or metric-contract data fails with a conflict instead of silently rewriting history. A metric keeps one direction, unit, and—when target-directed—target threshold throughout its series.

```bash
pm stats --analytics '{"measurements":true,"metric":"quality.coverage.lines","measurementLimit":20}'
```

The `improvement_ledger` result contains:

- `observations`: a bounded newest-first page;
- `total` and `truncated`: the complete match count and omission state;
- `trends`: baseline, latest, delta, improvement state, and sample count per metric;
- `source: audited_workspace_singleton`: the state provenance receipt.

The singleton is written through the workspace lock and `_workspace` hash-chained audit stream. Compaction may reduce historical patches, but it does not remove current ledger state.

## Provenance coverage

```bash
pm stats --analytics '{"provenanceCoverage":true,"since":"-30d","eventLimit":10000,"minimumSample":5}' --json
```

This projection compares configured harness signal descriptors with observed immutable history. It reports descriptor coverage, observed/unavailable/legacy-missing values, inert dimensions with sufficient explicit samples, undeclared dimensions, and stable warning codes. The live corpus is the positive control; deliberately missing descriptors and unavailable values provide negative controls in tests.

## Fleet attribution

```bash
pm stats --analytics '{"fleetAttribution":true,"since":"-30d","eventLimit":10000,"minimumSample":5}' --json
```

Fleet attribution groups bounded events by harness, model, and author source. Each group reports state and annotation events, terminal transitions, reopens, and issues linked with `discovered_from` to closed work. Rates remain `null` until the close denominator reaches `minimum_sample`.

The result always includes `policy: observational_only_not_for_authorization_or_routing`. Missing dimensions are `unavailable`, small denominators are `insufficient`, and a `window` receipt states the lower bound, consumed event count, truncation, and continuation cursor.

## SDK

```ts
import {
  readImprovementLedger,
  recordImprovementObservation,
  runFleetAttributionAnalytics,
  runProvenanceCoverageAnalytics,
} from "@unbrained/pm-cli/sdk";

await recordImprovementObservation(
  {
    metric: "quality.coverage.lines",
    value: 100,
    direction: "higher",
    unit: "percent",
    revision: process.env.GIT_COMMIT,
  },
  { path: ".agents/pm" },
);

const ledger = await readImprovementLedger({
  pmRoot: ".agents/pm",
  metric: "quality.coverage.lines",
  limit: 20,
});
```

`PmClient.stats()` exposes the combined typed contract. The lower-level functions support packages that need one primitive without constructing a command transport. MCP uses the same action schema; its direction field is named `improvementDirection` to avoid collision with dependency-graph traversal direction. The CLI deliberately folds the new analytics fields into one validated `--analytics` object so its help and contract surface stay within the enforced agent-token budget.

## Safety and interpretation

- Treat observations as evidence, not a universal objective function. Record the producing gate and owning item so context survives.
- Compare like-for-like metric contracts; a changed unit, direction, or target should use a new metric name.
- Do not infer causality from attribution. The projection describes recorded history and relationship links only.
- A truncated window is incomplete evidence. Resume or increase the bound before publishing conclusions.
- Keep credentials, private payloads, host identifiers, and customer data out of metric names, sources, messages, and item links.
