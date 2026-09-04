# Multi-Branch Tracker Merge Safety

Tracked by [pm-wc1r](../.agents/pm/features/pm-wc1r.toon), with the integrity and concurrency fixes [pm-9q2t](../.agents/pm/issues/pm-9q2t.toon), [pm-cxyv](../.agents/pm/issues/pm-cxyv.toon), [pm-gpo7](../.agents/pm/issues/pm-gpo7.toon), [pm-m3nl](../.agents/pm/issues/pm-m3nl.toon), [pm-wwfd](../.agents/pm/issues/pm-wwfd.toon), and [pm-xdn6](../.agents/pm/issues/pm-xdn6.toon). Fresh-init fence ownership is tracked by [pm-1w3ljt](../.agents/pm/issues/pm-1w3ljt.toon); runtime-cache index governance by [pm-hous](../.agents/pm/issues/pm-hous.toon); local allocation safety by [pm-khdq](../.agents/pm/issues/pm-khdq.toon); fence-coverage completeness and drift detection by [pm-i4fx](../.agents/pm/issues/pm-i4fx.toon); package-defined item coverage by [pm-5rexki](../.agents/pm/issues/pm-5rexki.toon); non-item JSON coverage by [pm-gjicmx](../.agents/pm/issues/pm-gjicmx.toon); portable driver identity by [pm-w91mvg](../.agents/pm/issues/pm-w91mvg.toon); pending receipt validation by [pm-ysqb6n](../.agents/pm/issues/pm-ysqb6n.toon); receipt classification by [pm-jtwsct](../.agents/pm/issues/pm-jtwsct.toon); direction-independent item conflict selection by [pm-dlx7v7](../.agents/pm/issues/pm-dlx7v7.toon); corrected reconciliation guidance by [pm-lwmstb](../.agents/pm/issues/pm-lwmstb.toon); cross-branch id collision safety by [pm-pibw](../.agents/pm/issues/pm-pibw.toon); auditable merge history by [pm-9j2r3b](../.agents/pm/tasks/pm-9j2r3b.toon); durable conflict decisions by [pm-rh98vo](../.agents/pm/issues/pm-rh98vo.toon); continuous conformance by [pm-76dnfg](../.agents/pm/tasks/pm-76dnfg.toon); workspace-wide CI enforcement by [pm-pdr8t1](../.agents/pm/tasks/pm-pdr8t1.toon); post-merge reconciliation by [pm-mfkv92](../.agents/pm/issues/pm-mfkv92.toon); linked-command execution trust by [pm-ed28wi](../.agents/pm/issues/pm-ed28wi.toon); this repository's own adoption by [pm-iwsj](../.agents/pm/chores/pm-iwsj.toon).

Lossless receipt health gating is tracked by
[pm-baksix](../.agents/pm/issues/pm-baksix.toon), and executable remediation
that performs settlement is tracked by
[pm-r0p3at](../.agents/pm/issues/pm-r0p3at.toon). Immutable record sealing and
retained re-anchor evidence are tracked by
[pm-javbsq](../.agents/pm/issues/pm-javbsq.toon) and
[pm-aka8m7](../.agents/pm/issues/pm-aka8m7.toon); preferred-era receipt-summary
compatibility is tracked by
[pm-wn3ee5](../.agents/pm/issues/pm-wn3ee5.toon).
Lossless concurrent acceptance-criteria composition is tracked by
[pm-inn5y5](../.agents/pm/issues/pm-inn5y5.toon).
Recency-aware scalar convergence, bounded fresh-clone decision evidence, and
audited pre-durable receipt dispositions are tracked by
[pm-7wzb6d](../.agents/pm/issues/pm-7wzb6d.toon),
[pm-mg13iz](../.agents/pm/issues/pm-mg13iz.toon), and
[pm-cf4t42](../.agents/pm/issues/pm-cf4t42.toon).

pm stores project context as reviewable repository files. Concurrent agents can therefore use ordinary branches and worktrees, but tracker artifacts need semantic merge behavior: raw line merging cannot preserve TOON collection counts, JSON object structure, or append-only history hash chains.

## Install the repository merge contract

Fresh `pm init` runs this automatically when the tracker is inside a Git
worktree. It writes the shared fence and configures the current clone before
returning success. Use `pm init --no-merge-fence` only when another system
deliberately owns Git merge configuration.

Existing trackers and fresh clones can install or repair the contract directly:

