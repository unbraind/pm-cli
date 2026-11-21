# History durability and recovery

Tracked by [pm-96fsma](../.agents/pm/issues/pm-96fsma.toon),
[pm-m0yjtg](../.agents/pm/issues/pm-m0yjtg.toon),
[pm-qw1uw6](../.agents/pm/issues/pm-qw1uw6.toon),
[pm-e3gn0z](../.agents/pm/issues/pm-e3gn0z.toon),
[pm-wlqxg3](../.agents/pm/tasks/pm-wlqxg3.toon),
[pm-nb4zwz](../.agents/pm/issues/pm-nb4zwz.toon),
[pm-jbplbq](../.agents/pm/issues/pm-jbplbq.toon), and
[pm-gh1715](../.agents/pm/issues/pm-gh1715.toon).

Project management depends on trustworthy context. History is not just an
activity feed: it is the reconstructable source for prior item states, including
their evidence, relationships, and lifecycle transitions. Recovery must not
manufacture missing context or silently change an item's identity.

## Stable addresses after compaction

`pm get <id> --at <version>` and `pm restore <id> <version>` use durable,
one-based version addresses. Compaction checkpoints the last compacted state
at its original version. Retained entries keep their addresses, including after
repeated compactions. Versions before the checkpoint fail with
`history_version_pruned`; they never select a different retained entry.

The checkpoint records `history_compaction.version_offset`. Add that offset to
a physical one-based stream position to obtain its durable version. `pm history`
reports `version_addressing`, and compact rows include their `version` alongside
the physical `index`. Verification error ordinals and diff indices remain
physical positions in the current stream. The checkpoint timestamp is the last
compacted entry's timestamp; the maintenance audit event records compaction time.

Legacy checkpoints without a recorded offset cannot prove their original
numeric addresses. Numeric reads fail with `history_version_mapping_unavailable`.
Use a retained timestamp instead; the SDK then returns `as_of_version: null`.
SDK consumers must handle this nullable value. `target.historyIndex` is always
the resolved physical zero-based position, not an original version number.
Default and timestamp-based compaction remain available for these legacy
streams. They preserve an unknown offset as `null`, including no-op results;
compaction never manufactures a numeric mapping from physical positions.

## Recover an unreadable item file

```bash
pm history <id> --full
pm restore <id> <version>
pm history <id> --verify --strict-exit
```

Restore accepts an absent file or an unparsable item document when intact
history can reconstruct it. It verifies the history before using the recovered
state, preserves the original unreadable bytes for rollback, and uses the normal
ownership and lock checks. Successful recovery reports
`restore_unreadable_item_recovered`. Permission errors and unresolved merge
conflicts are not treated as missing files. A missing initial baseline returns
`history_baseline_unavailable` with recovery guidance rather than inventing
metadata from a partial patch.

CLI shape errors name the item ID, file path, and zero-length files. The SDK
error context also includes byte length and an explicit empty-file flag.
`pm health --check-only` names malformed item paths and invalid
history lines without mutating either file; use those diagnostics to select the
specific recovery operation above.

Invalid UTF-8 is a separate refusal (`item_document_encoding_invalid`), not a
recoverable text parse failure. Preserve a binary backup before recovering such
a file; text decoding must never silently replace original bytes.
Its SDK error context identifies the item ID, path, byte length, and nonempty
state just as text-shape diagnostics do.

## Recover an invalid history tail

Keep a local backup before applying destructive history maintenance. Preview
exactly one stream, inspect the receipt, then explicitly apply:

```bash
pm history-repair <id> --salvage-tail --dry-run --json
pm history-repair <id> --salvage-tail --json
pm history <id> --verify --strict-exit
```

Salvage requires a nonempty, hash-verified prefix and retains every record byte
unchanged. It also removes lines whose JSON value is a null, a boolean or a
number wherever they sit, because such a value cannot hold a record. A string,
an array or an incomplete object might encode one, so salvage refuses those.
The receipt records the first discarded physical line, discarded UTF-8 byte
count, SHA-256 of the discarded bytes in file order, retained record count, and
`non_record_lines` when scalar lines were removed. An appended `history_salvage`
event records that receipt without copying potentially private damaged contents.
Salvage does not rehash prior entries, reconcile item state, or normalize
provenance. It refuses bulk selection, conflicting repair modes, merge conflict
markers, parseable records after corruption, and potentially complete records
with attached corruption. Recover those cases from version control or a backup.
Non-UTF-8 streams are also refused, so receipt hashes and rollback snapshots
always describe the original bytes rather than a lossy decoded approximation.

Every reader refuses a history line that is valid JSON but not an object with
`history_record_invalid`. The error names the item (`item_id`), the value kind
(`reason`, for example `a JSON null`) and the physical line (`details.line`), and
its next step is the salvage preview above. Readers never report such a line as
`unknown_error`. `pm health` keeps reporting the stream under `unreadable_streams`.

