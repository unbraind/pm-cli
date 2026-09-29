# Audited SDK Settings and Item Updates

The extension settings contract is tracked by
[pm-wtqltn](../.agents/pm/issues/pm-wtqltn.toon). Full-item JSON annotation
integrity is tracked by [pm-2589e6](../.agents/pm/issues/pm-2589e6.toon).

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

Supply a stable `operationId` for a logical operation. Retrying an already
recorded operation returns `replayed: true` without appending another history
event. `dryRun: true` calculates `changed` without changing settings or history;
the same operation ID can then be used for the real mutation. A normal return
also reports `changed` and `dry_run`. Invalid results fail before writing, and
a history-append failure restores the previous settings bytes. The callback
must derive its complete next settings object from the locked `current` value.

## Full-item JSON updates

`pm update <id> --stdin-json` accepts a full item read document. New comments,
notes, and learnings in that document are appended through the normal item
mutation. Persisted entries are an audit trail: changing or removing one in
the submitted document now fails with
`stdin_json_persisted_annotation_changed` before any item fields are written.
This check also applies when the only submitted change is an annotation. Use
`pm comments`, `pm notes`, or `pm learnings` with `--edit` to correct an
existing entry; those commands write a history event for the correction.
