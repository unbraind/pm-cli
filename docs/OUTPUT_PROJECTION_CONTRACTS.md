# Output Projection and Omission Contracts

Tracker references: [pm-p258tx](../.agents/pm/features/pm-p258tx.toon),
[pm-cyrfjq](../.agents/pm/issues/pm-cyrfjq.toon), and
[pm-qhnq6t](../.agents/pm/issues/pm-qhnq6t.toon). The universal row and
intent-budget contracts are tracked by
[pm-sb0tns](../.agents/pm/issues/pm-sb0tns.toon),
[pm-cxr0jb](../.agents/pm/features/pm-cxr0jb.toon), and
[pm-5t33or](../.agents/pm/features/pm-5t33or.toon). Reachable budgets and
cursor-chain amortization are tracked by
[pm-7hbfch](../.agents/pm/issues/pm-7hbfch.toon),
[pm-yekkvt](../.agents/pm/issues/pm-yekkvt.toon), and
[pm-sf31yl](../.agents/pm/issues/pm-sf31yl.toon). Trustworthy collection
selectors are tracked by
[pm-x710qm](../.agents/pm/issues/pm-x710qm.toon).

## Agent Quick Context

Bounded reads must say what they withheld. Machine consumers should inspect
`omission_receipt` before treating an absent field as absent project context:

```json
{
  "omission_receipt": {
    "has_omissions": true,
    "omitted_field_group_count": 1,
    "omitted_field_groups": [{ "name": "provenance", "restore_with": "--full" }]
  }
}
```

The receipt is constant-sized per command. It does not grow with item count,
history length, or workspace size. A complete projection still emits an
explicit receipt with `has_omissions: false`,
`omitted_field_group_count: 0`, and an empty `omitted_field_groups` list.

## Mode-Paired Collections

Mutually exclusive output modes emit only their active row collection:

| Command mode                | Active row key     | Withheld group | Restore          |
| --------------------------- | ------------------ | -------------- | ---------------- |
| `activity --compact`        | `compact_activity` | `provenance`   | `--full`         |
| `activity --full`           | `activity`         | none           | already complete |
| `history` (compact default) | `compact_history`  | `raw_history`  | `--full`         |
| `history --full`            | `history`          | none           | already complete |

Inactive row keys are omitted, not zero-filled. This makes a wrong parser loud:
reading `.activity` from compact activity now yields a missing key instead of a
plausible empty result that contradicts `count`.

SDK authors can reuse `createOutputOmissionReceipt`,
`resolveModePairedOutputOmissionReceipt`, and
`PM_MODE_PAIRED_OUTPUT_PROJECTION_CONTRACTS` from
`@unbrained/pm-cli/sdk`. The CLI uses the same declarations, so package
integrations and built-in output cannot drift independently.

## Universal Read Rows

Core read results expose a `row_contract` whether or not the current page has
rows:

```json
{
  "row_contract": {
    "command": "list",
    "row_kind": "collection",
    "row_keys": ["items"],
    "fields": "supported",
    "jq_selector": ".row_contract.row_keys[] as $key | getpath($key | split(\".\")) | if type == \"array\" then .[] else if type == \"object\" then to_entries[] else empty end end"
  }
}
```

The selector is identical for list aliases, context, next, search,
activity, history, graph, health, aggregate, duplicates, and stats. Commands
with several collections declare every active dot-delimited path. This keeps
nested dependency graph and relationship-context rows addressable as
`graph.nodes`, `graph.edges`, `context.nodes`, and `context.edges` without
duplicating them at the envelope root. Array collections produce their
elements; object maps such as stats counts produce jq `to_entries` rows.
Commands without a row collection, including a dependency tree or leaf `get`,
declare `row_kind: "none"`, an empty `row_keys` array, and omit `jq_selector`.
The absence is therefore distinguishable from a legitimate empty collection.
`fields` is always explicit, so an agent can distinguish a supported
`--fields` projection from a command that intentionally owns a fixed row
shape. NDJSON event streams do not carry an envelope and therefore do not
publish a row contract.

