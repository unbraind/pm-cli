# Digital Twin SDK Gap Report

Tracked by [pm-kr3t](../../.agents/pm/features/pm-kr3t.toon). This report is the
phase-two acceptance inventory for
[pm-8ngt](../../.agents/pm/stories/pm-8ngt.toon) and the SDK-first epic
[pm-usfg](../../.agents/pm/epics/pm-usfg.toon).

| Domain need                                   | Public primitive used                                                                                        | Result                                                                                          | Canonical lineage                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Stable facility and asset identities          | `PmClient.create/get/list`, custom item types and fields, project profiles                                   | Complete                                                                                        | [pm-3mna](../../.agents/pm/features/pm-3mna.toon) |
| Attributable immutable observations           | `RelationshipEventStore.append`, custom payloads, optimistic versions                                        | Complete                                                                                        | [pm-ju83](../../.agents/pm/features/pm-ju83.toon) |
| Crash-consistent identity plus initial event  | `commitWorkspaceTransaction` with idempotent inspect/apply/compensate steps                                  | Complete                                                                                        | [pm-4e12](../../.agents/pm/features/pm-4e12.toon) |
| Typed containment, flow, and utility topology | `RelationshipKindRegistry`, `RelationshipGraph`, package-contributed kinds                                   | Complete                                                                                        | [pm-ju83](../../.agents/pm/features/pm-ju83.toon) |
| Current and point-in-time state               | Event-time replay plus `RelationshipEventLog.snapshot`                                                       | Complete; late-arrival correctness fixed by [pm-j3swnb](../../.agents/pm/issues/pm-j3swnb.toon) | [pm-hib1](../../.agents/pm/features/pm-hib1.toon) |
| Topology blast radius                         | `analyzeGraphImpact` with bounds and exact paths                                                             | Complete                                                                                        | [pm-7ob5](../../.agents/pm/features/pm-7ob5.toon) |
| Domain invariants                             | Package-owned pure policies over SDK graph and replay projections                                            | Complete                                                                                        | [pm-xc68](../../.agents/pm/features/pm-xc68.toon) |
| Corrections without rewriting history         | `supersede` events plus explicit `supersedes_event_id` provenance                                            | Complete                                                                                        | [pm-ju83](../../.agents/pm/features/pm-ju83.toon) |
| Schema evolution                              | Versioned event payload normalization with explicit unsupported-version findings                             | Complete for exemplar; general bulk schema migration remains planned                            | [pm-dijg](../../.agents/pm/features/pm-dijg.toon) |
| Offline and federated replicas                | Deterministic event-time merge, idempotent identical-event skips, explicit content conflicts                 | Complete at package boundary; cross-workspace transport remains planned                         | [pm-is1a](../../.agents/pm/features/pm-is1a.toon) |
| Atomic bulk import                            | `RelationshipEventStore.appendBatch` validation and atomic replacement                                       | Complete                                                                                        | [pm-ju83](../../.agents/pm/features/pm-ju83.toon) |
| Tamper evidence and restore                   | Canonical SHA-256 checkpoints plus full durable replay                                                       | Complete at package boundary                                                                    | [pm-klo8](../../.agents/pm/features/pm-klo8.toon) |
| Bounded shell export                          | Compact JSON command result, explicit limit and truncation                                                   | Complete                                                                                        | [pm-646c](../../.agents/pm/features/pm-646c.toon) |
| Live cross-process subscription               | Durable store can be reopened and paged, but follow-mode subscription is intentionally outside this exemplar | Existing planned capability; no duplicate filed                                                 | [pm-e200](../../.agents/pm/features/pm-e200.toon) |

## Findings

The digital-twin domain required no private import and no domain-specific core
change. The one correctness gap was generic rather than industrial:
timestamp-based relationship snapshots assumed append order and event-time
order were identical. Offline systems violate that assumption. The
duplicate-checked issue
[pm-j3swnb](../../.agents/pm/issues/pm-j3swnb.toon) fixes timestamp snapshots
to filter every event by event time while preserving append order among
included events.

The remaining open rows already have canonical owners:

- [pm-dijg](../../.agents/pm/features/pm-dijg.toon) for general schema
  migrations;
- [pm-is1a](../../.agents/pm/features/pm-is1a.toon) for cross-workspace
  federation;
- [pm-e200](../../.agents/pm/features/pm-e200.toon) for live mutation
  subscription;
- [pm-klo8](../../.agents/pm/features/pm-klo8.toon) for workspace-wide audit
  history.

No duplicate SDK item was created for those future layers.
