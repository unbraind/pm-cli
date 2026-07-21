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
import {
  RelationshipEventLog,
  RelationshipEventStore,
} from "@unbrained/pm-cli/sdk";

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

`buildRelationshipContext` joins caller-owned compact node details with the graph kernel in one request. The packet opens with a counts-first `summary` (root identity and status, root-incident edge counts per semantic family, discovered/returned/omitted node and edge counts, evidence count, and a continuation marker) followed by the root, shortest-distance related nodes, included edges, root evidence pointers, and the cost envelope.

Every returned node is explainable: `role` names its semantic family (`prerequisite`, `dependent`, `ancestor`, `descendant`, `provenance`, or `related`), `via` names the node through which bounded traversal first discovered it, and `reasons` lists the direct classifications for depth-1 nodes or a `"<role> via <node> (depth N)"` chain explanation for deeper nodes. When a node matches several families, `role` picks the deterministic priority order `prerequisite > dependent > ancestor > descendant > provenance > related`.

`meta.completeness` reports result quality: the exact in-memory kernel emits `complete` or `truncated`, and the contract reserves `sampled`, `approximate`, `stale_index`, and `redacted` for index-backed or policy-filtered providers so consumers can branch on one field.

Node, edge, depth, kind, direction, and token bounds are independent. The cursor fingerprint covers semantic filters and traversal shape, so it is rejected when reused for a different root or query. Output remains a plain object suitable for TOON, JSON, JSONL, MCP, or a custom UI; adapters own rendering and do not reimplement traversal.

The native adapter is `pm deps <id> --format context`. It is also available through `PmClient.deps`, `runAction({ action: "deps" })`, and the MCP `pm_deps` tool. `--max-depth`, `--node-limit`, `--edge-limit`, `--token-budget`, `--cursor`, `--direction`, and repeatable or comma-separated `--kind` map directly to the public SDK context options; `--summary` keeps only counts. Unknown `--kind` values fail fast with the registered-kind list instead of silently matching nothing. Tree and graph formats remain compatible.

The context result also enumerates broken references instead of reporting a bare count: `missing_count` counts missing nodes reachable within the same bounded traversal that produced the packet (so it agrees with tree/graph semantics for equal traversal parameters and is documented by `missing_scope: "traversal"`), and `missing_references` lists each dangling declaration inside the packet with its declaring holder, dangling target, kind, source surface, and `legacy_terminal` classification so agents can separate repairable typos on active items from ignorable historical debt. `--edge-limit` caps both returned graph edges and enumerated missing-reference rows; `missing_reference_count` preserves the untruncated declaration total. The root's linked files, tests, docs, and annotation counts are promoted into `evidence` as bounded pointers.

```bash
pm deps pm-example --format context --max-depth 3 \
  --node-limit 20 --edge-limit 40 --token-budget 800 \
  --direction both --kind blocked_by,parent
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

## Semantic traversal and governance

The `@unbrained/pm-cli/sdk` barrel exports registry-aware traversal primitives
for domain packages that need more than generic adjacency:

- `hierarchyAncestors` and `hierarchyDescendants` follow only hierarchy kinds
  and honor each kind's declared parent endpoint.
- `orderingPredecessors` and `orderingSuccessors` follow only order-bearing
  kinds and honor declared precedence, so inverse spellings agree.
- `enumerateRelationshipPaths` returns bounded simple paths with edge evidence,
  cost metadata, cancellation, direction/kind filters, and explicit truncation.

All semantic walks are breadth-first and deterministic. `limit`, `maxDepth`,
and `after` provide bounded continuation for hierarchy and ordering walks;
path enumeration separately bounds returned paths and expanded partial paths.
Unknown kinds and cursors fail fast instead of silently degrading context.

`assembleWorkspaceRelationshipGraph` is the shared normalization seam for
dependency-shaped workspaces. It folds parent links, the legacy scalar
`blocked_by`, and structured dependency edges into one graph, materializes
missing endpoints as explainable placeholder nodes, and returns active versus
terminal dangling-reference partitions. Domain adapters pass their
`RelationshipKindRegistry` as the optional third argument so custom VCS,
company, or package-defined edges survive assembly with their registered
semantics. `auditWorkspaceRelationshipGraph`
consumes that assembly and emits counts-first findings for active/terminal
missing references, retired sentinels, ordering cycles, stale lifecycle blocks,
and sparse or isolated active nodes. Findings include stable codes, severity,
bounded deterministic samples, truncation, policy text, and safe remediation;
the audit never invents an edge. Explicit isolate exemptions suppress policy
findings without changing structural coverage metrics.

```ts
import {
  assembleWorkspaceRelationshipGraph,
  auditWorkspaceRelationshipGraph,
  orderingPredecessors,
} from "@unbrained/pm-cli/sdk";

