# Declarative workflow policies

Tracker: [pm-mj42og](../.agents/pm/features/pm-mj42og.toon) and [pm-htbetn](../.agents/pm/features/pm-htbetn.toon).

Projects can describe their lifecycle requirements as versioned data. The SDK
uses the same evaluator for item mutations, policy previews, and completeness
reports. Existing projects have no implicit policies. A declaration can advise,
warn, or refuse; refusal also requires an explicit workspace opt-in.

## Configure a requirement

```bash
pm schema policy-put close-evidence --definition '{"id":"close-evidence","effect":"refuse","subject":{"statuses":["closed"]},"rule":{"kind":"require_fields","fields":["resolution","actual_result"]}}'
pm schema policies
pm schema policy-check pm-example --definition '{"status":"closed"}'
pm schema policy-mode refuse
```

Use canonical status ids and metadata field names. `body` selects the Markdown
body. Custom fields can use dotted paths with at most eight segments. Empty
strings, arrays, objects, null, and absent values do not satisfy required fields;
zero and false are meaningful values.

`policy-put` replaces a declaration with the same id. `policy-remove <id>` removes
one declaration. `policy-mode advise` disables refusal while retaining diagnostics.
Registry writes are locked and recorded in workspace history. `--dry-run` previews
registry changes without writing. Malformed registries fail closed.

## Selectors and rules

All selectors in `subject` must match; values within one selector are alternatives.
Supported selectors are `types` (case insensitive), `tags`, `statuses`, `operations`,
`parents`, and `dependency: { "kind": "implements", "id": "pm-example" }` (id optional).
Parent and dependency selectors inspect direct relationships. Status selectors
match the destination; other selectors inspect both snapshots so a mutation cannot
escape a protected scope by removing its tag or changing its type.

| Rule kind | Required properties | Behavior |
| --- | --- | --- |
| `require_fields` | `fields` | Checks evidence on lifecycle, scope, or required-field changes |
| `transition` | `allowed` | Allows listed `[from, to]` status pairs; `$create` and `$delete` represent absent records |
| `authors` | `authors` | Requires a listed mutation actor |
| `field_writers` | `fields`, `authors` | Requires a listed actor when protected fields change |
| `approval` | `fields`, `authors` | Requires independent approval when an existing item changes status or is deleted |

Operation selectors use exact history operation names. Unknown declaration keys
are errors. Policies contain no executable expressions or regular expressions.
At most 256 declarations and 64 terms per selector/rule are accepted. Registry
reads are bounded to 1 MiB, and approval-history reads to 4 MiB.

Actor names are provenance supplied by the caller or local configuration. They
are not authenticated identities, and these rules are not an access-control
boundary against a caller who can edit the tracker or choose an author name.
Authenticated, signed identity ([pm-u14c](../.agents/pm/stories/pm-u14c.toon))
is a prerequisite for stronger authorization guarantees.

## Approvals

Prepare the declared fields, then have a different workflow actor record approval:

```bash
pm schema policy-put review --definition '{"id":"review","effect":"refuse","subject":{"statuses":["closed"]},"rule":{"kind":"approval","fields":["body","resolution"],"authors":["reviewer"]}}'
pm schema policy-approve pm-example --policy review --author reviewer --message 'Reviewed acceptance evidence'
```

Approval events bind the item id, selected field values, and complete policy
revision. Changing reviewed content or the declaration invalidates the approval.
Unrelated metadata changes do not. The actor performing the transition must differ
from the approval actor. Only sealed approval events from a verified item history
chain count. `policy-check` previews transitions; `policy-approve` always records
an event and rejects `--dry-run`.

Approval rules apply to existing items. Creation and initial imports have no
reviewable history and skip approval requirements; use `transition` rules with
`["$create", "open"]` to constrain their initial status. Deletion requires approval
of the current record, using the same content and independent-actor checks.

Refused mutations preserve item state and item history, and append a workspace
refusal event. Accepted mutations attach bounded policy decisions to their normal
history event. Diagnostics contain policy ids and missing field paths, without
copying reviewed content into errors.
If the mandatory refusal audit cannot be appended, the mutation instead raises
`workflow_policy_audit_failed` and preserves the original failure in the SDK
error's `cause`. Item data remains unchanged; resolve the workspace history lock
or storage failure before retrying. Package imports do not downgrade this error
to an item-lock warning.

## Completeness reports and SDK

```bash
pm schema policy-presets
pm validate --check-completeness --strict-exit
```

Presets return optional advisory declarations for familiar item types. They do
not install policies. Author the declarations appropriate to the project's own
types and lifecycle using `policy-put`. Completeness reports group counts by type,
return bounded violation examples, and use only `require_fields` declarations.
Default validation includes this check; projects without declarations remain
unaffected.

The published `@unbrained/pm-cli/sdk/governance` entrypoint exports
`runWorkflowPolicyAction`, `evaluateWorkflowPolicies`, policy types, parsers,
`WORKFLOW_POLICY_SCHEMA`, and `WORKFLOW_POLICY_DOCUMENT_SCHEMA`. `PmClient` exposes
`workflowPolicy(action, name, options)`. CLI `schema` and MCP `pm_schema` use the
same action vocabulary and SDK implementation; MCP options accept camelCase
keys and structured JSON definitions.

For repeated pure evaluation, `createWorkflowPolicyEvaluator(document)` returns
an evaluator that owns a private normalized policy snapshot and hashes each
declaration once. Later edits to the supplied document do not change that
snapshot; create another evaluator to adopt them. Completeness validation uses
one such snapshot for the whole supplied corpus.

The schema contract version is 4.16. Existing schema operations remain available;
`SchemaResult` now also includes `WorkflowPolicyActionResult`. Consumers that
exhaustively narrow schema results should handle the `policy_result: true`
discriminant. Validation options include `checkCompleteness`, and validation
results can contain a `completeness` check.