SDK and package authors can import `PM_READ_ROW_CONTRACTS`,
`PM_READ_ROW_JQ_SELECTOR`, and `resolveReadRowContract` from
`@unbrained/pm-cli/sdk`. Existing package declarations are preserved only
when `command`, `row_kind`, `row_keys`, `fields`, and the conditional
`jq_selector` form a structurally valid row contract; malformed declarations
are replaced by the canonical built-in contract when one applies.

## Self-Describing SDK Projections

Built-ins and extensions can declare bounded shapes directly on their result:

```ts
const result = {
  projection: {
    mode: "summary",
    declared_field_groups: [
      { name: "evidence_rows", restore_with: "--full" },
      { name: "risk_rows", restore_with: "--include risk" },
    ],
    included_field_groups: ["risk_rows"],
  },
};
```

`attachOutputOmissionReceipt` validates this declaration and derives the same
constant-sized receipt used by built-in commands. Invalid or incomplete
declarations are ignored rather than producing an untruthful restore
instruction. Package authors therefore own the names and restoration controls
for their domain without adding package-specific logic to the CLI renderer.

The following bounded built-ins now use this shared declaration:

| Command mode        | Withheld group                                           | Restore  |
| ------------------- | -------------------------------------------------------- | -------- |
| `deps --summary`    | selected dependency tree, graph, or relationship context | `--full` |
| `graph --summary`   | `result_rows`                                            | `--full` |
| `validate --counts` | `diagnostic_rows`                                        | `--full` |

Passing `--full` with the corresponding compact flag is a usage error. An
explicit full request and the default full request produce the same payload
shape; the flag exists as a machine-actionable restore instruction.

`graph impact` is bounded to ten rows by default, returns `next_cursor` when
more affected nodes exist, and accepts `--after <cursor>` to resume in stable
breadth-first order. `graph impact --full` is the explicit unbounded override;
combining `--full` with `--limit` is rejected. A zero-row page remains
resumable: when `--limit 0` truncates reachable work, its cursor represents the
root boundary so a later positive-limit request can retrieve the first row.
Impact cursors bind the root and traversal semantics, not the page size, so a
caller may deliberately raise or lower `--limit` when resuming.

For `get`, each independently selectable group uses its composable field
selector as the restore instruction: `--fields children`,
`--fields claim_state`, or `--fields linked`. Combine them in one selector
when several groups are needed. This remains truthful for leaf items because
an explicit children projection returns an empty rollup instead of silently
conflating “no children” with “children were not requested.”

## Intent Budgets

Built-in read intents apply valid command-specific defaults and disclose the
resolved contract in `context_intent`:

```json
{
  "context_intent": {
    "command": "list",
    "intent": "triage",
    "token_budget": 3200,
    "estimated_tokens": 1416,
    "within_budget": true,
    "degradation": "bounded_fields_and_rows",
    "declaration_feasible": true,
    "result_omitted": false
  }
}
```

Use `context --for orient|handoff`, `get --for inspect`,
`list --for triage`, `next --for execute`, or
`search --for discover`. Explicit caller projection options win over intent
defaults, while the intent ceiling still applies. Selecting an intent is an
explicit request for its bounded shape: `get --for inspect` defaults to
standard depth. List and search derive their default page size from the
effective token ceiling and a conservative per-row cost, so raising
`--token-budget` increases useful rows instead of paying the same fixed envelope
cost for every page. Context applies the same principle to its focus and
activity limits so the built-in orientation declaration remains feasible on a
large tracker. All five intent commands accept the same
`--token-budget` override. Explicit `--depth` and `--limit` controls still win.

