# SDK Evidence Traceability and Integrity

Tracker references: [pm-f86lth](../.agents/pm/features/pm-f86lth.toon), [pm-cstuys](../.agents/pm/issues/pm-cstuys.toon), [pm-jb1ron](../.agents/pm/issues/pm-jb1ron.toon), [pm-2irc1p](../.agents/pm/issues/pm-2irc1p.toon), and [pm-u5c27w](../.agents/pm/issues/pm-u5c27w.toon).

This contract turns linked evidence into a bidirectional context primitive. Items can continue to declare the files that explain their implementation, while agents and packages can resolve a source path back to its owning work without scanning tracker files at indexed scale.

## Reverse source lookup

Use `pm files lookup` with one or more project-relative or absolute paths:

```bash
pm files lookup src/sdk/files.ts
pm files lookup src/sdk/files.ts docs/SDK_EVIDENCE_TRACEABILITY.md --limit 20
pm files lookup /absolute/project/src/sdk/files.ts --scope project --strict-read --json
```

The command normalizes in-project absolute paths to project-relative paths, deduplicates targets, and returns referencing items in deterministic priority, update-time, and ID order. The default result limit is 50. Use `--offset` for bounded pagination or `--no-truncate` for an authoritative unbounded source scan.

Every response includes:

- `paths`, `total`, `count`, `offset`, `limit`, `has_more`, and `truncated`;
- a compact item identity plus only the linked-file records that matched;
- `completeness.status` as `unchecked`, `complete`, or `partial`;
- `completeness.source` as `index` or `source_scan`; and
- non-fatal source-read `warnings` when completeness is partial.

`--strict-read` fails instead of returning partial source-scan results. Indexed reads are intentionally reported as `unchecked`: they are cursor-bound projections optimized for bounded context retrieval, while strict reads force authoritative item loading.

## SDK and MCP

The public SDK exposes both reusable-client and one-shot forms:

```ts
import { PmClient, filesLookup } from "@unbrained/pm-cli/sdk";

const client = new PmClient({ cwd: process.cwd() });
const fromClient = await client.filesLookup({
  paths: ["src/sdk/files.ts"],
  limit: 20,
});

const oneShot = await filesLookup(
  { paths: ["docs/SDK_EVIDENCE_TRACEABILITY.md"], strictRead: true },
  { cwd: process.cwd() },
);
```

The MCP `files` action uses the same primitive when `lookupPath` is present. `id` remains required for item-local add, remove, discover, and list operations; reverse lookup instead requires one or more `lookupPath` values. Use `pm contracts --command files --flags-only --json` for the active machine contract.

SDK hosts that manage authoritative item writes directly can use `queryLinkedFileMetadataIndex` from the public item-metadata-index surface. The reverse projection is rebuilt from linked-file collections and updated in the same derived-index writer section as normal metadata deltas. A missing, stale, corrupt, or extension-incompatible index must fall back to authoritative reads.

## Atomic evidence replacement

`pm update` and `pm update-many` support atomic replacement for files and docs, matching the established dependency and test contracts:

```bash
pm update <id> \
  --file path=src/new.ts,scope=project,note="current implementation" \
  --replace-files \
  --doc path=docs/new.md,scope=project,note="current contract" \
  --replace-docs
```

Replacement requires at least one corresponding `--file` or `--doc` value and cannot be combined with its clear flag. Validation occurs before mutation, so invalid replacement requests do not partially clear evidence. Ownership bypasses continue to reject replacement operations.

Repeating an already-present `pm files --add` or `pm docs --add` batch is a true no-op: `changed` is false, the item file is not rewritten, and append-only history receives no synthetic mutation entry.

Audited history redaction participates in the same projection transaction as
ordinary item mutation. After rewriting an item and its history stream, pm
invalidates drift verification state and incrementally refreshes the metadata
index before releasing the derived-index lock. A warmed index therefore cannot
pair pre-redaction item content with post-redaction history during validation.

## Operational receipts

Linked tests recognize compound acquisition failures such as “could not acquire … lock” together with contention context such as “already running” or “held by another” as `infra_collision`. Generic assertion text mentioning a lock or timeout remains `assertion_failure`, preventing false infrastructure classifications.

Telemetry flush receipts distinguish progress from completion:

- `queue_entries_drained` is the exact valid-entry delta;
- `queue_progressed` means at least one entry was removed;
- `queue_empty` means no valid entries remain; and
- compatibility field `queue_drained` is equivalent to `queue_empty`, never merely “the queue got smaller.”

Packages should use `queue_empty` when a workflow requires complete delivery and `queue_progressed` when partial forward progress is sufficient.

Duplicate similarity treats the complete external issue code as identity. Codes
such as `BD-30-A` and `BD-30-B` are distinct sibling work and receive only their
ordinary title-token similarity; exact repetitions of the full code retain the
strong `issue_code` signal. This keeps duplicate-close guidance from collapsing
decomposed work that shares a numeric family prefix.
