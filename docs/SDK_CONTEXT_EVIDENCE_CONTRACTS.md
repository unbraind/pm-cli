# SDK Context and Evidence Contracts

Tracked by [pm-gok2km](../.agents/pm/issues/pm-gok2km.toon), [pm-zryb9d](../.agents/pm/issues/pm-zryb9d.toon), [pm-qckpnq](../.agents/pm/issues/pm-qckpnq.toon), [pm-hfqju5](../.agents/pm/issues/pm-hfqju5.toon), [pm-2htk4p](../.agents/pm/issues/pm-2htk4p.toon), [pm-v0a0un](../.agents/pm/issues/pm-v0a0un.toon), [pm-7wzb6d](../.agents/pm/issues/pm-7wzb6d.toon), [pm-mg13iz](../.agents/pm/issues/pm-mg13iz.toon), and [pm-cf4t42](../.agents/pm/issues/pm-cf4t42.toon).

These contracts keep SDK context truthful, bounded, and reusable across the CLI, MCP, packages, and automation. They are designed around the project principle that project management is context management: a compact response must reveal material omissions, merge evidence must describe what actually survived, and compatibility failures must not masquerade as corruption.

## Material omission receipts

`pm get` derives omission receipts from non-serialized materiality evidence. Empty bodies and zero-cardinality collections do not consume receipt tokens merely because a richer projection could render them. Material body, linked-artifact, collection, schedule, child, and claim-state groups retain exact `--fields` restoration guidance.

Package authors can use `registerOutputMaterialFieldGroups(result, groups)` before the shared output boundary attaches a receipt. The registration is held in process memory through a `WeakMap`; it never appears in JSON, TOON, item storage, history, or package output.

## Scoped preflight ownership

An extension contribution inventory can declare `preflight_ownership` command sets. Static activation uses those same sets as runtime dispatch:

- a scoped preflight activates only for an owned command;
- disjoint scoped preflights do not collide or activate for `pm health` merely because both advertise the `preflight` capability;
- `preflight_overrides` entries without corresponding ownership remain global.

This keeps health diagnostics and lazy runtime behavior on one ownership contract.

## Merge provenance

Item scalar merges distinguish a caller request from the convergent outcome.
The `latest_document_update` policy selects the branch document with the later
`metadata.updated_at`; equal timestamps use stable value order. Low-level item
results, driver results, receipts, and privacy-safe summaries expose
`requested_preference` plus `requested_preference_applied: false`. Each new
decision records `retained_side` and `resolution_basis`. New receipts do not
emit the ambiguous `preferred` key; readers still ingest legacy schema-v1
receipts and normalize `preferred_side` and `stable_value_order` evidence.

Tracked receipt evidence uses `bounded_non_sensitive_scalars_v1`: built-in
status, priority 0 through 4, risk/confidence/severity ordinals, and `null` may
be included beside their verifiable hashes. Every other value remains
hash-only. Fresh-clone consumers must branch on `value_availability` rather than
assuming raw values exist. Invalid evidence separates `schema_invalid` from
`identity_invalid` and adds a bounded `validation_error`, while retaining the
legacy combined reason in the public union for source compatibility.

`runMergeReconcile` also reports missing history receipt counts before and
after the operation. With explicit `force`, it can append a narrowly matched
audit disposition for a missing reference whose original event predates the
durable-receipt epoch. The item id, original line, receipt id, and timestamp
must all match, and the audit event must occur later in that history stream;
current-era missing evidence remains blocking.

## Claim race classification

Extensions can import `isAlreadyClaimedError` from either supported lifecycle entrypoint:

```ts
import { isAlreadyClaimedError } from "@unbrained/pm-cli/sdk";
// or the compact lifecycle surface
import { isAlreadyClaimedError as isCoreAlreadyClaimedError } from "@unbrained/pm-cli/sdk/core";
```

The predicate recognizes only the canonical `PmCliError` code `already_claimed_by`; consumers do not need to duplicate an internal string check.

## Versioned history item hashes

New history events carry `item_hash_version: 2`, whose canonicalization preserves linked-test insertion order. The verifier auto-detects unversioned legacy streams against both the legacy sorted-test epoch and the order-preserving epoch. `hashDocumentForVersion` and `verifyHistoryChainWithVersion` expose the same compatibility logic to SDK consumers.

Unknown explicit epochs return `verify_failed:unsupported_item_hash_version:<version>:entry_<n>`. Repair refuses those streams instead of rewriting evidence with a guessed algorithm. Re-anchored supported streams are normalized to the current epoch, and the drift cache records the detected epoch so item-versus-history comparison uses the same canonicalization.

## Assurance mutation refusals

Assurance `put` and `remove` operations validate untrusted declaration shapes at the shared action boundary used by the CLI, SDK, and MCP. Malformed definitions, referenced-declaration removals, and unauthorized assertion weakening return `PmCliError` with the canonical `invalid_argument_value` code and usage exit semantics. Evaluation and storage failures that are not input `TypeError`s remain unexpected and fail closed.

This boundary keeps deterministic operator refusals out of unexpected-error reporting while preserving Sentry and release-gate signal for genuine runtime faults.

## Verification expectations

Changes to these contracts require focused unit coverage, exact repository coverage, packed ESM and TypeScript consumption, and temporary-workspace CLI acceptance. Merge changes additionally require the temporary-Git workflow in [Multi-Branch Merge Safety](MERGE_SAFETY.md).