If a selected result exceeds its budget, long explanatory strings compact
first, followed by deterministic root-row reduction that retains at least one
useful row and reports `budget_row_compaction`. Only a result whose minimum
useful projection cannot fit becomes `budget_receipt_only`. That receipt sets
`declaration_feasible: false`, `result_omitted: true`, and
`within_budget: false`; fitting the refusal envelope does not make the omitted
result truthful. Recovery recommends increasing the ceiling or narrowing the
request and never sends an agent to a potentially larger unprojected retry.
Explicit overrides below 256 tokens are rejected because the minimum
machine-readable receipt cannot fit; malformed or absent overrides retain the
declared intent budget.

The first cursor page carries the complete projection, filtering, sorting,
completeness, row, and omission contracts. Continuation pages replace those
chain-invariant blocks with `continuation_contract`, which carries the cursor's
query fingerprint and a compact restore instruction. Continuations retain only
the rows and next cursor needed to advance the chain; page counts, total,
truncation, timestamps, and the full intent receipt are referenced from the
first page instead of being re-emitted. Calls
without `--for` remain byte-compatible with the ordinary projection path apart
from the universal row contract.

The mandatory calibration gate generates both a two-item workspace and a
2,243-item current-scale workspace. It validates all five intents, removes one
receipt as an enforcement negative control, traverses every list and search
cursor without duplicates or omissions, and reconstructs repeated first-page
metadata as a continuation negative control. The checked-in report is
[`scripts/release/context-intent-calibration.json`](../scripts/release/context-intent-calibration.json).

| Intent | 2-item tokens / budget | 2,243-item tokens / budget | Current-scale rows | Degradation |
| ------ | ---------------------- | -------------------------- | ------------------ | ----------- |
| `context:orient` | 707 / 2,400 | 1,000 / 2,400 | 3 | bounded sections |
| `get:inspect` | 401 / 3,200 | 415 / 3,200 | item envelope | standard item |
| `list:triage` | 393 / 3,200 | 3,181 / 3,200 | 70 | budget-derived rows |
| `next:execute` | 395 / 1,200 | 1,171 / 1,200 | 14 | budget-derived rows |
| `search:discover` | 301 / 1,800 | 1,763 / 1,800 | 28 | budget-derived rows |

Whole-answer cursor cost is measured against the unprojected single call for
the identical ordered row set:

| Family | Rows | Pages | Optimized bytes/row | Optimized walk | Repeated-metadata control | Unbounded call | Walk / unbounded |
| ------ | ---- | ----- | ------------------- | -------------- | ------------------------- | -------------- | ---------------- |
| `list:triage` | 1,998 | 30 | 172.29 | 344,234 B | 379,875 B | 1,558,741 B | 0.2208 |
| `search:discover` | 1,998 | 64 | 201.24 | 402,075 B | 454,869 B | 1,681,847 B | 0.2391 |

These are corpus-generated figures, not live tracker payloads. The generated
corpus contains 2,243 items; the `status:all` query intentionally excludes 245
canceled fixtures under the command's current status-selection contract.

`health --check-only` defaults to a summary verdict: all checks still run, but
passing check evidence bodies are empty. Use `health --check-only --full` when
diagnostic evidence is required. Explicit `--brief` or `--summary` retains the
existing fast check-only mode that skips expensive optional scans.

## Completion Resolver Contract

`resolveCompletionTimestamp` accepts legacy metadata where all timestamp fields
are optional. Its return is discriminated:

```ts
const completion = resolveCompletionTimestamp(item);
if (completion.resolved) {
  console.log(completion.timestamp, completion.source);
} else {
  console.log("No evidence-backed completion timestamp");
}
```

The resolved branch always carries `timestamp`, `source`, and `fallback`. The
unresolved branch carries none of them, so TypeScript callers cannot
accidentally attribute missing evidence to `updated_at`.

## Compatibility

This is an intentional machine-output correction. Consumers that probed an
inactive collection and received `[]` must branch on `projection.mode` or read
the active `row_contract.row_keys`. Consumers that already used the populated
key continue to receive the same rows.

Dependency token accounting includes the projection declaration and derived
receipt. Reported `usedTokens` and truncation estimates therefore describe the
final serialized result, not a pre-receipt intermediate.
