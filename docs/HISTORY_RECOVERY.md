# History durability and recovery

Tracked by [pm-96fsma](../.agents/pm/issues/pm-96fsma.toon),
[pm-m0yjtg](../.agents/pm/issues/pm-m0yjtg.toon),
[pm-qw1uw6](../.agents/pm/issues/pm-qw1uw6.toon),
[pm-e3gn0z](../.agents/pm/issues/pm-e3gn0z.toon), and
[pm-wlqxg3](../.agents/pm/tasks/pm-wlqxg3.toon).

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

Salvage requires a nonempty, hash-verified prefix and retains its bytes unchanged.
The receipt records the first invalid physical line, discarded UTF-8 byte count,
discarded-suffix SHA-256, and retained record count. An appended `history_salvage`
event records that receipt without copying potentially private damaged contents.
Salvage does not rehash prior entries, reconcile item state, or normalize
provenance. It refuses bulk selection, conflicting repair modes, merge conflict
markers, parseable records after corruption, and potentially complete records
with attached corruption. Recover those cases from version control or a backup.
Non-UTF-8 streams are also refused, so receipt hashes and rollback snapshots
always describe the original bytes rather than a lossy decoded approximation.

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

## Permanent item identities

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
