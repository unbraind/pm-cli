# Actionable item-read evidence

Trackers: [pm-gh1388](../.agents/pm/issues/pm-gh1388.toon),
[pm-gh1389](../.agents/pm/issues/pm-gh1389.toon),
[pm-gh1409](../.agents/pm/issues/pm-gh1409.toon).

The public SDK item query supplies the same evidence to CLI and MCP callers.
Standard and deep current reads include a `blockers` facet when the item declares
prerequisites through its legacy `blocked_by` scalar or `blocked_by` dependency
edges. `blockers.open` supplies each nonterminal target's ID, title and status;
`blockers.closed_count` counts terminal targets using the runtime status registry.
Repeated scalar/edge references are deduplicated by the shared actionability
primitive. Missing targets and external references remain unresolved, with null
status, so they cannot silently authorize work.
Short local references resolve to their verified full IDs and count once even
when both forms are stored. Rows under `open` are unresolved by definition;
they omit the redundant `resolved: false` flag while retaining resolver context.
Local comparison keys ignore case for deduplication, while filesystem lookups
retain the declared spelling. Imported mixed-case IDs therefore resolve to their
live status on both case-sensitive and case-insensitive filesystems without
weakening the embedded-identity check.
Legacy text that is not a portable filename remains unresolved and never causes
a lookup outside the registered item folders.
A target file with a different embedded item identity refuses the read with an
identity conflict rather than borrowing an unrelated item's terminal status.
Physical filename recovery gives an exact leaf precedence and sorts equally
preferred case aliases deterministically. A directory-read failure refuses the
query with `blocker_identity_read_failed` and access-restoration guidance. The
public SDK retains the original error as its cause; the read never invents a
missing prerequisite or changes item/history bytes. Native case-insensitive
fixtures intentionally share a physical destination, while case-sensitive
fixtures retain colliding leaves and exercise the same identity refusal.

`blockers.scope` is `declared`: the facet resolves forward declarations from this
item, without enumerating unrelated items. Reverse `blocks` relationships require
a corpus graph or actionability query. The stored scalar remains a compatibility
field and identifies only the last scalar value. Standard reads replace that
partial scalar with the complete declared facet; `--fields blocked_by` and
`--full` retain access to the stored scalar. Storage and provenance are preserved.
Ordinary dependency rows retain `id` and `kind`; `--full`, `--depth full`, and
`--fields dependencies` restore the stored timestamp and author/source columns.
The `dependency_provenance` omission receipt names `--fields dependencies` as the
narrow restoration. This presentation change preserves every stored edge.
The receipt describes attribution actually withheld by the selected projection.
Legacy rows with no timestamp remain complete under full or explicit reads;
following the restoration never invents a timestamp or repeats a false omission.
Rows containing only identities and kinds have no attribution to withhold.
Field selection takes precedence when combined with `--depth full`: a narrow
selector still discloses withheld attribution, while selecting `dependencies`
restores its complete stored rows.

```bash
pm get <id>
pm get <id> --depth brief
pm get <id> --fields blockers
```

Brief and selected reads disclose material withheld blocker evidence with the
compact `--full` restoration. Use `--fields blockers` for the narrow facet alone;
`item.blockers` is an equivalent selector.
Historical reads preserve historical metadata and omit current blocker status.
An explicit historical blocker projection refuses with current-read guidance,
because a present-day target status cannot certify a past prerequisite state.

Omission receipts account for what the result actually renders. A reminder or
event supplied through `schedule.reminders` or `schedule.events` is included even
when its metadata alias is absent. Nonempty files, tests and docs rendered under
`linked` are included too. Narrow selectors continue to disclose unselected
material members; the stable linked envelope's empty placeholders do not certify
that unrequested artifact contents were returned.

```bash
pm get <id> --fields schedule.reminders
pm get <id> --fields linked.tests
```

The regression suite creates actual disposable tracker data and checks open,
terminal, custom-terminal, missing and external prerequisites; brief restoration;
historical separation; and independent schedule/artifact alias projections.
No source tracker, mocked resolver or suppressed drift check is involved.
