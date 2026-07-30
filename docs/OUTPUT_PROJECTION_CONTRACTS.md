# Output Projection and Omission Contracts

Tracker references: [pm-p258tx](../.agents/pm/features/pm-p258tx.toon),
[pm-cyrfjq](../.agents/pm/issues/pm-cyrfjq.toon), and
[pm-qhnq6t](../.agents/pm/issues/pm-qhnq6t.toon). The universal row and
intent-budget contracts are tracked by
[pm-sb0tns](../.agents/pm/issues/pm-sb0tns.toon),
[pm-cxr0jb](../.agents/pm/features/pm-cxr0jb.toon), and
[pm-5t33or](../.agents/pm/features/pm-5t33or.toon).

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
    "row_keys": ["items"],
    "fields": "supported",
    "jq_selector": ".row_contract.row_keys[] as $key | .[$key][]?"
  }
}
```

The selector is identical for list aliases, context, get, next, search,
activity, history, graph, health, aggregate, duplicates, and stats. Commands
with several top-level collections declare every active key. Commands without
a top-level row collection declare an empty `row_keys` array. `fields` is
always explicit, so an agent can distinguish a supported `--fields`
projection from a command that intentionally owns a fixed row shape.

SDK and package authors can import `PM_READ_ROW_CONTRACTS`,
`PM_READ_ROW_JQ_SELECTOR`, and `resolveReadRowContract` from
`@unbrained/pm-cli/sdk`. Existing package declarations are preserved only
when `command`, `row_keys`, `fields`, and `jq_selector` form a structurally
valid row contract; malformed declarations are replaced by the canonical
built-in contract when one applies.

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
    "token_budget": 1800,
    "estimated_tokens": 1416,
    "within_budget": true,
    "degradation": "bounded_fields_and_rows"
  }
}
```

Use `context --for orient|handoff`, `get --for inspect`,
`list --for triage`, `next --for execute`, or
`search --for discover`. Explicit caller projection options win over intent
defaults, while the intent ceiling still applies. Selecting an intent is an
explicit request for its bounded shape: `get --for inspect` defaults to
standard depth, `list --for triage` defaults to two compact rows, and
`search --for discover` defaults to fifteen compact rows. Callers that need a
different depth or page size can pass `--depth` or `--limit`; list and search
retain their ordinary completeness and continuation metadata when bounded.
If a selected result exceeds
its budget, long explanatory strings are compacted deterministically without
dropping rows. If the complete row set still cannot fit, the result is replaced
by a `budget_receipt_only` envelope instead of retaining stale counts or
pagination cursors. The receipt's `token_budget` is the effective ceiling after
any explicit caller override. Explicit overrides below 256 tokens are rejected
because the minimum machine-readable receipt cannot fit; malformed or absent
overrides retain the declared intent budget. A receipt-only response directs
callers to repeat their original invocation without `--for`, avoiding
non-runnable recovery strings for positional commands such as `get` and
`search`. Calls
without `--for` remain byte-compatible with the ordinary projection path apart
from the universal row contract.

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