The public SDK uses the same operation:

```ts
import { PmClient } from "@unbrained/pm-cli";

const client = new PmClient({ pmRoot: "/project/.agents/pm" });
const preview = await client.historyRepair("pm-example", {
  salvageTail: true,
  dryRun: true,
});
console.log(preview.salvage);
```

The CLI and MCP expose this SDK-owned contract; package authors do not need a
separate recovery implementation.

## Bridge a broken chain without rewriting it

A change made outside pm, such as a hand edit or a merge resolution that
bypassed the driver, breaks the item's history chain. `pm health` reports
`history_drift_chain_mismatch`. Repair it append-only:

```bash
pm history-repair <id> --append-only --dry-run --json
pm history-repair <id> --append-only --json
pm health --strict-exit
```

The repair appends one sealed `history_repair` record carrying a `bridge`. The
bridge names each break by the `after_hash` before it (`gap_from`), the
`before_hash` after it (`gap_to`) and that entry's `record_hash`. Its
`segment_digest` commits to every record from the first break up to the bridge,
so no record it covers can change under it, sealed or not. Its patch
reconciles replay with the on-disk item. Its anchors keep the hash epoch the
stream already uses:

- If any record declares an epoch, the newest declared epoch.
- For an implicit stream, the epoch the verified records prove, unless the
  last record's own anchor proves another epoch. Then the newest epoch it
  proves wins.
- The epoch-2 variant that replay or the on-disk item proves.

The repair refuses with `hash_surface_ambiguous` when nothing proves the epoch
or the variant. The record is appended with `O_APPEND` to the exact bytes the
repair verified. If another writer that ignores pm's lock appends in the same
moment, its bytes are kept and the repair reports `stream_changed`. Every earlier line stays
byte-identical, so the stream before the repair remains a prefix of the
repaired stream. Other clones, worktrees and append-only consumers keep the
bytes they already hold. `--all --append-only` bridges every drifted stream, and
when several streams drift `pm health` names it as the bulk remedy for
`history_drift_chain_mismatch`.

Verification accepts a break exactly when the next bridge names it. Inside the
bridged segment it checks the recorded links, and each further break must be
the next one the bridge names. Wherever replay proves an entry's recorded
before-state, for example after a later change overwrote the edited field, that
entry's recorded effect must match too. Every record from the break to the
bridge must be complete, with item anchors that are well-formed digests of its
algorithm (`record_incomplete`). A declared epoch inside the segment governs the
records after it, and the bridge must keep the epoch the stream declared
(`bridge_epoch_mismatch`). The bridge must name no break that did
not occur, must match its `segment_digest`, and must re-anchor replay on its
own `after_hash`. A forged, unsealed or partial bridge is drift
(`bridge_invalid`, `bridge_unnamed_break`, `bridge_names_absent_break`,
`bridge_link_mismatch`, `bridge_segment_mismatch` or
`bridge_after_hash_mismatch`).

A later rewriting repair keeps a verified bridged segment's records unchanged.
Like every rewriting repair, it re-serializes the file, so it normalizes line
endings and spacing; only `--append-only` keeps the existing bytes.
Three rewrites must dissolve the bridge into an ordinary re-anchored record:

- a rewrite that changes an entry before the segment
- a merge union, which rebases every patch
- `history-redact`, which recomputes every state anchor

Each keeps the original bridge as rewrite evidence. It also marks every entry
the segment covered with a sealed `replay_inexact`, because those states were
re-anchored without the unrecorded change. Each rewrite locates a bridge's segment from the bridge's own commitments. The
segment digest proves the segment from a start that the first break's record
hash or recorded anchors name, so a rewrite that repairs a record before the
segment still marks it. When no intact commitment proves the segment, the
rewrite marks every record since the previous bridge, and the bridge record
itself. That over-restricts but never serves a version as exact. `history-redact` refuses a stream whose
bridge does not locate its segment (`history_redact_bridge_unlocated`) instead
of dropping that bridge's evidence. The markers are written before anything can
void the bridge:

- Provenance normalization writes them before it reseals a covered record.
- A merge union writes them on the records a bridge covers on either original
  branch, before it interleaves the branches. It also marks every event the
  merged order places between such a segment's first record and its bridge.
  Every merge, including identical and fast-forward results, keeps a marker
  either branch already carries, except on records a retained live bridge
  covers.
- A compaction checkpoint taken at an inexact version keeps the marker. When two clones bridged the same
break independently, the merge driver keeps ours byte-for-byte. It appends the
other bridge as a neutral record with an empty patch (`equivalent_bridges`), so
both repairs' provenance survives. It does this only when both sides and the
result verify.

Versions between a break and its bridge cannot be reconstructed exactly,
because the unrecorded change is missing from replay. `pm restore` and
`pm get --at` refuse them with `history_version_unreconstructable`, both before
and after a dissolution. Versions before the break and from the bridge onward
remain addressable. `pm history-compact` cannot checkpoint such a version
either. It refuses with `history_compact_boundary_bridged` and names the
nearest durable `--before` versions before the break and from the bridge
onward.

