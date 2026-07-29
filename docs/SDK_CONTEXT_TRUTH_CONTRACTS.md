# SDK Context Truth Contracts

Tracker references: [pm-23xkss](../.agents/pm/issues/pm-23xkss.toon) and
[pm-r8u2g6](../.agents/pm/issues/pm-r8u2g6.toon).

## Agent Quick Context

An empty tracker, a missing tracker, and an invalid tracker path are different
states. Likewise, an optional local Git optimization and a drifted installed
configuration are different health findings. The SDK preserves these
distinctions so automation does not infer project truth from an ambiguous empty
array or a generic failed verdict.

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

Consumers should branch on the stable diagnostic code:

```ts
try {
  const items = await listAllItemMetadata(pmRoot);
  // [] now proves that the supplied directory exists and contains no items.
} catch (error) {
  if (error instanceof PmCliError && error.code === "tracker_root_missing") {
    // Ask the caller to select or initialize a tracker.
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