const assembly = assembleWorkspaceRelationshipGraph(items, isTerminalStatus);
const prerequisites = orderingPredecessors(assembly.graph, "deploy", {
  limit: 20,
  maxDepth: 4,
});
const governance = auditWorkspaceRelationshipGraph(assembly, {
  isTerminal: isTerminalStatus,
  exemptIsolates: ["company-root"],
  maxSampleSize: 25,
});
```

The three layers are intentionally separate: assembly owns storage-shape
normalization, traversal owns semantic graph algorithms, and governance owns
policy findings. A VCS, company operating model, digital twin, or other
non-project domain can replace the assembly adapter while reusing the same
registry, traversal, event, context, and audit contracts.

The native workspace adapter is `pm graph <subcommand>`, also available as
`PmClient.graph`, `runAction({ action: "graph" })`, and the MCP `pm_graph`
tool. `ancestors`/`descendants`/`predecessors`/`successors` expose the
semantic walks, `paths` exposes bounded simple-path enumeration, `impact`
exposes reverse-reachability blast radius from `analyzeGraphImpact`,
`analyze` combines `analyzeRelationshipExecution` and `analyzeKnowledgeGraph`
into one counts-first workspace projection, and `audit` runs
`auditWorkspaceRelationshipGraph` with `--sample` and `--exempt-isolate`
policy controls. `communities` exposes `detectRelationshipCommunities`
(deterministic asynchronous label propagation with lexicographic
tie-breaking), `redundancy` exposes `findRedundantRelationshipEdges`
(transitive-reduction scan over ordering and hierarchy families in semantic
orientation, each finding carrying a bounded witness path), and `dominators`
exposes `computeRelationshipDominators` (Cooper–Harvey–Kennedy immediate
dominators over the root's reachable subgraph, ranking structural
bottlenecks by gated work), and `plan` exposes `planRelationshipRemediation`
(dry-run remediation proposals derived from audit findings and witnessed
redundancy rows, each carrying an exact operation, policy code, evidence,
rationale, and confidence — never auto-applied). Three planning and structural
subcommands complete the analytics surface: `slack` exposes
`analyzeRelationshipSchedule` (Critical Path Method float over the order-bearing
DAG — earliest/latest start, total slack, and critical-task classification with
unit task durations, reusing the exact execution forward pass and adding the
backward latest-start pass; genuine cycles are reported separately, never
scheduled), `centrality` exposes `computeRelationshipCentrality` (exact Brandes
shortest-path betweenness, Wasserman–Faust closeness, undirected degree, and
precedence-oriented dependency fan-in/fan-out per node over the simple undirected graph), and
`articulation` exposes `findRelationshipCutStructure` (iterative Tarjan low-link
search reporting articulation points and bridges — the single points of failure
whose removal fragments the knowledge graph). All three are deterministic and
exact on the bounded workspace, carry explicit `cost`/`truncated` metadata, and
honor `--kind` (centrality/articulation) and `--limit`/`--summary` bounds. The audit gates finding
severity on lifecycle: contradictions confined to terminal items report as
informational `legacy_ordering_cycle`/`legacy_duplicate_edge` history debt,
while `ordering_cycle` errors and `duplicate_edge` findings require at least
one active subject; `duplicate_edge` covers parallel same-family spellings,
reciprocal inverse pairs included, which transitive-reduction redundancy
deliberately skips. The storage-integrity family `duplicate_dependency_row`
(warning on active holders, informational `legacy_duplicate_dependency_row`
on terminal ones) reports raw dependency rows whose exact identity is stored
more than once on one holder — invisible to every assembled-graph projection
because graph construction deduplicates edges by identity, so
`collectDuplicateDependencyRows` scans the pre-assembly item rows carried on
the assembly. Coverage policy is type-aware: the audit profile's
`coverage_by_type` breaks active/isolated/degree≤1 counts down per item type
(untyped items under `(untyped)`), and `isolateExemptTypes`
(`--exempt-isolate-type`) suppresses isolate/sparse findings for types whose
disconnection is policy-valid without changing profile counts.
`--save-baseline` persists the audit census through
`saveGraphAuditBaseline`, and later audits attach the signed
`diffRelationshipAuditSnapshots` drift (`baseline` block) — the temporal
comparison primitive for census tracking. All subcommands resolve the
workspace assembly through the shared fingerprint-keyed graph cache
(`WorkspaceGraphCache`): the fingerprint digests every
relationship-relevant item field (item type included, powering the per-type
coverage), so unchanged workspaces in long-lived hosts reuse the assembled
graph and memoized query results, and every envelope reports `cache`
hit/miss observability next to its explicit `truncated` and `cost` metadata.
One-shot processes additionally reuse the durable fingerprint-keyed index at
`runtime/graph-cache.json` (`pm graph index` status/`--rebuild`/`--clear`;
automatic persistence at ≥500 items, opt-in below via rebuild): atomic
last-write-wins envelopes, corrupt-tolerant decode, never authoritative —
every entry rebuilds from item storage on fingerprint mismatch, and
envelopes report the `cache.durable` disposition. Ids resolve
case-insensitively; `--summary` returns envelopes without row collections.

The graph fingerprint consumes the item-metadata derived index, whose metadata,
body, and collection tiers plus collapsed mutation delta publish one effective
source cursor. Supported item mutations serialize authoritative writes with a
bounded derived-index projection, so a long-lived SDK host or later CLI process
observes the committed relationship fields without paying for a full source
scan or rewriting the whole index. Cursor disagreement, an invalid projection
path, or any refresh failure invalidates the rebuildable base/delta state; the
next graph read source-scans and reconstructs both indexes. Package-owned
storage adapters can preserve this contract with the public
`acquireItemMetadataDerivedIndexLock` and
`refreshItemMetadataDerivedIndex` SDK primitives.

Mutation advisories reuse the same cycle semantics incrementally:
`collectNewOrderingCycleWarnings` builds a lightweight ordering digraph
directly from the before/after item snapshots (no full workspace assembly)
and scopes `collectOrderingCycles` to the changed item's weakly connected
ordering component — exact for any cycle containing the changed item, and no
longer paying two whole-graph SCC analyses per dependency-bearing mutation.

## Compatibility and migration

Aliases normalize at registry boundaries; stored values are not silently rewritten. Imports must carry or select a compatible registry version. Federation merges definitions before edges and rejects identifier or alias collisions. Rollback removes the custom definition and its derived index only after application-owned edges have been exported or superseded; immutable history is retained.

Validation rejects missing endpoints, disallowed self-edges, cardinality violations at mutation boundaries, ordering-only cycles, and incompatible aliases or versions. Immutable graph snapshots deduplicate canonical edges deterministically, retaining the last supplied edge; mutation boundaries may reject duplicates before snapshot construction. Evidence freshness and application payload schemas are extension policy: the core preserves payloads but does not invent domain meaning.

## Consequences and non-goals

CLI and MCP layers can remain thin consumers of the same SDK semantics, and non-PM applications can register domain relationships without patching core enums. The registry does not infer edges, choose relevance weights, mandate a large persistent index for scratch projects, or make distributed conflict resolution automatic.
