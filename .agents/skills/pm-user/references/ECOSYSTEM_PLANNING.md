# Complete Ecosystem Planning

Tracked by [pm-doxj](../../../pm/milestones/pm-doxj.toon),
[pm-qnl2](../../../pm/tasks/pm-qnl2.toon), and
[pm-e9zh](../../../pm/chores/pm-e9zh.toon).

Use this procedure for an explicitly exhaustive portfolio review. Normal
implementation starts with bounded context and expands only its active lineage.

## Establish the Population

```bash
pm context --limit 10 --for orient
pm search "<request keywords>" --limit 10   # hybrid when semantic search is configured, keyword otherwise
pm list --status open --limit 20
pm list --status in_progress --limit 20
pm list --all --no-truncate --full --include-body --strict-read --json --output-budget unbounded > items.json
pm events --full --limit 1000
```

The complete snapshot command is for an explicitly authorized exhaustive review.
Keep its output outside the prompt and use a bounded streaming consumer for
million-item workspaces; an unbounded collection is not a normal agent loop.

Stream large results to an analysis consumer instead of loading them into the
agent's context. Certify the list's total, completeness, truncation, and omission
receipt. For events, parse the terminal `pm.stream.trailer`, retain every event's
complete `entry`, and resume with `--since <next_cursor>` until `has_more` is
false. Record the snapshot cutoff: a concurrent workspace can change during a
read, and new events belong to a subsequent delta. Event collection is not an
independent hash-chain verification.

Read `pm get <ID> --full --json --output-budget unbounded` and the item's history before changing its
meaning or making a status claim. A closed implementation remains completed
when its encompassing outcome still has work left. Read the full contract only
when enumerating the surface: `pm contracts --full --json --output-budget unbounded`; its default summary
does not contain the complete flag, action, SDK, and MCP catalog.

## Inspect Meaning and Coverage

```bash
pm graph audit --full --json
pm graph analyze --full --json
pm duplicates --status all --limit 100
pm validate --check-resolution --check-history-drift
pm health --check-only --full
```

Inspect continuation receipts on every collection. Fuzzy duplicate clusters
are review candidates: separate scanner identities, follow-ups, and parent/child
deliveries can share titles or issue numbers without being duplicates.

Check active acceptance criteria, readiness, risk, confidence, estimates,
outcome reachability, and ownership. Compare actual repository files, docs,
tests, packages, and command contracts with linked artifacts. Historical empty
fields need evidence recovery, not invented estimates or generic completion
text. Reuse a substantive closure statement or original acceptance criterion
only with an explicit source comment, and keep unrecoverable gaps recorded.

## Build a Useful Graph

Use `implements` for delivery, `verifies` for evidence, `discovered_from` for
provenance, `recurs_from` for the same failure mechanism, `supersedes` for
replacement, and one ordering direction for a real prerequisite. Check the
runtime relationship contract before choosing a kind.

An identifier mentioned in a boundary statement does not establish a
dependency. Neither file overlap nor timestamps alone prove causality. Do not
add inverse duplicates, hierarchy chains, or generic links to achieve a depth
quota. Preserve evidence references and uncertain candidates separately from
accepted edges. Verify graph and history invariants after each bounded batch.

## Plan Outcomes and Experiments

Reuse the living milestone and canonical feature owners. Organize Current,
Emerging, Expansion, and Exploratory horizons by evidence and prerequisite
readiness; dates are forecasts with assumptions, not completion claims.

Every independently testable proposal needs an existing owner or a deduplicated
item with scope, non-goals, acceptance criteria, dependencies, expected value,
risks, and an evaluation. Algorithm proposals also name data inputs, bounded
candidate generation, time/memory cost, deterministic fallback, provenance,
negative controls, and a measurable promotion/rejection rule. Keep historical
catalog aliases resolvable; use stable slugs for new concepts.

Use the actual workflow capabilities that help: plans for execution steps,
atomic `pm item mutate` batches for heterogeneous changes, notes for proposals,
learnings for conclusions, and assurance measurements for regression gates.
Read each unfamiliar command's help first. Record adopt/cover/waive decisions
for capabilities that would otherwise require artificial production data.

For this repository's algorithm and cognitive proposals, consult the
[portfolio index](../../../../docs/CONTEXT_ALGORITHM_PORTFOLIO.md), then read
the individual owner. Historical ordinal references require their source-note
timestamp; a closed substrate does not prove its proposed extensions shipped.

After terminal metadata changes, regenerate and check the package-owned
changelog, preserving historical release attribution. Release claims when the
batch ends; keep unfinished programmes open with exact residual scope.

## Keep annotation inputs plain

Use `pm notes <ID> --add "prose"` and `pm comments <ID> --add "prose"`
for text. Do not JSON-encode a `{ "text": "..." }` object into these plain-text
arguments: it becomes a literal wrapper in the stored annotation. Use
`pm notes <ID> --add-json` only for an intentional JSON event. Correct a wrapped
annotation with `--edit <index> --add "prose"` so history records the correction.

## Interpret verification precisely

A configured embedding model and a successful reindex prove availability, not
retrieval quality. Run keyword, semantic and hybrid judgments independently and
inspect each query beside aggregate scores. At cutoff k, a query with more than
k relevant records cannot attain recall 1. Record feasible per-query floors.

A recovered release does not erase the failed automatic attempt. Preserve the
original run, same-version recovery, registry identity and each installed-consumer
verdict separately. Historical fields without recoverable evidence stay unknown.
