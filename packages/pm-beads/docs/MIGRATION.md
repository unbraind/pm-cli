# Beads Migration

Tracker: [pm-tpwde6](../../../.agents/pm/issues/pm-tpwde6.toon)

## Lossless portable-backup migration

Install the package, create a current Beads portable backup, and import the
backup directory without modifying the source project:

```bash
pm package install ./packages/pm-beads --project
bd backup --force
pm beads import --backup-dir .beads/backup --preserve-source-ids
```

Current Beads backups contain relational `issues.jsonl`, `comments.jsonl`,
`events.jsonl`, `dependencies.jsonl`, and `labels.jsonl` files plus
`backup_state.json`. The importer validates those files, their foreign keys,
the backup counts, source-ID collisions, and every issue before the first pm
write. Structural source failures therefore cannot leave a partially imported
tracker; each later item commit also retains pm's normal lock and rollback
guarantees.

Successful output includes `complete: true`, source and imported counts for
each relation, and an exact `id_mapping`. Source IDs are preserved only when
they are safe path identifiers and do not collide case-insensitively with one
another or with the target tracker. Comments remain comments, Beads events are
stored as structured JSON notes, dependencies and labels retain their source
identity, and a terminal Beads close reason becomes the pm resolution when no
explicit source resolution exists.

Verify representative records and the final tracker after import:

```bash
pm get Tokenwerk-A1
pm comments Tokenwerk-A1
pm validate --check-resolution --check-history-drift
```

## Legacy single-file import

Older JSON/JSONL exports with embedded `comments`, `events`, `dependencies`,
and `labels` remain supported:

```bash
pm beads import --file .beads/issues.jsonl
```

A current plain `bd export` that advertises `comment_count` but omits comment
bodies is intentionally rejected before any write. Run `bd backup --force` and
use `--backup-dir` instead so the migration cannot silently lose discussion or
event history.
