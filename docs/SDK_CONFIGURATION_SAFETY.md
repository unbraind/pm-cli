# SDK Configuration and Diagnostic Safety

Trackers: [pm-gh1394](../.agents/pm/issues/pm-gh1394.toon), [pm-gh1393](../.agents/pm/issues/pm-gh1393.toon), [pm-gh1392](../.agents/pm/issues/pm-gh1392.toon), [pm-gh1398](../.agents/pm/issues/pm-gh1398.toon).

Package authors use the host-injected `context.sdk` services to change project
configuration. The SDK owns settings normalization, locking, immutable audit
history, retry identity, and dry-run behavior. See [SDK](SDK.md) and
[Packages and Extensions](EXTENSIONS.md) for the broader authoring contract.

## Explicit Settings Ownership

`mutateWorkspaceSettings` preserves unknown source fields by default. A package
that replaces a complete settings object can explicitly declare the objects it
owns with `replaceSubtrees`:

```ts
await context.sdk!.mutateWorkspaceSettings({
  operationId: "apply-governance-policy",
  replaceSubtrees: ["governance"],
  includePreview: true,
  dryRun: context.options.dryRun === true,
  mutate: (current) => ({
    ...current,
    governance: { ...current.governance, preset: "minimal" },
  }),
});
```

The selected object is replaced by its normalized serialized value, removing
unknown raw keys omitted from the callback's result. Unselected source fields,
including future root fields and sibling objects, are preserved. Dot-delimited
paths such as `search.rerank` select nested objects. Missing ancestors are
materialized with their canonical settings so the complete persisted document
remains valid. Scalar, array, unknown, and prototype paths are rejected before
writing. Declare ownership only for configuration the package is authorized to
replace. An empty ownership list retains the default preservation behavior.

Replacement runs inside the same settings lock and history transaction as the
callback. Dry runs write no settings or workspace history; retries with the same
operation identity skip the callback after a successful commit. Fresh semantic
no-ops preserve the existing bytes and produce no history event.

The optional `preview` describes normalized inline settings resolved from the
exact proposed bytes. Preset-derived values can be omitted from serialized JSON
and reconstructed in the preview. File-backed schema overlays and unknown raw
keys are outside this normalized preview. Inspect the persisted document when
raw-source information is needed.

## Read-only Package Freshness

`pm package explore`, `doctor`, and `manage` preserve managed installation state.
`manage` checks GitHub revisions and npm registry identities transiently; it
does not rewrite `.managed-extensions.json`, reorder its contribution inventory,
or advance its modification time. Install, update, and explicit adoption own
managed-state persistence. `--fix-managed-state` remains an explicit adoption
mutation.

```bash
pm package manage --project --json
pm package manage --project --offline --json
```

For npm sources the SDK compares the recorded package version with the configured
registry's `latest` dist-tag, honoring npm registry configuration. A different
dist-tag version reports `update_available: true`; this is a channel comparison,
including an intentional registry rollback. `last_update_remote_version` identifies
the observed registry version. Missing provenance, invalid metadata, and failed
lookups report unknown availability and incomplete health. Lookups are bounded
to ten seconds and 64 KiB. npm execution failures use a stable public diagnostic
code to avoid exposing registry credentials through command stderr. Invalid
installed versions, registry versions, and JSON metadata also use stable reasons
that do not reflect their raw contents.

`--offline` performs no remote freshness lookup and reports `not_checked`,
`offline_requested`, and unknown availability for supported remote sources.
Runtime activation diagnostics still run. A bare installed npm extension name
or recorded package name reuses its managed registry identity on reinstall;
explicit local paths and bundled aliases retain their existing precedence.
For a confirmed missing bare input, npm records match by exact manifest name,
then stored directory, then recorded package identity. A weaker identity match
cannot replace a stronger match because its record appears earlier.
The selected stored package must parse as exactly one registry package name.
URLs, local files, aliases, versioned specs, options, and shell-bearing values
cannot become installation authority through managed metadata; invalid identity
retains local-source recovery. Explicit `npm:` sources still accept their existing
caller-selected package specs. Managed state is local installation provenance
written by lifecycle operations, not permission for arbitrary source execution;
protect project and global extension roots with the invoking account's filesystem
permissions.

## Isolated Schema History

Linked tests using `pm_context_mode=schema` inherit project and global settings
and extensions without inheriting source items. Settings are seeded through the
workspace history writer against each sandbox's own initialized state. Nested
`pm validate --check-history-drift --strict-exit` therefore validates that
sandbox's configuration successfully. Out-of-band sandbox edits still fail
history validation. Tracker context continues to retain the source audit history
and its genuine drift. Source settings and history are never changed by seeding.

## Help Discovery Before Mutation

Bare `--help` and `-h` following declared options are discovery requests:

```bash
pm test pm-example --add --help
pm files pm-example --add -h
pm update pm-example -b -h
pm create --file --help
```

These invocations print help and leave item and history bytes unchanged. To
persist a literal flag-looking value, attach it explicitly: `--add=--help`.
JSON help follows the same discovery policy. Bootstrap normalization preserves
the argv terminator and attached values. The immediately preceding declared
option is neutralized before parsing, regardless of whether its contract has
value metadata. Short options, aliases, and booleans follow the same policy;
no value parser runs for the neutralized option. The original help token stays
reachable even when another adjacent option consumes the replacement token.
Global boolean flags retain their presentation semantics, so `--json --help`
still renders JSON help.
Explicit bare assignments preserve a single value boundary during expansion,
so values such as `body=--help` retain their literal meaning.
