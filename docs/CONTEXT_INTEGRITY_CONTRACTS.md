# Context Integrity Contracts

Tracker references: [pm-4fwgaz](../.agents/pm/issues/pm-4fwgaz.toon), [pm-qqoumq](../.agents/pm/issues/pm-qqoumq.toon), [pm-fpdk37](../.agents/pm/issues/pm-fpdk37.toon), [pm-jn1x30](../.agents/pm/issues/pm-jn1x30.toon), [pm-0wfdim](../.agents/pm/issues/pm-0wfdim.toon), [pm-javbsq](../.agents/pm/issues/pm-javbsq.toon), and [pm-aka8m7](../.agents/pm/issues/pm-aka8m7.toon).

## Agent Quick Context

Project management is context management. A successful read or analysis must not silently erase an item's identity, reinterpret a reference, reverse a relationship, accept an ignored compatibility spelling, or rewrite history into a format an older supported CLI cannot read. These rules are implemented in shared SDK/core primitives so the CLI, packages, extensions, and MCP hosts inherit the same behavior.

## Sparse Read Identity

`pm get <id> --fields ...` always returns `item.id`, even when `id` was not explicitly requested. Explicitly requested collection metadata is materialized as an empty array when absent. This distinguishes “the requested collection is empty” from “the field was not read” without forcing callers to request a larger projection.

```bash
pm get pm-example --fields comments,notes,learnings,tests,test_runs,docs,plan_steps,plan_decisions,plan_discoveries,plan_validation --json
```

The result retains the canonical ID and every requested empty group, including planning and test-run collections. The public `GetResult` type requires `item.id`, so SDK consumers do not need an impossible missing-identity branch. Unrequested groups remain omitted, preserving the token-saving projection contract.

## Extension Manifest Compatibility

Extension manifests use the canonical top-level `pm_min_version` and optional `pm_max_version` fields. `compatibility.pm`, `engines.pm`, or other alternate spellings do not establish the loader's pm version floor.

`checkExtensionManifestCompatibility` now performs a closed top-level schema inspection before evaluating bounds. It reports deterministic advisory findings for unknown keys and independently reports when both canonical bounds are absent, including for an otherwise recognized manifest. A recognized `compatibility` spelling includes `suggested_key: "pm_min_version"`. Runtime discovery emits matching `extension_manifest_*` warnings, which means `pm extension doctor` cannot silently report a clean manifest after discarding an unknown compatibility block or after receiving no compatibility intent at all.

Warnings are advisory; malformed or unmet canonical bounds retain their existing blocking behavior.

## Lossless Remote Documentation Links

`pm docs <id> --add` accepts structured `path=...,scope=...,note=...` values, bare paths, Markdown links, and CSV label/URL pairs:

```bash
pm docs pm-example --add '[Pull request](https://github.com/org/repo/pull/42)'
pm docs pm-example --add 'Issue report,https://github.com/org/repo/issues/17'
pm docs pm-example --add 'Query evidence,https://example.com/report?fields=id,status'
pm docs pm-example --add '[Nested path](https://example.com/report_(final))'
```

Each example creates one project-scoped documentation reference. The first comma separates a CSV label from the complete URL remainder, and balanced parentheses inside Markdown destinations remain part of the destination. The URL is preserved byte-for-byte as the path and the label becomes the note. File-link parsing is unchanged, and ordinary comma-separated bare document paths continue to expand as before.

## Direction-Locked Graph Impact

Dependency storage is oriented from the item that declares a relationship (`source`) to the referenced item (`target`). Impact analysis uses that stored orientation even for associative kinds:

- `incoming` follows source items that point at the current target: dependents and requesters.
- `outgoing` follows targets referenced by the current source: prerequisites and context dependencies.
- `both` is the deterministic union of the complete incoming and outgoing traversals. Each branch keeps its starting direction; traversal never reverses through an associative edge halfway through a path.

This prevents a shared `related` item from bridging an incoming impact query into an unrelated epic. Rows retain shortest explanation paths, bounded pagination, truncation, and query-cost receipts.

## Cross-Version History Epochs

History writers using item-hash epoch 2 always emit `item_hash_version: 2`. An entry without an explicit epoch is therefore legacy epoch 1 when the entire stream is implicit, including documents whose hashes happen to be identical under both algorithms. A supported explicit epoch becomes authoritative from its marker forward, so earlier unversioned entries retain both legacy and transitional candidates while a trailing ambiguous hash cannot downgrade the marked epoch. Verification and repair no longer guess a different epoch from the last ambiguous entry.

Repair keeps implicit legacy streams implicit and byte-stable when no drift exists. Unsupported explicit epochs still fail with a typed `unsupported_item_hash_version` diagnostic instead of being rewritten.

| Writer/runtime range                     | Item-hash output | Read contract                                                                                                                  |
| ---------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Legacy writers before an explicit marker | implicit epoch 1 | Modern readers retain legacy canonicalization candidates.                                                                      |
| Observed 2026.8.24 through 2026.8.28     | explicit epoch 2 | Modern readers accept both field-frozen and expanded epoch-2 forms without mixing forms inside one entry.                      |
| 2026.8.31 and newer                      | explicit epoch 3 | Exact pins and bounded ranges that cannot select an epoch-3 reader cause current runtimes to reject the write before mutation. |

The table records confirmed release boundaries rather than inventing an exact
first release for legacy epoch 1 or epoch 2. The SDK exports
`HISTORY_ITEM_HASH_VERSION_3_INTRODUCED_IN`, and runtime compatibility checks
use that boundary for package-manager-neutral write refusal.

## Whole-Record History Integrity

Item anchors prove the replayed project state; they do not prove who recorded an
event, when it happened, which operation produced it, or which provenance and
context were attached. New events therefore use a separate record-integrity
epoch. `record_hash_version: 1` seals every immutable field while preserving the
item-hash epoch as an independent compatibility contract.

`verifyHistoryRecordHash()` reports `record_and_item_state` for a valid sealed
event and `item_state_only` for a legacy event with neither record-envelope
field. Half-present, unsupported, and mismatched envelopes fail closed. The
public SDK also exports the record and patch hashing, sealing,
`verifyHistoryRewriteEvidence()`, rewrite-resealing, stream-digest, and
reanchoring primitives so packages and embedded hosts do not need private core
imports or their own canonicalization.

Maintenance retains prior anchors and patch digests in `reanchor_evidence`.
When policy permits, it also retains the exact prior sealed record so
metadata-only rewrites remain independently verifiable. Privacy-sensitive
redaction and provenance normalization deliberately retain digest-only evidence
instead of embedding the removed value. This separates two claims: the current
chain is replay-consistent, and a rewrite preserved evidence of what it
replaced. Compaction records a digest of its pruned prefix and explicitly states
that individual pruned entries require the pre-compaction stream; it never
upgrades intentional information loss into a stronger assurance claim.

## Verification Boundary

The regression suite covers each contract at its public SDK or command boundary. Release verification additionally installs the packed package into a temporary project and exercises sparse reads, remote docs, graph impact, extension diagnostics, and history repair without touching the repository tracker.
