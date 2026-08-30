# Defect Recurrence and Boundary Evidence

Tracked by [pm-1qkivy](../.agents/pm/features/pm-1qkivy.toon), [pm-rtn5h6](../.agents/pm/tasks/pm-rtn5h6.toon), [pm-0pzgit](../.agents/pm/tasks/pm-0pzgit.toon), and [pm-h8tpeh](../.agents/pm/features/pm-h8tpeh.toon).

## Agent Quick Context

`pm` treats project management as context management. A resolved defect is therefore not only a closed item: it is durable context that should select the checks most likely to prevent the same failure from recurring.

The public SDK now provides three composable contracts:

- a captured-boundary registry that rejects self-generated fixtures, unsafe samples, missing samples, and expired waivers;
- a defect-evidence ratchet that requires a typed escape class plus a gate improvement or reviewed, expiring waiver on new terminal defects;
- a versioned recurrence index that maps proposed files, packages, PM items, tags, and error codes to shared local and hosted checks.

The CLI and MCP use the same SDK action path. Repository policy can be replaced by a package or workspace policy without changing the analyzer.

## Public SDK

Import the governance surface from the package root or the narrow governance entrypoint:

```ts
import {
  analyzeDefectChangeRisk,
  buildDefectRecurrenceIndex,
  evaluateBoundaryFixtures,
  evaluateDefectGateEvidence,
  parseDefectRecurrencePolicy,
  type DefectChangeRiskInput,
  type DefectRecurrencePolicy,
} from "@unbrained/pm-cli/sdk/governance";

const policy: DefectRecurrencePolicy =
  parseDefectRecurrencePolicy(serializedPolicy);
const index = buildDefectRecurrenceIndex(policy, pmItems, {
  previous_index: previousIndex,
  changed_item_ids: changedItemIds,
});
const change: DefectChangeRiskInput = {
  files: ["src/sdk/governance/assurance-action.ts"],
  item_ids: ["pm-1qkivy"],
};
const report = analyzeDefectChangeRisk(index, change, { limit: 25 });
```

The index and report are deterministic. `policy_fingerprint` identifies the versioned policy; `index_fingerprint` also covers the sparse PM item-to-family contributions. Continuation cursors bind to the latter, so a cursor cannot silently continue against changed context.

Each report explains its exact matching signals, returns deduplicated local and hosted checks, and includes a small cost receipt. Package authors may keep their own recurrence policy and feed the same SDK from a custom command, extension, CI adapter, or application.

## CLI and MCP Action

`assurance risk` accepts one JSON request through the same `definition` transport already used by SDK and MCP hosts:

```bash
risk_request=$(jq -cn \
  --slurpfile policy config/defect-recurrence-policy.json \
  '{policy:$policy[0],change:{files:["src/sdk/governance/assurance-action.ts"],item_ids:["pm-1qkivy"]},limit:25}')
pm assurance risk --definition "$risk_request" --json
```

The result uses `items` as its bounded row collection and publishes `.items[]` as the stable selector. When `next_cursor` is present, submit it in the next request. A stale or malformed cursor fails rather than restarting from an ambiguous offset.

Use `pm assurance risk` for an operator or agent decision. Use the pure SDK functions when a package already owns the item projection, wants to preserve an incremental index, or needs to combine risk with another domain model.

### TypeScript compatibility

The exported `ASSURANCE_ACTIONS` tuple and `AssuranceActionResult` union now include `risk` and `DefectChangeRiskReport`. This is additive at runtime, but TypeScript consumers with an exhaustive action or result switch must add the new branch. The SDK surface snapshot records that source-compatibility change explicitly.

## Policy Model

The repository example is [config/defect-recurrence-policy.json](../config/defect-recurrence-policy.json). Every family declares:

- a stable id, monotonic version, title, and accountable PM item;
- one of `production_defect`, `nightly_regression`, `scanner_finding`, or `review_caught_late`;
- file, package, item, tag, or error-code triggers;
- local and hosted checks selected from the same policy;
- a negative-control change that must select the family;
- historical PM items that justify the family;
- maximum escape-rate and false-positive-rate budgets.

