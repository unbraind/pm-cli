# Planning measurements

Tracked by [pm-6olc95](../.agents/pm/issues/pm-6olc95.toon),
[pm-398z0u](../.agents/pm/issues/pm-398z0u.toon), and
[pm-d2wfig](../.agents/pm/features/pm-d2wfig.toon). Distribution work is tracked
by [pm-fx0rcb](../.agents/pm/tasks/pm-fx0rcb.toon).

These SDK primitives make three planning questions reproducible: which recorded
populations have relationship context, how many items belong to each category,
and whether estimated prerequisite work fits an authored deadline. The CLI and
MCP use the same SDK implementations.

## Relationship coverage across lifecycle states

```bash
pm graph audit --summary
pm graph audit --save-baseline --summary
```

`--summary` retains recorded population totals, acyclicity, and lifecycle
connectivity counts. Use `--full` for degree histograms, status/type distributions,
edge-kind shares, and reachability detail. Baselines always persist the full census.
The summary omission receipt declares `--full` as the recovery path.

`profile.coverage_by_lifecycle` reports `all`, `active`, and `terminal` populations.
`profile.coverage_by_status` reports the actual schema statuses, including
`closed`, `canceled`, and custom terminal states. Every population reports:

- `nodes`: recorded items, excluding missing and external placeholders.
- `isolated` and `degree_leq_one`: items with zero or at most one incident edge.
- `semantic_nodes` and `without_semantic_edges`: presence or absence of incident
  provenance or verification edges, using the audit's semantic-kind definition.
- `degree_histogram`: exact incident directed-edge counts and their populations.

The existing active-only counters and type profiles retain their meanings.
Population measurements include policy-exempt isolates; exemptions affect
findings, not census denominators. Incident edges use the assembled graph's
normalized, deduplicated directed basis. Reciprocal spellings can still be
reported separately by duplicate-edge findings.

`ordering_acyclic` states whether the complete ordering graph is acyclic.
`active_ordering_acyclic` states whether any detected ordering cycle touches
active or unknown-lifecycle work. A historical cycle remains a structural cycle
even when the historical-debt policy gives its finding informational severity.
Missing-reference findings retain their separate active and terminal populations.

After a saved baseline, signed lifecycle and status deltas measure backfill
progress. An older baseline that never measured these populations reports
`lifecycle_comparable: false`; it does not imply that the historical population
was empty. Save a new baseline to begin comparable measurements. Malformed new
census fields invalidate a persisted baseline rather than producing misleading
comparisons. Rebuildable query-cache entries from the older format are discarded.

## Group membership and bounded aggregation

```bash
pm aggregate --group-by tags --limit 20
pm aggregate --group-by tags,type --sum estimated_minutes --completion
pm aggregate --group-by tags --set-mode tuple
```

Set-valued dimensions group by distinct normalized members by default. An item
with `alpha` and `beta` contributes once to each group, even if a member appears
more than once or differs only in case or surrounding whitespace. The same
expansion rule applies to every array-valued grouping dimension; scalar dimensions
compose with those memberships. Empty sets retain a `null` group displayed as
`(untagged)` for tags.

`--set-mode tuple` selects the previous behavior: the complete normalized set is
one comma-joined key. This is useful when comparing exact category combinations.
It is a distinct operation, and `filters.set_mode` records the interpretation.

Counts, completion rates, sums, and averages are computed independently in each
membership group. Consequently, summing group counts or numeric sums can count
one item more than once. `totals.items_grouped` counts distinct input items;
`totals.group_memberships` counts all group contributions.

Aggregation reads the complete matching item population before paging groups.
An unreadable input fails the strict read rather than becoming a partial count.
The default page contains at most 50 groups. `count` is the total group count,
`returned_count` is the page size, and `truncated` indicates further groups.
Pass the returned `next_after` value as `--after` to continue. Keep the grouping
and filters unchanged between pages. A cursor absent from the current result is
rejected with restart guidance; pages are not an immutable snapshot of a tracker
that is being concurrently edited.

## Derived deadline constraints

```bash
pm graph slack --limit 10
pm graph slack --summary
```

