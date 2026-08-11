# Dependency-kind contract

Tracker: [pm-4020c5](../.agents/pm/issues/pm-4020c5.toon), [pm-jkbqt8](../.agents/pm/issues/pm-jkbqt8.toon), [pm-q6n8sj](../.agents/pm/issues/pm-q6n8sj.toon)

Dependency rows have one canonical stored spelling per relationship meaning. Command inputs remain compatibility-friendly: hyphens normalize to underscores and the aliases below are accepted, but `pm create` and `pm update` persist the canonical kind. Existing historical rows are never rewritten implicitly.

| Canonical kind | Accepted legacy aliases                |
| -------------- | -------------------------------------- |
| `blocked_by`   | `depends_on`, `depends-on`             |
| `related`      | `related_to`, `related-to`             |
| `parent`       | `child_of`, `child-of`, `epic`         |
| `child`        | `parent_child`, `parent-child`, `task` |

`epic` and `task` are compatibility aliases, not item types embedded in the relationship ontology. New integrations should use `parent` or `child` and express the work classification through the item `type` field.

The SDK relationship registry is authoritative. `canonicalizeRelationshipKind()` rejects unknown spellings, while `resolveCanonicalRelationshipKind()` supports validation flows that need an undefined result. `pm contracts` publishes `relationship_kind_contracts` with canonical names, aliases, inverses, and ordering/hierarchy semantics.

## Direction and actionability

`blocked_by` and `blocks` are inverse storage directions with identical scheduling meaning:

- `A --blocked_by--> B` means A waits for B.
- `B --blocks--> A` means A waits for B.

Readiness, `pm next`, context blocker summaries, `pm list-blocked`, downstream `unblocks` projections, and close-time auto-unblock use that shared interpretation. This applies to mixed-direction corpora without migrating existing rows.

## Legacy observability

`pm deps` returns `legacy_alias_counts` for the workspace. `pm graph audit` returns the same field beside canonical `profile.edges_by_kind` counts, `profile.edge_share_by_kind` composition ratios, and the `semantic_edges`/`semantic_edge_share` context-preservation census. The semantic census counts `discovered_from`, `incident_from`, `supersedes`, and `verifies` over all deduplicated directed edges. Empty objects and zero shares are explicit, not omitted. These diagnostics are read-only; terminal history remains untouched until an explicitly governed migration is requested.

Assurance `dependency_kind` measurements canonicalize both the declaration and stored row before comparing. A declaration using `related` and one using the accepted `related_to` alias therefore measure the same edge population; alias debt remains separately observable through `legacy_alias_counts`.
