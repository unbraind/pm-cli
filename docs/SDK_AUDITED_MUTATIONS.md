# Audited SDK Settings and Item Updates

The extension settings contract is tracked by
[pm-wtqltn](../.agents/pm/issues/pm-wtqltn.toon). Full-item JSON annotation
integrity is tracked by [pm-2589e6](../.agents/pm/issues/pm-2589e6.toon).
Canonical previews are tracked by [pm-2sef82](../.agents/pm/features/pm-2sef82.toon).

## Extension settings

An extension command receives a host-bound `sdk` in its `run` context. Use
`sdk.mutateWorkspaceSettings` to change the current project's `settings.json`.
The host chooses the tracker path and author, validates the complete result,
serializes concurrent changes under the workspace lock, and records the change
in workspace history. A copied extension needs no local SDK installation.

```ts
api.registerCommand({
  name: "example hints",
  flags: [{ long: "--operation-id", value_name: "id", value_type: "string" }],
  run: ({ sdk, options }) =>
    sdk.mutateWorkspaceSettings({
      operationId: options.operationId,
      mutate: (current) => ({
        ...current,
        ux: { ...current.ux, deprecation_hints: true },
      }),
    }),
});
```

Supply a stable `operationId` for a logical operation within its registered
command. The host scopes the ID to that command, so another command can use
the same ID independently. Retrying an already recorded operation returns
`replayed: true` without invoking `mutate`, writing settings, or appending
another history event. `dryRun: true` calculates `changed` without changing settings or history;
the same operation ID can then be used for the real mutation. A normal return
also reports `changed` and `dry_run`. Invalid results fail before writing, and
a history-append failure restores the previous settings bytes. The callback
must derive its complete next settings object from the locked `current` value.
The callback receives normalized inline settings with defaults and preset knobs
even when the source file is sparse. Returning that tree unchanged retains the
original source bytes, including unknown fields, without creating an audit event.
The host also validates the final serialized bytes before committing, so a
proposal that changes while being serialized cannot persist invalid settings.
The host applies the standard settings serializer, including legacy format
coercion and collection-name sanitization, and runs active `onWrite` hooks
after a changed write.

Request `includePreview: true` to receive an optional `preview` settings tree
alongside the receipt. The host resolves it from the exact serialized bytes
inside the audit lock, using the same defaults and governance presets as normal
settings reads. A named `minimal` preset therefore reports ownership `none`
even if the callback proposed `strict`. Custom presets retain their configured
knobs. Legacy formats and collection names reflect their canonical persisted
values. This tree describes inline settings before optional file-backed schema
overlays; it does not load or create those files.

Use `dryRun: true, includePreview: true` to inspect the result before applying
the same operation. A fresh no-op also includes its canonical tree. An idempotent
replay omits `preview`: the original callback is not re-executed, and later
settings changes cannot reconstruct its historical proposal. Receipts remain
three booleans when the option is absent. Direct SDK dry runs read configuration
without executing read hooks, scaffolding optional schemas, or populating the
hydrated settings cache. Mutation callbacks should only derive settings and
avoid external side effects.

## Full-item JSON updates

`pm update <id> --stdin-json` accepts a full item read document. New comments,
notes, and learnings in that document are appended through the normal item
mutation. Persisted entries are an audit trail: changing or removing one in
the submitted document now fails with
`stdin_json_persisted_annotation_changed` before any item fields are written.
This check also applies when the only submitted change is an annotation. Use
`pm comments`, `pm notes`, or `pm learnings` with `--edit` to correct an
existing entry; those commands write a history event for the correction.
