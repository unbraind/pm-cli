# SDK Context Integrity

Tracker: [pm-0k19l7](../.agents/pm/issues/pm-0k19l7.toon), [pm-9stazf](../.agents/pm/issues/pm-9stazf.toon), [pm-tu71](../.agents/pm/issues/pm-tu71.toon), [pm-0xmajx](../.agents/pm/issues/pm-0xmajx.toon), [pm-7rrqsk](../.agents/pm/issues/pm-7rrqsk.toon), [pm-ety1qc](../.agents/pm/issues/pm-ety1qc.toon), and [pm-lu6sca](../.agents/pm/features/pm-lu6sca.toon).

## Agent Quick Context

These contracts keep project management equal to context management: reads say what they omit, writes return only newly useful context, diagnostics do not unexpectedly call remote providers, and every transport delegates domain validation to the same SDK primitive. Package authors can use the same primitives without reproducing CLI parsing rules.

## `get` output selectors

`pm get` has one declared selector namespace. Top-level sections use their names, while item fields may be written as either a bare field or `item.<field>`:

```bash
pm get pm-a1b2 --output-include id,title
pm get pm-a1b2 --output-include item.id,item.title,linked
pm get pm-a1b2 --output-include item,claim_state
```

An unknown selector is a usage refusal that lists the valid vocabulary. Selecting the complete `item` object together with an item field is also refused because the two selectors express conflicting projection depths. Every successful projection carries an `omission_receipt` with the exact selectors needed to restore withheld item fields or sections.

Automatic receipts cover every heavy item collection (`comments`, `notes`,
`learnings`, `files`, `tests`, `docs`, `reminders`, and `events`) plus `body`,
`children`, `claim_state`, `linked`, and `schedule`. Empty included collections
are distinguishable from omitted collections because inclusion is derived from
property presence, not collection length.

Standard and brief item reads expose the stable `collection_counts` selector;
full reads retain those counts and normalize every supported collection key to
an array. `--output-include item.collection_counts` therefore uses the same
selector grammar and omission receipts as any other SDK-owned item field.

The same SDK-owned read-output registry now declares `package manage` as a first-class read surface. Package authors can resolve either `package manage` or `package-manage` to its canonical contract and discover the universal include, amount, cost, and encoding dimensions without copying CLI knowledge.

## Bounded annotation mutations

Adding, editing, or deleting a comment, note, or learning returns the changed entry plus mutation and omission receipts. The reply size therefore stays independent of the item’s existing annotation history. Pass `--full-history` when a human or integration genuinely needs the complete post-mutation collection:

```bash
pm comments pm-a1b2 "Decision evidence"
pm comments pm-a1b2 --edit 3 --message "Corrected evidence" --full-history
pm notes pm-a1b2 --delete 2 --full-history
```

SDK callers use `fullHistory: true`; MCP callers use `full: true`. The default stays bounded on every transport. An omission receipt identifies the semantic `full_history` selector and includes its CLI (`--full-history`), SDK (`fullHistory`), and MCP (`full`) spellings, so non-CLI consumers never need to interpret shell-only guidance.

## Author acknowledgment coordinates

CLI, SDK, and MCP use the same selector and coordinate parser for `history-author-acknowledge`. A coordinate is `<item-id>:<line>` or `_workspace:<line>`, with a positive one-based line number. Exactly one of explicit events or `all_actionable` is required.

```bash
pm history-author-acknowledge \
  --event _workspace:4 \
  --attributed-author import-agent \
  --reviewer maintainer \
  --reason "Verified workspace provenance"
```

The SDK exposes `resolveUnknownAuthorAcknowledgmentSelector` and `parseUnknownAuthorHistoryEventCoordinates` so packages never need a private copy of this grammar. Health and validate map actionable unknown-author warnings directly to this append-only acknowledgment command instead of sending callers through another diagnostic loop.

## Health provider boundary

`pm health` is read-only by default and never refreshes embeddings merely because a semantic provider is configured. Provider I/O requires `--refresh-vectors`; `--skip-vectors` or `--no-refresh` records the explicit non-provider path. Provider requests remain bounded by the configured embedding timeout, and a failed refresh reports the responsible vector diagnostic plus the skip remediation.

Storage integrity is evaluated independently of that provider boundary. Lossless merge receipts remain visible as provenance, while only receipts containing discarded scalar values produce `merge_decisions_unreviewed` guidance; neither classification enables vector refresh or remote provider I/O.

Brief and summary check-only health projections use the scalar-only metadata
reader. Validation uses collection-bearing metadata for evidence and
relationship checks and materializes bodies only when strict history-drift
verification is requested.

The storage check also reads at most 10,000 local immutable events for bounded
agent-provenance resolver outcomes. This scan performs no network or provider
I/O, tolerates malformed streams already owned by integrity diagnostics, and
reports an advisory warning only when a resolver was actually attempted but
never succeeded.

## Replication and refusal gate

`scripts/release/surface-replication-sets.json` declares replicated SDK, CLI, MCP, documentation, and test members. `pnpm quality:surface-replication` activates sets from the Git changeset, verifies every member invariant, and reports:

- active set recurrence density;
- the largest source member’s utilization of the mandatory file-size cap;
- every remaining CLI-owned `PmCliError`, grouped by an explicit adapter-level disposition;
- applied waivers, including their PM owner and expiry;
- an AST-derived denominator of identical named rule bodies, declared coverage,
  and a non-decreasing detected-cluster floor.

Query waivers directly with:

```bash
node scripts/release/surface-replication-gate.mjs --list-waivers
```

Waivers are never implicit: they require a canonical PM item, a reason, an exact set member, and an expiry date. New or moved CLI refusals fail until the inventory is updated or the rule is delegated into the SDK. The same declaration runs locally and inside the required static-quality workflow.
