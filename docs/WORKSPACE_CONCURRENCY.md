# Concurrent Workspace Mutations

Tracked by [pm-bgcu](../.agents/pm/issues/pm-bgcu.toon). Power-loss durability is
governed by [pm-o2kc](../.agents/pm/epics/pm-o2kc.toon).

The CLI and MCP use the SDK's persistence primitives. Atomic replacement makes
one file write indivisible, but preserving concurrent edits also requires
protecting the read and decision that precede that write.

## Settings snapshots

`readSettings` attaches an internal, non-enumerable persistence snapshot.
`writeSettings` compares the caller's edited snapshot with the latest document
while holding the `workspace-history` lock. Changes to different object keys
are combined, including separate keys in a newly introduced nested object.
Unchanged keys keep the current persisted values; sparse defaults and
file-backed schema definitions remain sparse.

Concurrent incompatible edits to the same scalar, array, or deleted object
return a conflict before writing. Read a fresh settings snapshot and reapply
the intended operation. Equal concurrent changes are idempotent. A successful
write advances that instance's baseline, so reusing it cannot replay an earlier
edit over another writer. Conflict messages name keys without exposing values.
Deleting the settings document also invalidates an unchanged read snapshot;
its next write returns the same structured conflict.

Keep the object returned by `readSettings` when editing settings. Constructing
a new object, spreading it, or using `structuredClone` drops the internal
snapshot; `writeSettings` treats such objects as explicit whole-document
replacements. They are suitable for initialization, not concurrent edits.

The same lock protects the persisted document, its workspace history entry,
and compensation if history append fails. This prevents concurrent writers
from forking the chain or leaving an accepted write unrecorded. It does not
claim crash atomicity across separate filesystem writes.

## Schema, session, and rollback state

Schema mutations hold the existing `schema-types`, `schema-statuses`, or
`schema-fields` lock while reading and modifying their file. Profile application
uses the same lock order. Bootstrap stages complete seed bytes and publishes
them through a non-replacing hard link: a concurrent schema writer or reader
can never be overwritten by a delayed bootstrap. A filesystem that refuses
hard links returns an error instead of falling back to an unsafe overwrite.

Focus and semantic attribution share the `session-state` lock across the full
read-modify-write operation. Independent agents retain their attribution while
focus changes. This state remains local and ephemeral.

Rollback checkpoints use the same atomic, non-replacing publication as schema
seeds. Filesystem identity also protects paths reached through symlink aliases.
A byte-identical retry succeeds; reusing an ID for different contents fails without
replacing the original rollback evidence. Different checkpoint paths remain
independent.

Atomic publication guarantees complete visible bytes and prevents replacement.
It does not flush file data or directory entries to stable storage, so success
does not guarantee survival of power loss. A stronger durability policy must
cover all writers, newly created ancestor directories, retry acknowledgements,
and supported filesystems; syncing only this publication path would not establish
that workspace-wide guarantee.

The mutation locks use the existing bounded contention and stale-owner recovery
mechanism. Settings use configured lock TTL and wait values. Internal session
locks use the standard defaults; `PM_LOCK_WAIT_MS` still
overrides their wait budget. Every acquired lock is released on success and
failure.
