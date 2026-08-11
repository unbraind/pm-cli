# SDK Context and Evidence Contracts

Tracked by [pm-gok2km](../.agents/pm/issues/pm-gok2km.toon), [pm-zryb9d](../.agents/pm/issues/pm-zryb9d.toon), [pm-qckpnq](../.agents/pm/issues/pm-qckpnq.toon), [pm-hfqju5](../.agents/pm/issues/pm-hfqju5.toon), [pm-2htk4p](../.agents/pm/issues/pm-2htk4p.toon), and [pm-v0a0un](../.agents/pm/issues/pm-v0a0un.toon).

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

Stable-value item merges distinguish a caller request from the outcome. Low-level item results, driver results, clone-local receipts, and privacy-safe summaries expose `requested_preference`. The actual outcome remains in each decision's `retained` and `discarded` values or hashes. New receipts do not emit the ambiguous `preferred` key; readers still ingest legacy schema-v1 receipts and normalize that key to `requested_preference`.

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
