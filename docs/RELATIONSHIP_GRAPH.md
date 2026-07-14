# Relationship graph semantics

Tracked by [pm-4jqm](../.agents/pm/decisions/pm-4jqm.toon), [pm-ju83](../.agents/pm/features/pm-ju83.toon), [pm-8xr8](../.agents/pm/stories/pm-8xr8.toon), and [pm-m2il](../.agents/pm/chores/pm-m2il.toon).

## Decision

pm uses a hybrid relationship model: a versioned registry defines edge semantics, immutable item/history mutations remain the source of truth, and rebuildable indexes serve bounded graph queries. This preserves the simplicity of item-front-matter storage while giving SDK consumers a labeled-property-graph vocabulary without making arbitrary labels semantically ambiguous.

The alternatives were rejected as follows: a closed enum cannot model applications such as a VCS or company; unrestricted labels cannot safely drive algorithms; event-only traversal is too expensive for interactive context assembly; and index-only state is not auditable or replayable.

## Contract

Each relationship kind declares direction, inverse, ordering and hierarchy participation, incoming and outgoing cardinality, lifecycle, aliases, payload schema, self-edge policy, and compatibility version. Built-ins normalize legacy `related_to`, `depends_on`, `child_of`, `parent_child`, `epic`, and `task` spellings. Unknown custom kinds remain importable only after their definitions are registered, preventing algorithms from guessing their meaning.

Ordering-cycle validation considers only kinds whose registry definition sets `ordering: true`. Associative and provenance edges never block execution. Hierarchy cycles remain a separate structural check. Canonical edge identity includes kind and ordered endpoints for directed edges, or sorted endpoints for undirected edges.

SDK queries are deterministic, bounded, cancellation-aware, and return explicit visited-node, inspected-edge, truncation, and continuation metadata. The graph kernel supplies adjacency, incoming and outgoing traversal, closure, shortest path, reverse impact through incoming traversal, and induced subgraphs. The in-memory index is rebuildable directly from item metadata; durable large-workspace indexes remain an interchangeable storage implementation.

Ordering kinds also declare precedence. `source_before_target` means the source must execute first; `target_before_source` models dependency-shaped edges such as `blocked_by`. Custom kinds default to source-first for compatibility, but domain packages should declare the direction explicitly. Analytics consume this field and never infer execution meaning from the label.

Hierarchy kinds likewise declare which endpoint is the structural parent. `source_parent` supports domain edges such as company `owns` asset, while `target_parent` preserves item-shaped child `parent` parent storage. Custom hierarchy kinds default to `source_parent`; packages should declare the orientation explicitly when their persisted edge shape differs. Context explanations use this contract instead of inferring ancestry from a kind name.

## Immutable events and snapshots

`RelationshipEventLog` is the storage-independent reference mutation boundary. An append carries a unique event id, stable logical relationship id, action, author, timestamp, and optional optimistic `expectedVersion`. Add and supersede events validate endpoints, registered kinds, self-edge policy, duplicate identity, and incoming/outgoing cardinality before they enter the stream. Remove and supersede require an active logical relationship. No event rewrites an earlier event.

`snapshot({ atVersion })` and `snapshot({ atTimestamp })` replay the immutable stream into an exact `RelationshipGraph`. Event pages use the shared opaque query-cursor contract and bind continuation to the log version, so a caller cannot silently mix snapshots after concurrent writes.

`RelationshipEventStore` is the built-in durable filesystem adapter. It stores validated JSONL at `.agents/pm/relationships/events.jsonl` by default, replays every row through the same registry and cardinality checks on open, and serializes cross-process appends with the tracker lock. Async `currentVersion()`, `snapshot()`, and `page()` reads take the same lock before refreshing, so long-lived readers observe completed appends without torn JSONL tails. Store paths must stay lexically inside a non-symlinked tracker root and cannot traverse symlinked components. Database, replicated-log, and event-bus adapters can persist the same public events and rebuild the same snapshots.

