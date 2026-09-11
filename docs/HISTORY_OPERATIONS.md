# History operation contracts

Tracked by [pm-0elqjj](../.agents/pm/issues/pm-0elqjj.toon).

History operation names are durable data. The public
`PM_HISTORY_OPERATION_CONTRACT` declares native item operations, workspace
operations, parameterized families, and historical aliases. Inspect it through
`pm contracts --command history --json` or import it from
`@unbrained/pm-cli/sdk/contracts`.

Native write sites are checked against that declaration by the mandatory
`operation-source-contract.spec.ts` test. New literal operation names fail the
gate until their contract is declared. Schema migration families also have a
type-exhaustive test covering their forward and compensation identities. JSON Patch verbs, extension write-hook
labels, remediation-plan verbs, and telemetry span names are different domains;
they do not become history operations merely because they have an `op` field.

`createHistoryEntry` canonicalizes declared aliases before sealing new records.
Both `init:type-preset` and `init:type_preset` write `init:type_preset`.
Existing
records retain their exact operation and hashes. Readers can explicitly call
`resolveHistoryOperation` for comparison; unknown historical operations remain
unchanged so a newer writer does not make an older reader destroy information.
These additive naming contracts do not change the item storage format or hash
epochs.

Custom SDK consumers retain their own operation identities. New packages should
use `extension:<package_name>:<snake_case_operation>`. Legacy custom names remain
accepted when they use lowercase alphanumeric segments separated by underscores,
hyphens, colons, or dots. Workspace retry keys remain opaque colon suffixes,
including schema reference paths. Whitespace and control characters are rejected
before new record construction. The native inventory
gate is stricter than this compatibility grammar: a typo in product code cannot
silently become a custom operation.

`requireHistoryOperation` validates a native identity or a declared parameterized
family. `normalizeHistoryOperationForWrite` applies the compatible SDK writer
grammar. Existing append/rewrite primitives retain their responsibility to
preserve imported and historical records; reading old records does not run a
new-writer naming migration. Custom writers using other spellings must select
grammar-compliant identities for new events; their retained records remain
readable under their original names.
