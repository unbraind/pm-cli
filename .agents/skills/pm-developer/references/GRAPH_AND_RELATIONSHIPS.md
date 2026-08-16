# Relationships and Graph Analytics

The tracker is a directed graph, not a list. Typed edges are what make the
project's history readable by algorithm. Full contract:
[docs/RELATIONSHIP_GRAPH.md](../../../../docs/RELATIONSHIP_GRAPH.md) (~7.4k tok)
and [docs/DEPENDENCY_KIND_CONTRACT.md](../../../../docs/DEPENDENCY_KIND_CONTRACT.md) (~700 tok).

## The Edge Vocabulary

Authoritative at runtime:

```bash
pm contracts --json --full | jq '.relationship_kind_contracts'
```

| Kind              | Meaning                                        | Ordering | Hierarchy |
| ----------------- | ---------------------------------------------- | -------- | --------- |
| `parent`          | This item belongs under that one                | no       | yes       |
| `child`           | Inverse of `parent`                             | no       | yes       |
| `blocked_by`      | This item waits for that one                    | yes      | no        |
| `blocks`          | Inverse of `blocked_by`                         | yes      | no        |
| `implements`      | This item realizes that goal, story, or ADR     | no       | no        |
| `verifies`        | This item proves that one behaves as claimed    | no       | no        |
| `discovered_from` | This item was found while doing that one        | no       | no        |
| `incident_from`   | This item originates in that recorded incident  | no       | no        |
| `supersedes`      | This item replaces that one                     | no       | no        |
| `commits_to`      | This item lands in that changeset or release    | yes      | no        |
| `related`         | Associative, non-directional                    | no       | no        |

`related` carries the least information. Prefer a typed kind whenever one
applies — `discovered_from`, `implements`, and `verifies` are the three that
most often replace a reflexive `related`.

## Adding Edges

```bash
pm update <ID> --dep "id=<other>,kind=implements"
pm update <ID> --dep "id=<other>,kind=discovered_from"
pm update <ID> --dep-remove "id=<other>,kind=related"
```

Rules that prevent damage:

- `--dep` **appends**; it does not replace the dependency list.
- `--dep-remove` with a bare id deletes **every** row for that id. Always pass
  `kind=` unless removing all of them is the intent.
- Never record both `A blocks B` and `B blocked_by A`. They are inverse
  spellings of one edge, and recording both creates a cycle.
- Never add an edge to satisfy a count. Each edge should cite durable text, a
  history event, or a linked artifact.
- A placeholder or misspelled id passes `create` silently. Verify with
  `pm deps <ID>` after adding.

## Reading The Graph

```bash
pm deps <ID>                              # tree view of one item's neighborhood
pm deps <ID> --format context --direction both --kind implements,verifies
pm graph analyze                          # layers, critical path, components, hubs
pm graph audit                            # findings, coverage, edge composition
pm graph impact <ID> --direction downstream
pm graph ancestors <ID> / descendants <ID>
pm graph paths <A> <B>
pm graph dominators <ID>                  # what must pass through this node
pm graph articulation                     # single points of failure
pm graph communities / centrality / slack / redundancy
pm graph plan                             # critical path method over the ordering DAG
```

`pm graph impact` and the traversal verbs are directional. Pass `--direction`
explicitly rather than relying on a default when the answer depends on it.

## Governance Signals Worth Checking

`pm graph audit` reports the properties that decide whether the graph is
trustworthy:

- `isolated_active_nodes` and `degree_leq_one_active_nodes` — work nobody can
  reach from anywhere.
- `redundant_edges` — edges implied by another path; they cost storage and
  dilute analytics.
- `ordering_contradiction_edges` — a scheduling claim contradicted elsewhere.
- `outcome_unreachable_nodes` — items that resolve to no declared goal.
- `articulation_points` and `bridge_edges` — the structural chokepoints.

When a workspace declares these as assurance bounds, adding edges can move a
ratchet. Check headroom before a bulk enrichment pass:

```bash
pm assurance run graph-composition --trigger ci --dry-run --json
```