Clones that repaired the same break independently and then kept working
diverge in a run of the same repair, live or neutral and in either order,
followed by ordinary records. The merge driver first turns both runs into one
shared run: ours, plus neutral copies of theirs' repairs ours lacks. It then
orders only the later records, so reciprocal merges merge again without
contradictory orders. It does this only when no repair of the runs recurs
later and both rewritten sides still verify; otherwise the streams merge as
recorded. Its receipt keeps the original coordinates: the shared prefix of
the two inputs, and theirs' neutral copies count as theirs.

The repair refuses with `history_append_only_repair_unavailable` and names the
rewriting repair as the fallback when a bridge cannot carry the drift:

| `reason` | Meaning |
| --- | --- |
| `chain_failure_not_a_break` | The stream fails for another reason, such as a broken record envelope. |
| `patch_does_not_replay` | A recorded patch only applies on top of the unrecorded change. |
| `item_missing` | No on-disk item exists to anchor the bridge. |
| `stream_not_utf8` | The stream bytes cannot be kept exactly. |
| `stream_changed` | The stream changed or was replaced after the repair verified it; retry. |
| `hash_surface_ambiguous` | Neither replay nor the on-disk item proves the tail's epoch-2 variant. |
| `bridge_does_not_verify` | The extended stream would not verify. |

A preview reports the recorded effects the reconciliation overwrites
(`reconciliation`, with the `history_repair_reconcile_discards_events` warning),
as the rewriting repair does. `pm history-repair <id>` without `--append-only`
still re-anchors every recorded entry after the break, for single-writer
trackers that want a continuous chain.

## Permanent item identities

Reading a deleted ID returns `item_deleted`, distinct from an unknown ID.
The SDK error context and JSON diagnostic include `item_id` and a bounded
`tombstone` with deletion time, recoverability, and the last materialized durable
version. Human output supplies the same recovery commands:

```bash
pm get <id> --at <last-materialized-version>
pm restore <id> <last-materialized-version>
```

The not-found exit code remains `3`. Hosts that branch on diagnostic codes
should handle `item_deleted` alongside other not-found cases; the new context
fields are optional on general SDK errors. No existing required SDK input changes.

The diagnostic verifies retained history before claiming deletion. A missing
file whose history ends in a live state is not called deleted. A corrupt stream
retains its integrity refusal. For legacy compacted streams, a timestamp is
suggested only if it selects exactly the last materialized state; ambiguous
timestamps or a pruned materialized state report `recoverable: false` and direct
the caller to retained history and version control. The suggested read is
available as `recovery.suggested_retry_args` for execution without shell parsing.

Immutable event naming is documented in [History operations](HISTORY_OPERATIONS.md).

Deleting an item retains its identity reservation through its history file.
Generated IDs skip those reservations, even under reproducible execution.
Explicit recreation fails with `item_identity_reserved`; use restore to recover
the original subject, or create a new ID for unrelated work.
The first `create` append exclusively creates its effective history file, so
concurrent SDK callers and extension redirects cannot both reserve it. A failed
partial first write keeps the reservation for diagnosis; it is never deleted
to make the identity reusable. Subsequent large-record appenders still need the
normal item lock or an equivalent caller-owned serialization boundary.

Verification refuses a second `create` event, including one imported through
branch union, and names both physical ordinals. Point-in-time reads cannot cross
that discontinuity silently. Recover the original streams rather than rehashing
two unrelated subjects into a single supposedly valid item.

`pm validate --check-history-drift` reports this as an error, with item ID,
original and repeated genesis ordinals, and the observed sequence. The public
`findHistoryIdentityDiscontinuities` SDK primitive provides the same evidence
for importers. A delete followed by create is distinguished from multiple creates
or a checkpoint followed by create; these observations do not prove which
writer or branch introduced the records. Old drift caches are invalidated, and
known-invalid streams are reread even in metadata-cache mode.

## Regression verification

```bash
node scripts/run-tests.mjs test -- tests/integration/history-durability.integration.spec.ts
node scripts/run-tests.mjs test -- tests/integration/history-maintenance-replay.integration.spec.ts
```

The fixture drives real CLI lifecycle mutations, independently captures each
serialized state, removes the live item file, and compares every addressable
version against those captures. Companion cases exercise repeated compaction,
legacy mapping refusal, seeded identity reuse, invalid-tail preservation,
unreadable-file recovery, and missing baselines. Maintenance fixtures additionally
perform redaction and a real divergent Git merge, compare every version with an
independent strict patch fold, and compare the final state with a separately
read item. Concurrent writes and binary corruption are negative controls, not
mocked successful outcomes. All fixtures use temporary trackers, never repository
tracker data.
