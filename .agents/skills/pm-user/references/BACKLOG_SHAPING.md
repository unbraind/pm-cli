# Backlog Shaping

How to keep a tracker readable by both people and graph algorithms as it grows
from a handful of items to hundreds of thousands.

## The Ladder

Work resolves upward through typed edges to a declared outcome. A healthy
workspace has no active item that reaches nothing.

```
Milestone (declared outcome)
  ^ implements
Epic / capability area
  ^ parent
Feature / Story / Decision
  ^ parent
Task / Issue / Chore
```

- `Story` states what an agent or an organization needs, in their words.
- `Decision` records an architecture choice; open means proposed, closed means
  accepted or rejected with rationale.
- `Milestone` declares an outcome, not a date bucket.
- `Plan` holds a multi-step change with durable steps and discoveries.

Check the ladder:

```bash
pm graph audit --json | jq '{
  isolated: .profile.isolated_active_nodes,
  unreachable: .profile.outcome_unreachable_nodes,
  outcomes: .profile.outcome_nodes
}'
```

## Never Create A Duplicate

```bash
pm search "<distinctive phrase from the request>" --limit 10
pm search "<second phrasing>" --limit 10
pm list --type <likely-type> --status all --output-include id,title --output-limit 30
pm duplicates --limit 20        # scored candidate pairs, where the corpus allows it
```

Record what you searched in a create-time comment. A duplicate check that is
not written down cannot be audited later, and the next agent repeats it.

When the request extends existing scope, extend the existing item — add
acceptance criteria, add a child, add a typed edge. Filing a near-identical
sibling is the most expensive mistake in a large tracker.

## Prioritization That Selection Can Use

`pm next` ranks from recorded metadata. Metadata you never set cannot rank.

```bash
pm update <ID> --priority 1 --risk high --confidence medium --estimate 120
pm update <ID> --deadline 2026-09-30
pm comments <ID> "Decision log: raised to P1 because <evidence>."
```

Ordering belongs in edges, not in priority numbers:

```bash
pm update <ID> --dep "id=<prerequisite>,kind=blocked_by"
```

Do not record the inverse `blocks` edge as well — the pair is one relationship
and recording both creates a cycle.

## Closing Well

A closed item is the project's memory. Closed badly, it is a dead end.

```bash
pm close <ID> "<what shipped and what proved it>" \
  --resolution "<how it was resolved>" \
  --validate-close warn
pm release <ID>
```

Fill `resolution`, `expected_result`, and `actual_result` for defects.
`pm validate --check-resolution` reports which terminal items are missing them.

Record evolution explicitly rather than letting it be inferred:

```bash
pm update <NEW> --dep "id=<OLD>,kind=supersedes"
pm update <FIX> --dep "id=<INCIDENT>,kind=incident_from"
pm update <TEST> --dep "id=<FEATURE>,kind=verifies"
```

## Periodic Hygiene

```bash
pm validate --check-resolution --check-history-drift
pm health --summary
pm graph audit
pm list --status in_progress          # stale claims
pm aggregate --group-by type --json
```

Fix what a diagnostic prescribes rather than only recording that it warned.
A warning that has been carried for months is a decision that was never made.
