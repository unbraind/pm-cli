# Modeling A Domain On pm Primitives

pm's primitives are not specific to software project management. A record with
a type, a status lifecycle, typed relationships, an append-only history, and
bounded reads describes many domains. This reference is the procedure for
building one.

## The Primitive Set

| Primitive            | What it gives the domain                                  |
| -------------------- | ---------------------------------------------------------- |
| Item type            | The nouns of the domain                                     |
| Status + lifecycle role | The state machine each noun moves through               |
| Typed relationship   | The verbs between nouns, with direction and inverse         |
| Custom fields        | Domain attributes with declared types                       |
| Append-only history  | Immutable proof of every transition, restorable to any version |
| Assurance gate       | The domain's invariants, declared as data                   |
| Projection + budget  | Bounded reads that stay usable as the corpus grows          |
| Extension            | Domain-specific commands over the same substrate            |

## Procedure

1. **Name the nouns as item types.**

   ```bash
   pm schema add-type --name Experiment --description "One training run"
   pm contracts --schema-only
   ```

2. **Give each type its lifecycle.** A status without a declared lifecycle role
   is orphaned from every work-selection surface, so declare the role.

3. **Name the verbs as relationship kinds.** Prefer the built-in typed kinds
   where the meaning matches — `implements`, `verifies`, `discovered_from`,
   `supersedes`, `incident_from`, `blocked_by`, `parent`. Reach for `related`
   only when the relationship genuinely has no direction.

4. **Declare invariants rather than writing checker scripts.** A floor, a
   ceiling, or a monotone property over the record is expressible as an
   assurance measurement plus an assertion, evaluated by the SDK and bound to a
   trigger. See `pm guide assurance`.

5. **Ship domain verbs as an extension**, not as a fork. Extensions register
   commands, item types, importers, exporters, search providers, and profiles
   through `defineExtension` and declared capabilities.

6. **Prove it from the published surface only.** If the domain needs something
   the published SDK cannot express, that is a gap in the SDK, not a reason to
   import internals.

## Workflow Shapes This Already Serves

- **Tracker** — the default shape: work items, lifecycle, evidence.
- **Evaluation and benchmark** — cases as items, runs as history entries,
  scores as recorded verdicts, invariants as gates.
- **RL and sim-to-RL environment** — an episode is a bounded observation, an
  action is a recorded mutation, the trajectory is the history stream read in
  order, and the reward is a declared predicate over recorded state.
- **Incident and change management** — `incident_from` and `supersedes` carry
  causality; history carries the audit trail.
- **Content-addressed or temporal domains** — items as versions, `supersedes`
  as lineage, point-in-time reads as the query.

The property that makes all of these work is the same one: every mutation is
recorded immutably and every read can be bounded, so the record is both proof
and context.

## Checks Before Calling A Domain Pack Done

```bash
pm contracts --schema-only --json | jq '.schema.types'
pm validate --check-lifecycle --check-resolution
pm graph audit --json | jq '.profile.edges_by_kind'
pm assurance run <your-gate> --trigger ci --dry-run --json
```

A domain pack is complete when a new agent can be handed the workspace and the
contracts, with no prose, and still act correctly.
