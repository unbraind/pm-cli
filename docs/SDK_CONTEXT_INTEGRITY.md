# SDK Context Integrity

Tracker: [pm-0k19l7](../.agents/pm/issues/pm-0k19l7.toon), [pm-9stazf](../.agents/pm/issues/pm-9stazf.toon), [pm-tu71](../.agents/pm/issues/pm-tu71.toon), [pm-0xmajx](../.agents/pm/issues/pm-0xmajx.toon), [pm-7rrqsk](../.agents/pm/issues/pm-7rrqsk.toon), [pm-ety1qc](../.agents/pm/issues/pm-ety1qc.toon), [pm-lu6sca](../.agents/pm/features/pm-lu6sca.toon), [pm-5y05kq](../.agents/pm/issues/pm-5y05kq.toon), [pm-gjjurs](../.agents/pm/issues/pm-gjjurs.toon), [pm-h97qxd](../.agents/pm/issues/pm-h97qxd.toon), [pm-h06944](../.agents/pm/issues/pm-h06944.toon), [pm-5t33or](../.agents/pm/features/pm-5t33or.toon), [pm-in23qu](../.agents/pm/issues/pm-in23qu.toon), and [pm-okgxwa](../.agents/pm/issues/pm-okgxwa.toon).

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

Compatibility aliases declare whether their migration promise is an exact
`replacement` or only `behavior_preserving`. Exact projection modes are
available through `readOutputIncludeModeOptions()` and are executed against
their legacy spelling in the temporary-tracker contract suite. Execution
controls such as `deps --collapse <value>` and `health --check-only` retain
their independent semantics and are never exposed as false include-mode
replacements.

Every registered read surface also resolves a format-aware default token ceiling
from the public command-output contract. Results already inside that ceiling are
returned byte-for-byte unchanged, so the safety default adds no receipt overhead
to ordinary reads. Oversized results follow the shared compaction ladder and
identify `budget_source: default` plus the applied `budget_tokens` in their
`read_output` receipt. Complete internal artifacts and callers that intentionally
accept unbounded output must say so explicitly with `--output-budget unbounded`
or `outputBudget: "unbounded"`; that opt-out is distinct from row-count
`--unbounded` compatibility behavior.

The budget ladder separately discovers nested arrays below declared result
rows. This lets governance envelopes reduce diagnostic findings before
omitting the whole verdict without redefining a nested tag or remediation list
as a pagination row. Receipts name every `compacted_row_paths` entry; a complete
omission also records the useful result's pre-omission estimate, while the
recovery names a bounded budget increase when no declared row path can resume.

Budget-compacted declared rows instead publish a bounded `outputCursor`
continuation on every transport. The cursor resumes the first withheld row and
rejects a command, path, row-total, or stable-identity mismatch. This gives SDK
and package loops a recursive self-improvement primitive: consume a bounded
page, update context, and continue without abandoning the ceiling.

`context --explain-ranking` projects explanations to the focus rows actually
served. `candidate_count` records the scorer population and `omitted_count`
records explanations intentionally withheld, while each returned row retains
its rank, baseline rank, score, and per-signal contributions. Explanation cost
therefore scales with the answer rather than with the active workspace.

Unknown-option recovery is likewise derived from the declared flag lexicon.
The structured `option_scope` is `declared_on_path`, `declared_elsewhere`, or
`declared_nowhere`; accepting command paths are included only for the second
case, while the third names the nearest current-path spellings and explicitly
terminates the otherwise-unbounded command search.

## Row discovery and exact output receipts

Row locations and encoding capabilities remain part of the SDK-owned read
contract, but the `row_contract` discovery block is opt-in on rendered command
results. Use `--output-row-contract` in the CLI or `outputRowContract: true` in
SDK and MCP options when a generic consumer must discover row selectors. Normal
agent reads omit the repeated metadata and retain the same internal projections.

Uniform flat object arrays use canonical tabular TOON when TOON output is
selected. Mixed, nested, or scalar collections retain the general recursive
encoding, so package authors can add richer shapes without pretending they are
tabular. The optional row contract declares
`toon_encoding: tabular_when_uniform` for consumers that negotiate this
optimization.

When discovery metadata is omitted, every `context_intent`, `read_output`, and
`read_session` estimate is stabilized against the final serialized envelope.
Consequently `estimated_tokens` and `spent_this_call_tokens` never charge an
agent for hidden row metadata, and a caller-carried output session remains an
exact cross-command budget rather than an approximation of an intermediate
shape.

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

Default history-drift verification also replays the append-only `_workspace`
stream and compares every governed singleton with its latest recorded state.
That agreement check reads only local history and JSON files: mismatched,
missing, or unreadable singleton paths become bounded `history_drift` evidence
without enabling embeddings, vector-store access, or any other provider I/O.

Brief and summary check-only health projections use the scalar-only metadata
reader. Validation uses collection-bearing metadata for evidence and
relationship checks and materializes bodies only when strict history-drift
verification is requested.

Every health check row exposes both its tri-state `status` and a required
boolean `ok`. The boolean is exactly `status === "ok"` in full, brief, and
summary projections, so generic SDK and package consumers can use a stable
success predicate without discarding warning-versus-error detail.

The storage check also reads at most 10,000 local immutable events for bounded
agent-provenance resolver outcomes. This scan performs no network or provider
I/O, tolerates malformed streams already owned by integrity diagnostics, and
reports an advisory warning only when a resolver was actually attempted but
never succeeded. The same bounded pass classifies bare boolean and single-digit
values across every recorded provenance dimension, publishes only aggregate
harness/dimension/kind counts, and never echoes the historical value.

## Replication and refusal gate

`scripts/release/surface-replication-sets.json` declares replicated SDK, CLI, MCP, documentation, and test members. `pnpm quality:surface-replication` activates sets from the Git changeset, verifies every member invariant, and reports:

- active set recurrence density;
- the largest source member’s utilization of the mandatory file-size cap;
- every remaining CLI-owned `PmCliError`, grouped by an explicit adapter-level disposition;
- applied waivers, including their PM owner and expiry;
- an AST-derived denominator of identical named rule bodies, declared coverage,
  and a non-decreasing detected-cluster floor.

Trigger entries may constrain a shared file with `changed_lines_contain_any`.
The set then activates only when an added or removed diff line carries one of
those contract markers. Missing diff evidence fails closed and activates the
set, while an unrelated hunk in the same shared table does not force artificial
edits across every replicated member.

Query waivers directly with:

```bash
node scripts/release/surface-replication-gate.mjs --list-waivers
```

Waivers are never implicit: they require a canonical PM item, a reason, an exact set member, and an expiry date. New or moved CLI refusals fail until the inventory is updated or the rule is delegated into the SDK. The same declaration runs locally and inside the required static-quality workflow.
