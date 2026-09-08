# Complete Ecosystem Planning

Tracked by [pm-doxj](../../../pm/milestones/pm-doxj.toon),
[pm-qnl2](../../../pm/tasks/pm-qnl2.toon), and
[pm-e9zh](../../../pm/chores/pm-e9zh.toon).

Use this procedure for an explicitly exhaustive portfolio review. Normal
implementation starts with bounded context and expands only its active lineage.

## Establish the Population

```bash
pm context --limit 10 --for orient
pm search "<request keywords>" --limit 10
pm list --status open --limit 20
pm list --status in_progress --limit 20
pm list --all --no-truncate --full --include-body --strict-read --json
pm events --full --limit 1000
```

Stream large results to an analysis consumer instead of loading them into the
agent's context. Certify the list's total, completeness, truncation, and omission
receipt. For events, parse the terminal `pm.stream.trailer`, retain every event's
complete `entry`, and resume with `--since <next_cursor>` until `has_more` is
false. Record the snapshot cutoff: a concurrent workspace can change during a
read, and new events belong to a subsequent delta. Event collection is not an
independent hash-chain verification.

Read `pm get <ID> --full --json` and the item's history before changing its
meaning or making a status claim. A closed implementation remains completed
when its encompassing outcome still has work left. Read the full contract only
when enumerating the surface: `pm contracts --full --json`; its default summary
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
