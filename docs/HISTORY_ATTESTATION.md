# History algorithms and detached attestations

Tracking: [pm-bbk8we](../.agents/pm/issues/pm-bbk8we.toon),
[pm-3z0k](../.agents/pm/features/pm-3z0k.toon).

A detached attestation commits to the exact bytes of every retained history
stream. Keep the bundle, or its workspace digest, independently of the tracker.
Verification can then detect a rewritten stream even when its author recomputed
an internally valid hash chain.

## CLI

```sh
pm history attest --output proof.json
pm history attest --verify proof.json
pm history attest --hash-algorithm sha512 --output proof-sha512.json
```

Export with `--output` creates a new JSON file exclusively and returns a compact
receipt containing its path, workspace digest, and stream count. Existing files
are not overwritten. Without `--output`, export writes the complete JSON bundle
to stdout. Proof bytes bypass default row projection and output budgets so a
redirected artifact retains its digest. Explicit universal output controls such
as `--output-limit` are rejected. `--quiet` suppresses stdout. Verification returns a nonzero process
exit status if any stream changed, appeared, disappeared, or failed validation.
`--verify` cannot be combined with export options.

Only the tracker directory and its `history/*.jsonl` files are needed. For a
bare history copy, select the directory containing `history`:

```sh
pm --pm-path /path/to/copied-tracker history attest --verify proof.json
```

Item files, settings, indexes, extensions, and the original Git checkout are not
needed. The verifier does not acquire tracker locks or create derived state.
CLI attestation invocations disable extension loading automatically.

## SDK

```ts
import {
  exportAttestation,
  parseHistoryAttestation,
  verifyAttestation,
} from "@unbrained/pm-cli/sdk/governance";

const proof = await exportAttestation({
  pmRoot: "/path/to/tracker",
  hashAlgorithm: "sha256",
});
const parsed = parseHistoryAttestation(proof);
const result = await verifyAttestation(parsed, {
  pmRoot: "/path/to/copied-tracker",
});
```

The same APIs are available from the SDK root. `generatedAt` optionally accepts
an RFC 3339 timestamp with millisecond precision for reproducible exports.
Equal stream bytes, options, and timestamps yield identical bundle digests.
`PmClient.historyAttest` and `runAction({ action: "history-attest", ... })` expose
the filesystem adapter used by CLI and MCP. Direct export and verify functions
accept and return typed bundles without requiring a proof file.

## Version 1 wire format

`PM_HISTORY_ATTESTATION_CONTRACT` is exported from the SDK contracts entrypoint.
The JSON document has exactly these fields:

| Field | Meaning |
| --- | --- |
| `format` | Literal `pm-history-attestation` |
| `version` | Integer `1` |
| `hash_algorithm` | `sha256` or `sha512`, for bundle commitments |
| `generated_at` | Exporter's asserted timestamp |
| `streams` | Complete retained stream inventory, sorted by ID |
| `workspace_digest` | Digest of the stable JSON encoding of all other fields |

Each stream contains its filename stem, exact byte length, nonblank record count,
exact-byte digest, latest item-state and whole-record anchors, latest record
algorithm, retained rewrite-evidence count, compact checkpoint digest, and last
maintenance marker. Empty streams have null anchors and no maintenance marker.
The workspace stream and streams belonging to deleted items are included.
Identifiers contain only ASCII letters, digits, underscores, and hyphens.
No item content, author, filesystem root, or patch value is embedded in a bundle.
The bundle grows with the number of streams, not their event counts.

Stream digests hash all file bytes, including blank lines, whitespace, and line
endings. Thus a formatting-only change is also a divergence. The workspace
rollup uses the SDK's recursive stable JSON encoding with sorted object keys
and preserved array order, excluding only `workspace_digest`. Stream ordering
uses ascending JavaScript code-unit comparison of IDs, not locale collation.
Lowercase hexadecimal digest lengths are 64 for SHA-256 and 128 for SHA-512.

Verification validates the bundle schema and rollup before inspecting files.
It reports `changed_streams`, `missing_streams`, `added_streams`, and
`invalid_streams`; these categories may overlap. `transitions` includes before
and after byte digests plus the current last maintenance marker for each changed
stream. Export refuses invalid streams instead of producing partial evidence.
Unknown format versions and algorithms are rejected.

## Record algorithms and migration

Each new history entry names `hash_algorithm`. This label selects the digest
used for `before_hash`, `after_hash`, and `record_hash`. Current writers default
to `sha256`; callers constructing entries may explicitly select `sha512`.
The immutable record digest covers the algorithm label itself.

An absent label **always means SHA-256**, regardless of future writer defaults.
Existing unlabeled history remains verifiable without rewriting it. A stream
may mix algorithms: replay reconstructs the prior state and verifies each link
using that entry's declared algorithm. Adjacent bare digest strings need not be
equal when algorithms differ. Unknown labels fail verification even on legacy
entries without whole-record seals.

`item_hash_version` selects canonical item encoding and remains separate from
`hash_algorithm`. The item document `format_version` does not change for this
additive history field. `record_hash_version: 1` still defines stable record
encoding; the algorithm field defines the digest. Older readers lacking the
algorithm capability cannot verify SHA-512 entries and should be upgraded
before such entries are introduced. No automatic archive migration is needed.

Retained rewrite evidence carries the original entry's algorithm. Repair,
redaction, merge reconciliation, and compaction preserve verifiable original
algorithm commitments where they retain evidence. Version 1 patch digests and
compact pruned-prefix commitments remain explicitly fixed to SHA-256; they are
separate commitments, not item-state or record digests.

Advancing the default affects future writes only. Never infer an unlabeled
record's algorithm from digest length or the current default, and never rewrite
an archive simply to add labels. Bundle algorithms are independent of record
algorithms: a SHA-256 bundle can cover SHA-512 records and vice versa. Existing
bundles retain their declared verification algorithm. Re-export after an
intentional append or maintenance operation, review the reported transition,
and retain both proofs if historical comparison matters.

## Trust and consistency

A self-consistent bundle is not a digital signature or a trusted timestamp. It
does not identify an author, prove that events happened in the real world, or
recover a pruned prefix. If an attacker can replace both tracker and trusted
bundle, these hashes do not establish authenticity. Packages can anchor the
workspace digest in an independent repository, signing service, or transparency
log without changing this baseline format.

Verification establishes equality with the retained proof and checks each
current stream's internal replay integrity. It does not assert that current
item files match history, or that every intended mutation was recorded. Use
normal workspace validation for those checks.

The scanner takes a snapshot per stream and checks filename inventories and
file metadata again before returning. Observable concurrent changes fail with
a retry error. This is not a transaction across independent writers; use a
quiescent or externally snapshotted copy when a single workspace-wide instant
is required. Symlink stream files and malformed UTF-8/JSONL are invalid.