```ts
import { RelationshipEventLog, RelationshipEventStore } from "@unbrained/pm-cli/sdk";

const history = new RelationshipEventLog(["design", "build", "ship"]);
history.append({
  eventId: "evt-001",
  relationshipId: "build-needs-design",
  action: "add",
  edge: { source: "build", target: "design", kind: "blocked_by" },
  author: "planning-agent",
  timestamp: new Date().toISOString(),
  expectedVersion: 0,
});

const current = history.snapshot();
const historical = history.snapshot({ atVersion: 0 });

const durable = await RelationshipEventStore.open({
  pmRoot: ".agents/pm",
  nodes: ["design", "build", "ship"],
});
await durable.append({
  eventId: "evt-002",
  relationshipId: "ship-needs-build",
  action: "add",
  edge: { source: "ship", target: "build", kind: "blocked_by" },
  author: "release-agent",
  timestamp: new Date().toISOString(),
});
```

## Explainable analytics

`analyzeRelationshipExecution` runs exact deterministic topological layering and longest-path analysis only over kinds registered with `ordering: true`. It reports the ready frontier, prerequisite depth, critical path, and genuine strongly connected ordering cycles separately from associative cycles. `analyzeGraphImpact` returns a bounded affected set with an exact shortest explanation path per returned node. `analyzeKnowledgeGraph` reports weak and strong components, intentional-or-unreviewed isolates, and unique-neighbor hubs without assigning an opaque authority score. `compareRelationshipSnapshots` exposes exact temporal edge additions and removals.

Every analytics result identifies its algorithm and edge family. Exact algorithms stay exact when a result is bounded: `truncated` means additional rows exist, not that returned paths or distances are estimates. Future approximations must add their method, seed, freshness, and confidence or error bounds rather than reuse the exact envelope.

## Bounded agent context

`buildRelationshipContext` joins caller-owned compact node details with the graph kernel in one request. The packet includes the root, shortest-distance related nodes, semantic selection reasons (`prerequisite`, `dependent`, `ancestor`, `descendant`, `provenance`, or bounded reachability), root evidence pointers, included edges, explicit work counts, token accounting, omitted counts, and an opaque continuation cursor.

Node, edge, depth, kind, direction, and token bounds are independent. The cursor fingerprint covers semantic filters and traversal shape, so it is rejected when reused for a different root or query. Output remains a plain object suitable for TOON, JSON, JSONL, MCP, or a custom UI; adapters own rendering and do not reimplement traversal.

The native adapter is `pm deps <id> --format context`. It is also available through `PmClient.deps`, `runAction({ action: "deps" })`, and the MCP `pm_deps` tool. `--max-depth`, `--node-limit`, `--edge-limit`, `--token-budget`, and `--cursor` map directly to the public SDK context options; `--summary` keeps only counts. Tree and graph formats remain compatible.

```bash
pm deps pm-example --format context --max-depth 3 \
  --node-limit 20 --edge-limit 40 --token-budget 800
```

```ts
import {
  analyzeRelationshipExecution,
  buildRelationshipContext,
} from "@unbrained/pm-cli/sdk";

const execution = analyzeRelationshipExecution(current.graph);
const packet = buildRelationshipContext(
  current.graph,
  "build",
  [
    { id: "design", title: "Approve design", status: "closed" },
    {
      id: "build",
      title: "Build release",
      status: "open",
      evidence: ["src/release.ts", "test:release"],
    },
    { id: "ship", title: "Ship release", status: "open" },
  ],
  { direction: "both", maxDepth: 3, nodeLimit: 20, tokenBudget: 800 },
);
```

## Compatibility and migration

Aliases normalize at registry boundaries; stored values are not silently rewritten. Imports must carry or select a compatible registry version. Federation merges definitions before edges and rejects identifier or alias collisions. Rollback removes the custom definition and its derived index only after application-owned edges have been exported or superseded; immutable history is retained.

Validation rejects missing endpoints, disallowed self-edges, cardinality violations at mutation boundaries, ordering-only cycles, and incompatible aliases or versions. Immutable graph snapshots deduplicate canonical edges deterministically, retaining the last supplied edge; mutation boundaries may reject duplicates before snapshot construction. Evidence freshness and application payload schemas are extension policy: the core preserves payloads but does not invent domain meaning.

## Consequences and non-goals

CLI and MCP layers can remain thin consumers of the same SDK semantics, and non-PM applications can register domain relationships without patching core enums. The registry does not infer edges, choose relevance weights, mandate a large persistent index for scratch projects, or make distributed conflict resolution automatic.