The existing unit-weighted `rows`, `makespan`, and hop-based `slack` remain intact.
The additional `deadline_schedule` uses `estimated_minutes` and authored
`deadline` finish constraints. Its `basis` is `derived_elapsed_minutes`, and
`as_of` records the clock used. This computation writes no item fields.

A forward pass computes earliest estimated starts from the invocation clock. A
backward pass transfers each dated finish constraint through the ordering graph,
retaining the tightest successor constraint. A derived row identifies the
controlling `deadline_id`, its `latest_start`, and `slack_minutes` relative to the
earliest possible start. Negative slack indicates a time shortfall; this can
coexist with positive hop-based slack.

`overcommitted` findings name the authored deadline, the shortfall in minutes,
and a bounded controlling prerequisite path. `path_truncated` identifies a path
whose leading steps were omitted; the retained suffix still ends at the dated
item. Moving the authored deadline later recomputes the finding.

Missing, negative, or nonfinite estimates are explicit `unknown_estimate`
residuals. Unknown predecessor duration produces `unknown_predecessor_estimate`
and `null` temporal slack, never zero-cost feasibility. Cycles and work gated by
cycles report `cycle_or_gated_by_cycle`. Invalid dates and dates outside the
representable range are also residuals. `complete: false` means feasibility
cannot be established for the entire input graph; counts remain separate from
bounded samples.

Estimates represent elapsed duration with independent work allowed in parallel.
There is no staffing, resource-contention, working-hours, holiday, or progress
model. The workspace adapter schedules active work and reports `population: active`;
completed work no longer consumes future duration or contributes overdue deadlines.
The pure SDK function schedules the supplied graph, so callers can select other
populations explicitly. ISO
date-only deadlines denote UTC midnight. Undated components have no latest-start
constraint. Topology cache hits do not reuse time-sensitive deadline results;
they are derived from the current metadata on every invocation.

The pure derivation defaults to a work bound of 100,000 input items plus graph
nodes and edges, checked before graph passes. Larger inputs return
`work_limit_exceeded: true` and `complete: false` with no manufactured schedule.
Rows, residual samples, findings, and path identifiers obey the supplied `limit`.
The workspace CLI still pays its existing metadata-read and graph-assembly cost;
the derivation bound is not a claim that loading a million-item workspace is free.
Summary mode suppresses the evidence arrays and retains their counts.

## Public SDK

```ts
import {
  assembleWorkspaceRelationshipGraph,
  auditWorkspaceRelationshipGraph,
  deriveRelationshipDeadlines,
} from "@unbrained/pm-cli/sdk/graph";
import { runAggregate } from "@unbrained/pm-cli/sdk/query";

const items = [
  { id: "work", title: "Prepare", status: "open", estimated_minutes: 60 },
  {
    id: "milestone", title: "Deliver", status: "open", blocked_by: "work",
    estimated_minutes: 30, deadline: "2026-10-01T12:00:00Z",
  },
];
const assembly = assembleWorkspaceRelationshipGraph(items);
const coverage = auditWorkspaceRelationshipGraph(assembly).profile;
const schedule = deriveRelationshipDeadlines(assembly.graph, items, {
  now: "2026-10-01T10:00:00Z",
  maxWork: 100_000,
  limit: 20,
});
const categories = await runAggregate(
  { groupBy: "tags", setMode: "element", limit: 20 },
  { path: "/path/to/project/.agents/pm" },
);
```

The derivation accepts an `AbortSignal`. Relationship orientation comes from the
supplied graph registry, so custom ordering kinds and inverse spellings use the
same execution semantics. MCP `pm_run` with `action: "aggregate"` accepts
`options.setMode`, `options.limit`, and `options.after`. MCP `pm_graph` with
`subcommand: "slack"` returns the same deadline evidence.

## Distribution

Build finalization compacts whitespace in retained runtime JavaScript modules.
It preserves module paths and identifiers, keeps public declaration documentation,
and composes source maps back to the original TypeScript for release symbolication.
Existing bundled outputs remain unchanged by this pass. Source maps remain local
release artifacts and are excluded from the npm packlist. Artifact size and file
count ceilings are checked against the actual npm pack projection.
