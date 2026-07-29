# Output Projection and Omission Contracts

Tracker references: [pm-p258tx](../.agents/pm/features/pm-p258tx.toon),
[pm-cyrfjq](../.agents/pm/issues/pm-cyrfjq.toon), and
[pm-qhnq6t](../.agents/pm/issues/pm-qhnq6t.toon).

## Agent Quick Context

Bounded reads must say what they withheld. Machine consumers should inspect
`omission_receipt` before treating an absent field as absent project context:

```json
{
  "omission_receipt": {
    "has_omissions": true,
    "omitted_field_group_count": 1,
    "omitted_field_groups": [
      { "name": "provenance", "restore_with": "--full" }
    ]
  }
}
```

The receipt is constant-sized per command. It does not grow with item count,
history length, or workspace size. A complete projection still emits an
explicit receipt with `has_omissions: false`,
`omitted_field_group_count: 0`, and an empty `omitted_field_groups` list.

## Mode-Paired Collections

Mutually exclusive output modes emit only their active row collection:

| Command mode | Active row key | Withheld group | Restore |
|---|---|---|---|
| `activity --compact` | `compact_activity` | `provenance` | `--full` |
| `activity --full` | `activity` | none | already complete |
| `history` (compact default) | `compact_history` | `raw_history` | `--full` |
| `history --full` | `history` | none | already complete |

Inactive row keys are omitted, not zero-filled. This makes a wrong parser loud:
reading `.activity` from compact activity now yields a missing key instead of a
plausible empty result that contradicts `count`.

SDK authors can reuse `createOutputOmissionReceipt`,
`resolveModePairedOutputOmissionReceipt`, and
`PM_MODE_PAIRED_OUTPUT_PROJECTION_CONTRACTS` from
`@unbrained/pm-cli/sdk`. The CLI uses the same declarations, so package
integrations and built-in output cannot drift independently.

For `get`, each independently selectable group uses its composable field
selector as the restore instruction: `--fields children`,
`--fields claim_state`, or `--fields linked`. Combine them in one selector
when several groups are needed. This remains truthful for leaf items because
an explicit children projection returns an empty rollup instead of silently
conflating “no children” with “children were not requested.”

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
the active `projection.row_key`. Consumers that already used the populated key
continue to receive the same rows.