```bash
pm merge install
git add .gitattributes
git commit -m "chore(pm): install tracker merge drivers"
```

`pm merge install` writes an idempotent, fenced `.gitattributes` block and repository-local `git config` entries. The attributes are committed; the driver commands are clone-local, so every collaborator and fresh CI clone that performs merges must run the install command.

The clone-local driver values record the absolute Node executable and bundled
`dist/cli.js` path resolved by the installing SDK. Git therefore does not depend
on a bare `pm` command or the caller's later `PATH` when it merges tracker data.
The item-path placeholder is stored as bare `%P`: Git performs the required
shell quoting when it expands the placeholder. Receipt ingestion also removes
one legacy matching quote pair so receipts written by older clone-local drivers
remain reconcilable.
`pm validate --check-storage-integrity` and `pm health` also compare every
clone-local driver definition with the installed SDK. Exact commands remain the
fast path. A command installed by another valid `@unbrained/pm-cli` package is
also accepted when its Node and `dist/cli.js` paths exist, its manifest owns the
`pm` bin, and the driver arguments are semantically identical. This keeps
copied worktrees and upgraded global installs healthy without accepting an
arbitrary executable. A missing, malformed, or semantically stale definition is
reported even when the committed attribute fence is correct.

The installer publishes the shared `.gitattributes` fence only after the clone-local driver commands are configured. If the repository Git config is read-only or another Git process holds its lock, the command returns the stable `merge_git_config_unwritable` error with recovery guidance and leaves an absent fence absent. Use `pm merge install --dry-run --json` to inspect the contract in intentionally read-only workspaces.

### Fence coverage contract

The fenced block is generated by one shared coverage contract (`buildMergeAttributePatterns`) covering every mergeable artifact class: tracker-wide `**/*.toon` and `**/*.md` item patterns, explicit per-type diagnostic patterns, all tracker `**/*.jsonl` paths under the relationship-event driver with the more-specific `history/*.jsonl` rule overriding history streams, root `settings.json`, and every nested `**/*.json` document. The tracker-wide item rules protect extension-defined type folders even when a receiving branch has not installed the package that registered them; explicit type rows still make active-registry drift diagnosable. The broad JSON rules automatically cover schema, managed-extension, evaluation-corpus, and future package-owned authoritative JSON without another hand-maintained allowlist. The broad JSONL rule is required because `RelationshipEventStore` supports package-owned custom relative paths anywhere below the tracker root. Two mechanisms keep the committed fence from drifting out of that contract:

- `pm schema add-type` / `pm schema remove-type` refresh the fence automatically when it is installed (warning `merge_fence_refreshed`); repos inside git that never installed it get the actionable `merge_fence_not_installed` hint instead.
- `pm validate` (the `storage_integrity` check) audits the committed fence against the active schema's type folders and reports `validate_merge_fence_drift` with the exact missing/stale attribute lines when they diverge — for example after editing type folders out-of-band. Rerun `pm merge install` and commit `.gitattributes` to clear it.

Preview without mutation:

```bash
pm merge install --dry-run --json
```

## Artifact semantics

| Artifact                                                         | Driver                              | Merge behavior                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Item `.toon` / `.md`                                             | `pm-item-toon` / `pm-item-markdown` | Three-way field merge; append-like collections use set union, `updated_at` uses the latest timestamp, scalar conflicts select the value from the later document update with stable value order as an equal-timestamp tie-break, and canonical serialization recomputes TOON counts. |
| `history/*.jsonl`                                                | `pm-history`                        | Preserves the common prefix and both divergent suffixes, orders deterministically, then re-anchors the resulting hash chain.                                                                                                                                                        |
| tracker `**/*.jsonl` except the later `history/*.jsonl` override | `pm-relationship`                   | Covers default and package-owned custom relationship event paths, unions divergent suffixes by `eventId` (timestamp-ordered, ours-first on ties), and renumbers `sequence` consecutively so the strict-sequence store loader accepts the merged stream.                             |
| root `settings.json` and nested `**/*.json`                      | `pm-json`                           | Recursively merges objects per key. Arrays compose when both branches preserve the base and add distinct entries, so independent extension installs and evaluation additions merge without weakening edit/removal conflict detection.                                               |

