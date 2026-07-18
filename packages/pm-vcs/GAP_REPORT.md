# VCS exemplar SDK gap report

> Tracker: [pm-xtrd](../../.agents/pm/features/pm-xtrd.toon), parent story [pm-8ngt](../../.agents/pm/stories/pm-8ngt.toon).

This report evaluates the public SDK against one bounded foreign domain: a
changeset/ref workflow. It is an acceptance report, not a proposal to turn pm
core into Git.

| VCS-domain need | Public primitive used | Result |
| --- | --- | --- |
| Domain entities | extension item types and fields | Complete: `Changeset` and `VcsRef` require no core change. |
| Domain lifecycle | project profile statuses and workflows | Complete: draft, review, merge, and abandon are schema-owned. |
| Domain verbs | `registerCommand` | Complete: seven structured commands share normal CLI/contracts rendering. |
| Business rule | `beforeCommand` hook | Complete: merge requires an explicit reviewed affirmation. |
| Current state | `PmClient` lifecycle/query methods | Complete: command handlers use the same mutation engine as CLI and MCP. |
| Point-in-time state | `getItemAt` | Complete: any changeset history version or timestamp is reconstructed without file access. |
| Immutable graph events | `RelationshipEventStore` | Complete: optimistic attributable JSONL events survive process restart. |
| Streaming derived state | `RelationshipEventLog.stream/project` and durable equivalents | Complete in this change: bounded batches feed deterministic application projections. |
| Custom graph semantics | `registerRelationshipKinds` and `RelationshipKindRegistry` | Complete: `commits_to` is validated at activation and carries direction, inverse, ordering, cardinality, lifecycle, aliases, and version. |
| Extension-wide custom graph registration | active extension registry plus workspace graph assembly | Complete in this change: CLI, MCP, and SDK graph assembly merge active package definitions into the native ontology. |
| Atomic multi-item + relationship commit | `commitWorkspaceTransaction` | Complete: merge uses the host-bound public SDK journal, deterministic step inspection, a workspace writer lock, and append-only item/relationship compensations with crash-resumable replay. |
| Content-addressed objects, tree diff, network transport | out of scope | Product-specific VCS storage is intentionally not a universal pm primitive. |

## Conclusion

The SDK can express the bounded VCS domain without private imports. Custom
relationship semantics now cross the full public boundary from extension
activation into native workspace graph assembly, while the package-owned event
store supplies durable replay and projections. The last explicit SDK waiver is
closed by the public transaction coordinator; larger storage-index and scale
work remains on the canonical `pm-ju83` lineage.
