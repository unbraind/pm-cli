# SDK Context Truth Contracts

Tracker references: [pm-23xkss](../.agents/pm/issues/pm-23xkss.toon) and
[pm-r8u2g6](../.agents/pm/issues/pm-r8u2g6.toon),
[pm-79gv6q](../.agents/pm/issues/pm-79gv6q.toon), and
[pm-08mt4k](../.agents/pm/issues/pm-08mt4k.toon).

## Agent Quick Context

An empty tracker, a missing tracker, an invalid tracker path, and an unreadable
tracker are different states. Likewise, an optional local Git optimization and
a drifted installed configuration are different health findings. The SDK
preserves these distinctions so automation does not infer project truth from an
ambiguous empty array or a generic failed verdict.

## Metadata Root Diagnostics

The public metadata enumerators accept an existing directory, including an
empty directory:

- `listAllItemMetadata`
- `listAllItemMetadataLight`
- `listAllItemMetadataWithBody`

A missing root throws `PmCliError` with exit code `NOT_FOUND`, diagnostic code
`tracker_root_missing`, and context reason `missing`. A regular file or other
non-directory root throws `PmCliError` with exit code `USAGE`, diagnostic code
`tracker_root_not_directory`, and context reason `not_a_directory`.
An existing root that cannot be enumerated throws `PmCliError` with exit code
`GENERIC_FAILURE`, diagnostic code `tracker_root_unreadable`, and context reason
`unreadable`. On POSIX hosts, enumeration requires both read and directory-search
permission: a root whose mode lacks either permission is unreadable, even when a
privileged process could bypass those mode bits.

Consumers should branch on the stable diagnostic code:

```ts
try {
  const items = await listAllItemMetadata(pmRoot);
  // [] now proves that the supplied directory exists and contains no items.
} catch (error) {
  if (error instanceof PmCliError && error.code === "tracker_root_missing") {
    // Ask the caller to select or initialize a tracker.
  }
  if (error instanceof PmCliError && error.code === "tracker_root_unreadable") {
    // Repair tracker permissions before trusting any project context.
  }
}
```

## Merge-Driver Health Policy

`pm health` treats a repository where none of the five clone-local semantic
merge drivers has ever been installed as advisory by default. The integrity
check remains `warn`, reports
`merge_driver_configuration_missing:5`, and records
`details.merge_driver_configuration.required: false`, while the overall
verdict can remain healthy.

Use `pm health --require-merge-drivers` or SDK option
`requireMergeDrivers: true` when the current workflow requires field-aware Git
merges. That policy makes the same finding blocking and records `required:
true`.

Partial configuration and drift of an installed driver remain blocking in both
modes. They report `merge_driver_configuration_drift:<count>` because they can
silently route tracker files through the wrong merge behavior. Run
`pm merge install` in the clone to install or repair the local definitions.

This policy does not weaken storage, history, merge-fence, or pending-receipt
checks. It only distinguishes an optional never-installed clone capability
from a broken capability that the repository appears to rely on.

## Population and Focus Are Separate

`context.summary.scope` is `matching_items`: lifecycle totals describe all items
matching the request filters and parent subtree before the focus limit, intent
projection, and token packing. Without filters this is the workspace population.
`active_items`, `in_progress`, `open`, and `blocked` use that same population as
`total_items`, `closed`, and `canceled`. `open` includes active statuses other than
in-progress; `blocked` is an overlapping classification that includes unresolved
dependency edges as well as blocked lifecycle states.

`summary.returned_focus` reports the bounded focus selection. The existing
`high_level` and `low_level` counts describe their emitted rows. An orient or
handoff response limited to one row can therefore still report hundreds of open
items. `omission_receipt.summary_scope` repeats `matching_items` so a consumer
reading projection metadata cannot confuse omitted detail with absent work.

Never infer a population count from an array length. To visit individual items,
follow the response's continuation and omission receipts. To schedule work, use
the shared [execution contracts](SDK_EXECUTION_CONTRACTS.md), which keep human
input, gates, and containers visible without dispatching them by default.
