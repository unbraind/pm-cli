# Dependency-kind contract

Tracker: [pm-4020c5](../.agents/pm/issues/pm-4020c5.toon), [pm-jkbqt8](../.agents/pm/issues/pm-jkbqt8.toon), [pm-q6n8sj](../.agents/pm/issues/pm-q6n8sj.toon), [pm-ouyq3n](../.agents/pm/issues/pm-ouyq3n.toon), [pm-gos426](../.agents/pm/issues/pm-gos426.toon), and [pm-flnefm](../.agents/pm/issues/pm-flnefm.toon).

Dependency rows have one canonical stored spelling per relationship meaning. Command inputs remain compatibility-friendly: hyphens normalize to underscores and the aliases below are accepted, but `pm create` and `pm update` persist the canonical kind. Existing historical rows are never rewritten implicitly.

| Canonical kind | Accepted legacy aliases                |
| -------------- | -------------------------------------- |
| `blocked_by`   | `depends_on`, `depends-on`             |
| `related`      | `related_to`, `related-to`             |
| `parent`       | `child_of`, `child-of`, `epic`         |
| `child`        | `parent_child`, `parent-child`, `task` |

`epic` and `task` are compatibility aliases, not item types embedded in the relationship ontology. New integrations should use `parent` or `child` and express the work classification through the item `type` field.

The SDK relationship registry is authoritative. `canonicalizeRelationshipKind()` rejects unknown spellings, while `resolveCanonicalRelationshipKind()` supports validation flows that need an undefined result. `pm contracts` publishes `relationship_kind_contracts` with canonical names, aliases, inverses, and ordering/hierarchy semantics.

Dependency additions and removals share the same lossless input grammar. A
bare value is an item id; structured input uses `id=<id>` plus an optional
canonical `kind`/`type` and `source_kind`. Punctuation-shaped shorthand such as
`OTHER,related` is rejected with `dependency_flag_value_invalid` on both
`--dep` and `--dep-remove`, before prefix normalization can turn it into a
dangling id. A removal selector that matches no stored row fails with
`dependency_remove_no_match` and returns the unmatched selectors plus compact
available identities. Re-adding a stored dependency identity is idempotent; if
legacy storage contains that exact identity more than once, the same mutation
collapses the touched copies to one without creating an edge-absence window.

`recurs_from` has no alias: a later occurrence points to an earlier occurrence.
It is persistent after both items become terminal and carries temporal identity,
not execution precedence. `supersedes` keeps replacement semantics, while
`duplicate_of` remains item-level record identity rather than an edge between
distinct events. Local create, update, and update-many mutations compare the
endpoint `created_at` values before persistence and reject equal or reverse
chronology with `dependency_temporal_order_invalid`; explicit cross-workspace
references remain external because their target metadata is not locally
available.

## Direction and actionability

`blocked_by` and `blocks` are inverse storage directions with identical scheduling meaning:

- `A --blocked_by--> B` means A waits for B.
- `B --blocks--> A` means A waits for B.

Readiness, `pm next`, context blocker summaries, `pm list-blocked`, downstream `unblocks` projections, and close-time auto-unblock use that shared interpretation. This applies to mixed-direction corpora without migrating existing rows.

## Legacy observability

`pm deps` returns `legacy_alias_counts` for the workspace. `pm graph audit` returns the same field beside canonical `profile.edges_by_kind` counts, `profile.edge_share_by_kind` composition ratios, and the `semantic_edges`/`semantic_edge_share` context-preservation census. The semantic census counts `discovered_from`, `incident_from`, `recurs_from`, `supersedes`, and `verifies` over all deduplicated directed edges. Empty objects and zero shares are explicit, not omitted. These diagnostics are read-only; terminal history remains untouched until an explicitly governed migration is requested.

Assurance `dependency_kind` measurements canonicalize both the declaration and stored row before comparing. A declaration using `related` and one using the accepted `related_to` alias therefore measure the same edge population; alias debt remains separately observable through `legacy_alias_counts`.
