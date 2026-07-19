# Multi-Branch Tracker Merge Safety

Tracked by [pm-wc1r](../.agents/pm/features/pm-wc1r.toon), with the integrity and concurrency fixes [pm-9q2t](../.agents/pm/issues/pm-9q2t.toon), [pm-cxyv](../.agents/pm/issues/pm-cxyv.toon), [pm-gpo7](../.agents/pm/issues/pm-gpo7.toon), [pm-m3nl](../.agents/pm/issues/pm-m3nl.toon), [pm-wwfd](../.agents/pm/issues/pm-wwfd.toon), and [pm-xdn6](../.agents/pm/issues/pm-xdn6.toon).

pm stores project context as reviewable repository files. Concurrent agents can therefore use ordinary branches and worktrees, but tracker artifacts need semantic merge behavior: raw line merging cannot preserve TOON collection counts, JSON object structure, or append-only history hash chains.

## Install the repository merge contract

Run this once per clone after `pm init`:

```bash
pm merge install
git add .gitattributes
git commit -m "chore(pm): install tracker merge drivers"
```

`pm merge install` writes an idempotent, fenced `.gitattributes` block and repository-local `git config` entries. The attributes are committed; the driver commands are clone-local, so every collaborator and fresh CI clone that performs merges must run the install command. Re-run it after adding custom item types so their folders are included.

Preview without mutation:

```bash
pm merge install --dry-run --json
```

## Artifact semantics

| Artifact | Driver | Merge behavior |
| --- | --- | --- |
| Item `.toon` / `.md` | `pm-item` | Three-way field merge; append-like collections use set union, `updated_at` uses latest timestamp, canonical serialization recomputes TOON counts. |
| `history/*.jsonl` | `pm-history` | Preserves the common prefix and both divergent suffixes, orders deterministically, then re-anchors the resulting hash chain. |
| `settings.json`, `schema/*.json` | `pm-json` | Recursively merges objects per key; disjoint settings changes compose without a whole-file conflict. |

When both sides change the same scalar or JSON leaf differently, the driver writes a parseable preferred-side result but exits nonzero. Git keeps the path conflicted so a human or coordinating agent must review the losing value and explicitly `git add` the resolution. Use `--prefer theirs` only when that is the intended resolution policy.

The underlying public SDK exports are `mergeItemDocuments`, `mergeHistoryStreams`, `mergeJsonDocuments`, `runMergeDriver`, and `runMergeInstall` from `@unbrained/pm-cli/sdk`. Hosts can embed the same semantics without shelling out.

## Required post-merge gate

After every branch merge that touches `.agents/pm`, run:

```bash
pm validate --check-history-drift --strict-exit
pm history <item-id> --verify --strict-exit
```

The default validation surface includes `storage_integrity`. It fails on unreadable item documents, history conflict markers, malformed history tails, live items whose latest history operation is `delete` (a delete/modify resurrection candidate), and unparseable settings/schema files. This prevents the ordinary tolerant read path from turning corruption into a green gate.

A history union can be structurally valid while replayed history and the chosen item document describe different effective state. In that case inspect both authors' events before reconciliation, then run the audited repair:

```bash
pm history <item-id> --verify --strict-exit
pm history-repair <item-id> --dry-run
pm history-repair <item-id>
pm validate --check-history-drift --strict-exit
```

`history-repair` records the reconciliation patch and surfaces discarded event authors/operations when the on-disk document would otherwise revert effective merged history. Re-apply any intended losing mutation as a normal `pm update` so it remains explicit and auditable.

## Delete versus modify policy

A delete on one branch and an edit on another is not safely resolvable by a generic file driver. The merged workspace must not silently resurrect the item. `storage_integrity` reports the live document plus delete-terminated history as a hard finding. The coordinator chooses one policy explicitly:

- Honor deletion: remove the live item document, keep its append-only history, and commit the resolution.
- Honor modification: restore/recreate through pm so the history contains an explicit post-delete operation and rationale.

Never remove conflict markers manually while leaving the authoritative item and history semantically inconsistent.

## Runtime receipts and retention

`transactions/` and `checkpoints/` are per-branch crash-recovery state, not shared project context. `pm init` places both below the resolved tracker root in the managed `.gitignore` block, including custom `--pm-path` roots.

Terminal SDK transaction journals use the same `checkpoints.retention_days` policy as rollback checkpoints. The default GC sweep includes both receipt classes:

```bash
pm gc --dry-run
pm gc --scope transactions --dry-run
pm gc --scope transactions
```

Only aged `committed` or `compensated` journals are removed. `applying`, `compensating`, unreadable, and unparseable journals are always retained so cleanup cannot destroy live recovery state.

## Temporary-clone acceptance test

Before releasing merge-contract changes, validate the packed package in a temporary Git repository: initialize pm, install the merge contract, create one base item, branch twice, append disjoint metadata/history on both branches, merge, and run the strict validation commands above. Include a same-key conflict case and prove Git leaves it unresolved while the output remains parseable.