Repository policy validation rejects duplicate ids, absent historical examples, missing family negative controls, invalid taxonomy values, and budgets outside zero through one. Deterministic sorting makes the serialized policy merge-friendly.

Register a family whenever a defect is recorded as a recurrence of an earlier one, meaning the new item carries a `recurs_from` edge to its predecessor. A recurrence with no family produces no local and no hosted protection, so the next instance is rediscovered by hand. Coverage of recorded recurrence lineages is not yet computed by any gate; that gap is tracked on [pm-7c27ep](../.agents/pm/issues/pm-7c27ep.toon).

## Defect Evidence on PM Items

Projects can register the structured fields without changing the SDK:

```bash
pm schema add-field escape_class \
  --type string \
  --commands create,update,list,search,context \
  --description "Defect escape taxonomy"
pm schema add-field gate_evidence \
  --type object \
  --commands create,update,list,search,context \
  --description "Gate improvement or explicit waiver evidence"
```

`gate_evidence` accepts one of these dispositions:

- `gate_added` and `gate_strengthened` require `gate_id`, a runnable `negative_control`, non-empty `local_checks` and `hosted_checks`, and an accountable `owner`;
- `explicit_waiver` requires an accountable `owner`, a concrete `waiver_reason`, and a future `waiver_expires_at` timestamp.

The evidence epoch lets an adopting project ratchet new closures immediately while backfilling historical items deliberately. A valid `completed_at` is authoritative, `closed_at` is the compatibility fallback, and timestamp-less items created after the epoch fail closed; timestamp-less items created before the epoch remain explicitly grandfathered. Reports keep historical escape-class and disposition counts visible even before those older items become closure blockers.

## Captured Boundary Fixtures

The repository inventory is [config/boundary-fixtures.json](../config/boundary-fixtures.json). Each externally produced or consumed value must carry either:

- a committed JSON sample with `capture_source` set to `captured_redacted` or `captured_verbatim`, capture provenance, explicit redactions, input, and observed output; or
- an explicit reason, owner, and future expiry for a boundary that cannot yet be captured safely.

The evaluator rejects a `self_generated` source because a fixture created by the same implementation cannot reveal disagreement with an external format. It also scans committed JSON for common home-directory, package-token, GitHub-token, and private-key patterns.

The Claude Code directory-slug fixture is consumed directly by the author-provenance test. The npm, GitHub Actions, Git commit, and Sentry samples preserve real field shapes while replacing identifiers, paths, URLs, and user data.

## Repository Gate

Run the complete local gate after building:

```bash
pnpm quality:defect-evidence
node scripts/release/defect-evidence-gate.mjs --negative-control --json
```

The first command must pass. The negative control must exit `1` after replacing a captured sample with a forbidden source and adding a terminal defect without evidence. Focused provider modes are available as `--boundary-only`, `--evidence-only`, and `--policy-only`.

`repository-defect-evidence-required` is part of the blocking `repository-static-quality` assurance composition. That makes local and CI behavior share the same provider result, assertion negative control, enforcement, and immutable verdict semantics.

## Recovery Producer Census

`censusPmRecoveryReferenceProducers` scans complete source files for static object-literal recovery fields. It ignores type literals, destructuring patterns, labels, comments, strings, templates, and regular expressions. Aliases such as `candidate_commands`, nested `fallback_candidates[].command`, `next_best_command`, `retry_command`, and `suggested_next_steps` normalize to the same six public recovery kinds used by executable reachability verification.

The census fails when a kind has no producer or when a recovery-like envelope field lacks a typed contract. The integration gate scans every `src/**/*.ts` producer; the existing real-entrypoint corpus then executes or resolves every normalized kind and proves recovery, replacement, or behavior-preserving semantics.

This separation is intentional: the producer census prevents silent omissions as source grows, while entrypoint execution proves that a reference is not merely syntactically present.