The `tests` collection has an additional execution-safety rule. Its semantic
identity excludes provenance so the same command/context does not duplicate
when branches record different authorship metadata. A test definition newly
contributed by the other merge side is persisted with
`provenance.source_kind=merge_union` while retaining its author, creation time,
and source ref. `pm test --run` and `pm test-all` refuse that command before
spawning a process until the receiving clone acknowledges its fingerprint or
uses the two-part project-policy plus per-run override documented in
[Testing](TESTING.md#linked-test-command-trust). `pm validate
--check-command-references` reports outstanding entries. This is the threat
boundary for append-like data that becomes executable after a merge; ordinary
notes, files, and other non-executable collections retain normal set-union
behavior.

Although `acceptance_criteria` is serialized as a semicolon-delimited scalar
for backward compatibility, the item driver treats its parsed criteria as a
collection. Independent additions compose in branch order, removals made by
either side remain removed, the field is reported in `union_fields`, and a
lossless merge does not create a scalar conflict decision. This gives repeated
`pm update --add-ac` mutations the same multi-branch preservation guarantee as
native append-like metadata without a storage migration.

When both sides change the same item scalar differently, the driver retains the
value from the document with the later `metadata.updated_at` timestamp. Equal
timestamps fall back to stable value ordering, so reversing Git's ours/theirs
labels still converges to the same result. Item results, driver results, and
receipts expose `conflict_resolution: latest_document_update` and
`requested_preference_applied: false`; each conflict decision adds
`retained_side` and `resolution_basis` so review automation can distinguish a
recency decision from the stable tie-break. The caller's
`requested_preference` remains observable but does not override item scalar
convergence. Readers continue to accept legacy `preferred_side` and
`stable_value_order` receipts and normalize the legacy `preferred` key. JSON
leaf conflicts retain their explicit preferred-side policy. Git keeps the item
path conflicted so a human or coordinating agent must review the discarded
value and explicitly `git add` the resolution.

The exact object `{ "pm_item_scalar_missing": true }` is reserved for
JSON-stable missing-value evidence. Item merge inputs reject that object as a
present metadata value, while the hashing primitive independently separates
present and missing domains. This prevents extension data from impersonating a
deletion without wrapping every ordinary scalar in receipt output.

The driver result's `guidance` always points unresolved conflicts to `pm merge report`. When a clone-local receipt exists, guidance includes its privacy-safe receipt and item ids for exact correlation; discarded values remain confined to the local receipt and never appear in generic logs or tracker history. Tracked by [pm-fbrz7p](../.agents/pm/issues/pm-fbrz7p.toon).

For item conflicts, the driver writes a clone-local receipt below the Git
directory and a durable privacy-safe sidecar below `merge-receipts/` in the
tracker. The local receipt contains retained and discarded values so recovery
does not depend on a reflog. The tracked sidecar applies the versioned
`bounded_non_sensitive_scalars_v1` policy. Built-in lifecycle statuses,
priority integers from 0 through 4, bounded risk/confidence/severity ordinals,
and `null` are stored with both their value and matching hash. All other values
remain hash-only. `value_availability` distinguishes `bounded_inline`, `mixed`,
and `hash_only`, while the clone-local receipt remains `clone_local`. This lets
a fresh-clone reviewer recover ordinary control-plane decisions without
publishing titles, descriptions, custom statuses, or other potentially private
content. When both copies exist the SDK deduplicates them and prefers the
locally recoverable copy:

```bash
pm merge report
pm merge report --include-reconciled
```

The underlying public SDK exports are `mergeItemDocuments`, `mergeHistoryStreams`, `mergeRelationshipEventStreams`, `mergeJsonDocuments`, `runMergeDriver`, `runMergeInstall`, `installMergeFence`, `findGitWorkspaceRoot`, `runMergeReconcile`, `runMergeReceiptReport`, `runMergeReceiptEvidenceReport`, `inspectMergeReceiptEvidence`, `listMergeReceipts`, `auditMergeDriverConfiguration`, `refreshMergeAttributeFenceIfInstalled`, `buildMergeAttributePatterns`, and `auditMergeAttributeFence` from `@unbrained/pm-cli/sdk`. `installMergeFence` accepts explicit tracker and workspace roots, so custom init hosts do not depend on process cwd or CLI globals.

`listMergeReceipts` is the compatibility projection for callers that only need
validated receipts. It cannot distinguish an empty evidence store from a store
whose candidates were all rejected. Gates and diagnostic integrations should
use `inspectMergeReceiptEvidence`, whose `invalid_evidence_count` preserves
that distinction without returning malformed contents.
`runMergeReceiptEvidenceReport` and `pm merge report --json` expose the same
loss-aware contract through `complete`, `invalid_evidence_count`, bounded
`invalid_evidence[]`, `invalid_evidence_truncated`, and
`clone_local_evidence_resolved`. Each rejected candidate reports a stable
reason plus its `clone_local`, `durable`, or copy-consistency source. Schema and
identity failures additionally expose a bounded `validation_error` such as
`required_fields`, `item_path`, `filename`, or `durable_decisions`. A safe
receipt filename is returned as `receipt_id`; unsafe candidate names are
represented only by `candidate_name_hash`, and malformed contents are never
returned. The detail list is capped at 100 rows while the count remains exact,
so automated gates stay token-bounded. Directory traversal distinguishes a
truly absent store from a non-directory or unreadable ancestor on Windows and
POSIX instead of treating platform-specific `ENOENT`/`ENOTDIR` spellings as
equivalent. Full health also cross-checks the privacy-safe receipt summaries in
append-only history against valid pending and reconciled evidence. Missing
evidence emits `merge_receipt_history_reference_missing:<n>` with bounded item,
history-line, and receipt-id-or-hash coordinates. Recover an available receipt
from an authoritative clone or backup first. For an exact reference whose
history-event timestamp predates tracked durable receipts, `pm merge reconcile
--force` can append a `merge_reconcile` audit event containing the original
item, line, receipt id, timestamp, and the closed
`legacy_clone_local_only` reason. Health accepts only that exact coordinate and
reports it through `accepted_missing_merge_receipt_dispositions`; it never
rewrites or deletes the original history. The audit event must also occur after
the referenced history line; an earlier event cannot pre-authorize a later
missing receipt. Missing post-durable evidence remains blocking and cannot be
dispositioned through this compatibility path. The CLI
exits nonzero when evidence is incomplete, even when the valid-receipt count is
zero. Current SDK implementations always emit the new field, while its optional
type preserves structural compatibility for existing typed adapters and test
fixtures. A structurally valid preferred-era history summary that contains its
complete privacy-safe receipt evidence is accepted in place: health counts it
as `accepted_legacy_merge_receipt_references` and does not demand an external
receipt file that the older writer never created. Incomplete, contradictory, or
modern summaries still fail closed. `runMergeReceiptReport` remains the
compatible valid-only report.

## Cross-branch id collision safety

Item ids are `<prefix>` plus random base36 characters, and uniqueness is only probed against the local working tree — two agents branching from the same commit can mint the same id for different items (GH-600 / pm-pibw). Two controls bound that risk:

- **Entropy budget** — `ids.token_length` in `settings.json` (default 4, accepted range 4–12) sets the random token length for newly minted ids. Approximate 1%-birthday-collision workloads per length: 4 chars ≈ 1.68M ids (~184 concurrent unsynced creations), 6 chars ≈ 2.18B (~6.6k), 8 chars ≈ 2.8T (~238k). Multi-agent repositories that fan out many branches between merges should raise it, e.g. `pm config project set ids_token_length 6`.
- **Post-merge detection** — the `storage_integrity` validate check reports `validate_storage_duplicate_item_ids` whenever one id is claimed by multiple item documents (across type folders or format variants), which is how a same-id/different-item merge materializes. Remediation: keep one document, recreate the other item under a fresh id (`pm copy` then delete the colliding file), and re-point any dependencies.

Within one working tree, create and copy serialize on the candidate id and
recheck every built-in and extension-defined type folder before the
authoritative write. A raced collision fails with `item_id_collision` instead
of replacing the existing document.

## Required post-merge gate

After every branch merge that touches `.agents/pm`, run:

```bash
pm merge reconcile --dry-run --json
pm merge reconcile --message "Reconcile merged tracker histories" --json
# Required only to accept a receipt that lacks qualifying exact hash proof:
pm merge reconcile --force --message "Accept reviewed merge decisions" --json
```

The preview reports every drifted stream and pending receipt without mutation.
Lossless receipts do not become discarded-value decisions and reconcile without
`--force`, but `pm health` reports `merge_receipts_pending:<n>` and remains
non-green until the apply pass settles them. `pm history-repair` cannot clear
that receipt finding. When a drifted item also has a pending receipt, the
`history_drift` remediation map prioritizes `pm merge reconcile` only
when canonical item path, changed-field, and merged-value hash evidence all
attribute that finding to one or more receipts loaded from the clone-local Git
evidence store or the authoritative durable receipt store. Every field declared by each receipt must match its current merged-value
hash, even when only a subset appears in the history reconciliation diff.
Disjoint valid receipts may collectively cover a multi-field reconciliation;
the audit and settlement then retain every individually proven receipt id.
Serialized source claims are ignored. Receipt readers validate the complete
bounded schema, safe identifiers, filename and item-path identity, timestamps,
and bounded decision structure before a sidecar enters health or
reconciliation. Reads use size-preflighted, no-follow regular-file descriptors;
durable decision values must conform to the declared bounded-inline policy or
remain hash-only. Qualifying durable-only receipts
are reloaded from the authoritative store and accepted only after exact canonical
item path, declared-field, and merged-value hash verification. Legacy receipts,
receipts whose declared fields disagree with their hashes, same-item tampering,
and drift on unrelated items fail closed to the normal `pm history-repair`
guidance. Health indexes authoritative evidence once by item and reconciliation
uses the same per-item groups with a fixed receipt-only worker pool, so committed
sidecars cannot amplify drift scans into unbounded parallel repair work.
The machine-executable remediation for a missing receipt reference names
`pm merge reconcile --dry-run`. It never publishes `--force` as an executable
hint: the human-readable summary explains that exact eligible pre-durable
coordinates may be dispositioned by a separately reviewed force pass. Ordinary
pending lossless receipts retain their unforced apply remediation.
Apply-mode reconciliation repeats the same proof against the exact
item snapshot used by the audited history rewrite. The audit event and
settlement include only the individually proven receipt id, so one valid receipt
cannot authorize an untrusted same-item sibling. Failed or unproven receipts
remain pending unless the coordinator explicitly reviews and supplies `--force`.
Snapshot verification accepts both the current presence-domain digest and the
legacy version-1 scalar digest, so already-written receipts remain repairable;
new receipts always use the collision-free presence-domain scheme.
Receipts with discarded scalar values retain the distinct
`merge_decisions_unreviewed:<n>` finding. Matching authoritative hash proof
allows those receipts to settle without `--force`; without qualifying proof,
the apply pass refuses them until the coordinator explicitly supplies `--force`
after review. The `history_drift_merge_receipt` remediation may therefore emit
an unforced apply command that clears `merge_decisions_unreviewed` when the
receipt proves the exact current merged values. This prevents routine repair
from hiding unfinished reconciliation while avoiding redundant force for an
already-proven canonical snapshot.
The same `--force` boundary also handles an unrecoverable pre-durable
clone-local-only history reference. Preview and apply results expose
`missing_history_references_before`, `legacy_disposition_eligible`,
`legacy_disposition_recorded`, and `missing_history_references_after`. When
coordinates exceed the bounded health response, explicit result guidance
requires repeated dry-run and reviewed force passes until health no longer
reports truncated coordinate details and the remaining count is zero. An apply
result cannot return `ok: true` while any missing reference or truncated
evidence remains.
It exits nonzero while either merge-critical validation check is non-green, so
CI and explicit post-merge hooks cannot approve unresolved receipts or drift.
The apply pass uses the audited history rewrite boundary to append a
`merge_reconcile` event whose patch reproduces the merged item exactly. The
event includes privacy-safe receipt provenance; a clean receipt-bearing stream
gets a no-op merge event so the merge remains addressable even when replay
already matches. The command immediately validates history drift plus storage
integrity and exits nonzero when an invariant remains red. Default Git hooks
remain unchanged: repositories that want automatic enforcement must opt in by
invoking this command from their own post-merge hook.

The default validation surface includes `storage_integrity`. It fails on unreadable item documents, history conflict markers, malformed history tails, live items whose latest history operation is `delete` (a delete/modify resurrection candidate), and unparseable settings/schema files. This prevents the ordinary tolerant read path from turning corruption into a green gate.

A history union can be structurally valid while replayed history and the chosen item document describe different effective state. In that case inspect both authors' events before reconciliation, then run the audited repair:

```bash
pm history <item-id> --verify --strict-exit
pm history-repair <item-id> --dry-run
pm history-repair <item-id>
pm merge reconcile --dry-run --json
```

`history-repair` records the reconciliation patch and classifies its changed fields against the final item. Append-only collection unions and deterministic reordering are reported as preserved context without a data-loss warning. Fields whose replayed values are actually removed or replaced remain loud with discarded event authors/operations and recovery guidance. Re-apply any intended losing mutation as a normal `pm update` so it remains explicit and auditable.

History events now declare an item-hash epoch. Epochs are immutable writer
contracts, not aliases for the current item serializer: epoch 1 sorts linked
tests; epoch 2 preserves their insertion order and has both an earlier
field-frozen form and a later expanded form because the writer surface grew
before the marker advanced; epoch 3 is the current form. Verification accepts
both recorded epoch-2 forms without allowing one entry to mix them, and repair
preserves the form evidenced by each event. Unversioned streams are verified
against the supported legacy canonicalizations. Current-document comparison
selects the resolved epoch candidate that matches the chain head. A union merge
may consume suffixes written by both epoch-2 forms, but its synthesized output
uses one form for the complete re-anchored stream so every stored `after_hash`
is exactly the next stored `before_hash`. An unknown explicit epoch is
reported as `unsupported_item_hash_version` and repair refuses to guess. This
keeps version incompatibility distinct from item corruption and is tracked by
[pm-2htk4p](../.agents/pm/issues/pm-2htk4p.toon) and
[pm-2qahia](../.agents/pm/issues/pm-2qahia.toon).

New history events also carry `record_hash_version` and `record_hash`. Unlike
the item anchors, the record hash covers the complete immutable event: author
and agent provenance, timestamp, operation, message, context, patch, item-hash
epoch, and before/after anchors. A record that carries only one envelope field,
uses an unsupported record epoch, or changes after sealing fails verification.
Entries created before this envelope remain readable as explicit
`item_state_only` coverage; they are not presented as record-authenticated.

Every maintenance rewrite verifies a present record hash before changing the
stream and reseals the output. When anchors or patch representation change, the
entry's append-only `reanchor_evidence` retains the prior anchors, item epoch,
patch digest, and prior record envelope. Lenient repair additionally retains
the complete replaced patch operations. `verifyHistoryRewriteEvidence()`
reconstructs every available prior envelope and rejects a record that was
modified and merely resealed after maintenance. Redaction never copies sensitive patch
values into new evidence: it keeps the digest and drops a retained patch if the
patch itself matched a redaction rule. Compaction baselines retain the pruned
entry count and ordered stream digest plus an explicit
`individual_pruned_entries_require_pre_compaction_stream` limitation. A holder
of the pre-compaction stream can therefore validate the checkpoint, while the
post-compaction stream does not falsely claim that it can reconstruct content
that was intentionally pruned.

## Delete versus modify policy

A delete on one branch and an edit on another is not safely resolvable by a generic file driver. The merged workspace must not silently resurrect the item. `storage_integrity` reports the live document plus delete-terminated history as a hard finding. The coordinator chooses one policy explicitly:

- Honor deletion: remove the live item document, keep its append-only history, and commit the resolution.
- Honor modification: restore/recreate through pm so the history contains an explicit post-delete operation and rationale.

Never remove conflict markers manually while leaving the authoritative item and history semantically inconsistent.

## Runtime receipts and retention

`transactions/` and `checkpoints/` are per-branch crash-recovery state, not shared project context. `pm init` places both below the resolved tracker root in the managed `.gitignore` block, including custom `--pm-path` roots.

Ignore rules do not remove files that were already committed. `pm health`
(`integrity`) and `pm validate` (`storage_integrity`) therefore scan Git's
index for tracked files below `runtime/`, `search/`, `locks/`,
`transactions/`, and `checkpoints/`. A finding includes repository-relative
paths plus an exact `git rm --cached -r -- ...` command. That command removes
only the indexed copies; local caches and recovery receipts remain on disk
under the managed ignore fence. The intentional
`search/eval-queries.json` relevance-evaluation corpus remains tracked and is
excluded from this cache diagnostic.

Terminal SDK transaction journals use the same `checkpoints.retention_days` policy as rollback checkpoints. The default GC sweep includes both receipt classes:

```bash
pm gc --dry-run
pm gc --scope transactions --dry-run
pm gc --scope transactions
```

Only aged `committed` or `compensated` journals are removed. `applying`, `compensating`, unreadable, and unparseable journals are always retained so cleanup cannot destroy live recovery state.

## Temporary-clone acceptance test

Before releasing merge-contract changes, validate the packed package in a temporary Git repository: initialize pm, install the merge contract, create one base item, branch twice, append disjoint metadata/history on both branches, merge, and run the strict validation commands above. Include a same-key conflict case and prove Git leaves it unresolved while the output remains parseable.
