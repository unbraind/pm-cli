# Relationship graph semantics

Tracked by [pm-4jqm](../.agents/pm/decisions/pm-4jqm.toon), [pm-ju83](../.agents/pm/features/pm-ju83.toon), and [pm-6irg](../.agents/pm/issues/pm-6irg.toon).

## Decision

pm uses a hybrid relationship model: a versioned registry defines edge semantics, immutable item/history mutations remain the source of truth, and rebuildable indexes serve bounded graph queries. This preserves the simplicity of item-front-matter storage while giving SDK consumers a labeled-property-graph vocabulary without making arbitrary labels semantically ambiguous.

The alternatives were rejected as follows: a closed enum cannot model applications such as a VCS or company; unrestricted labels cannot safely drive algorithms; event-only traversal is too expensive for interactive context assembly; and index-only state is not auditable or replayable.

## Contract

Each relationship kind declares direction, inverse, ordering and hierarchy participation, incoming and outgoing cardinality, lifecycle, aliases, payload schema, self-edge policy, and compatibility version. Built-ins normalize legacy `related_to`, `depends_on`, `child_of`, `parent_child`, `epic`, and `task` spellings. Unknown custom kinds remain importable only after their definitions are registered, preventing algorithms from guessing their meaning.

Ordering-cycle validation considers only kinds whose registry definition sets `ordering: true`. Associative and provenance edges never block execution. Hierarchy cycles remain a separate structural check. Canonical edge identity includes kind and ordered endpoints for directed edges, or sorted endpoints for undirected edges.

SDK queries are deterministic, bounded, cancellation-aware, and return explicit visited-node, inspected-edge, truncation, and continuation metadata. The first implementation supplies adjacency, incoming and outgoing traversal, closure, shortest path, reverse impact through incoming traversal, and induced subgraphs. The in-memory index is rebuildable directly from item metadata; durable large-workspace indexes remain an interchangeable later storage implementation.

## Compatibility and migration

Aliases normalize at registry boundaries; stored values are not silently rewritten. Imports must carry or select a compatible registry version. Federation merges definitions before edges and rejects identifier or alias collisions. Rollback removes the custom definition and its derived index only after application-owned edges have been exported or superseded; immutable history is retained.

Validation rejects missing endpoints, disallowed self-edges, duplicate canonical edges, cardinality violations at mutation boundaries, ordering-only cycles, and incompatible aliases or versions. Evidence freshness and application payload schemas are extension policy: the core preserves payloads but does not invent domain meaning.

## Consequences and non-goals

CLI and MCP layers can remain thin consumers of the same SDK semantics, and non-PM applications can register domain relationships without patching core enums. The registry does not infer edges, choose relevance weights, mandate a large persistent index for scratch projects, or make distributed conflict resolution automatic.
