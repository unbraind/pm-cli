# Ecosystem planning review — 2026-09-28

Tracked by [pm-p9a4](../.agents/pm/tasks/pm-p9a4.toon),
[pm-m08hza](../.agents/pm/decisions/pm-m08hza.toon),
[pm-1jzupz](../.agents/pm/features/pm-1jzupz.toon), and
[pm-wg07](../.agents/pm/chores/pm-wg07.toon).

Project management = context management. This review records a complete
structural census, targeted semantic review, measured operational checks, and
planning decisions on existing canonical items. It does not certify that every
historical sentence is correct or that every future capability is implemented.
Read the live item before acting on this dated evidence.

## Population and evidence

The strict CLI snapshot at `2026-09-28T05:40:12.139Z` contains 2,826 items:
2,532 closed, 221 open, 59 draft, and 14 canceled. No records or fields were
omitted, and no item or directory was unreadable. Blocking is also a derived
dependency condition: the initial orientation reported 60 blocked open items,
although no item used a literal `blocked` lifecycle status.

The cursor-resumed event read collected 68,876 complete events from 2,841
streams through `2026-09-28T05:41:59.143Z`, including deleted-item and workspace
history. All 23 Plan items also received deep plan reads for steps, decisions,
validation and resume metadata. This later cutoff includes the first review claim/comment events;
it is not silently equated with the earlier item snapshot. History-drift
validation passed across all 2,826 current items. The public SDK independently
verified hash chains for all 2,841 collected streams with zero failures.

[The per-item census](ecosystem-review-2026-09-28.json) records every snapshot
ID, status, content fingerprint, structural classification, missing planning
fields, historical evidence gaps, and remediation owner. These are mechanical
findings, not invented historical estimates, outcomes, or review approvals.
The full raw corpus stays outside public documentation.

| Measure | Initial observation | Interpretation |
| --- | ---: | --- |
| Directed graph edges | 14,097 | Deduplicated directed basis |
| Ordering layers / critical-path edges | 12 / 11 | Acyclic prerequisite graph |
| Missing graph endpoints / isolated items | 0 / 0 | Across all statuses |
| Active / terminal outcome-unreachable items | 0 / 0 | Typed reachability basis |
| Generic `related` edges | 5,589 | 39.65% of directed edges |
| Specialized semantic edges | 1,885 | Discovery, recurrence, incident, verification, supersession |
| Items without a specialized semantic edge | 1,463 | 86 active, 1,377 terminal; not necessarily invalid |
| Legacy hierarchy exceptions | 7 children | Existing informational cardinality/direction findings |
| Closed items missing structured resolution evidence | 170 | Preserved residual, not a new regression |
| Active items missing required planning fields | 1 | Sentry major-upgrade item, repaired in this review |
| Tracked non-tracker artifacts with exact item links | 1,921 / 1,921 | Path ownership, not proof for every code change |
| Duplicate candidate clusters | 28 | Reviewed candidates, not 28 duplicate obligations |

Scanner records with different provider identities, parent/child acceptance
slices, distinct incidents and dated release executions remain separate. The
three identically titled accidental probes are already canceled. Similar audit
titles require their own event/acceptance comparison before any consolidation.
No existing item was deleted or closed merely because it matched a title.

## Graph organization

Use one structural parent and outcome paths for scope, `implements` for delivery,
`blocked_by` for an actual prerequisite, `discovered_from` for provenance,
`verifies` for verification responsibility, and `recurs_from` only for an
established recurring mechanism. Maintain prior evidence when correcting a link.
A declaration that an item will verify something is not a passing test result.

The native reconstruction plan retains its original execution obligations;
overlapping newly added steps are explicitly superseded by their existing owners,
and a dated census checkpoint records the completed refresh.

The planning pass restores explicit missing prerequisites in prospective
reminders, cross-branch relevance and external-package verification. The
historical batch restores three `discovered_from` edges to the governance run
whose original comment explicitly named the discoveries. Their release and
closure evidence remain unchanged. Generic links and transitive ordering
shortcuts are not added to meet density or depth targets.

[pm-qnl2](../.agents/pm/tasks/pm-qnl2.toon) owns active enrichment;
[pm-lnrk](../.agents/pm/tasks/pm-lnrk.toon) owns historical batches;
[pm-pj2isb](../.agents/pm/chores/pm-pj2isb.toon) owns misleading placeholder
metadata. The completed [pm-e9zh](../.agents/pm/chores/pm-e9zh.toon) preserves
its explicitly unrecoverable 170-item residual. A missing historical observation
must remain unknown until independent evidence is found.

After this pass the live graph contains 2,829 items and 14,118 directed edges,
including 1,894 specialized semantic edges. Generic `related` is 5,590 after one
reviewed correction from causal provenance to non-causal coordination; no dangling endpoints, isolated items or ordering contradictions were
introduced. Outcome reachability remains 100%. The 1,458 records without a
specialized semantic edge remain visible for evidence review; absence alone
does not justify inventing a relationship.

## Horizon and outcome organization

These are planning windows, not delivery promises. Capacity, prerequisites and
measured evidence govern promotion. Priority measures impact; horizon measures
readiness and uncertainty. Review monthly and when a material observation changes.

| Horizon | Illustrative window | Canonical outcomes and promotion evidence |
| --- | --- | --- |
| Current | 0–3 months | [Agent-legible grammar](../.agents/pm/milestones/pm-j82fd3.toon), active readiness, retrieval failures, release diagnosis and current protocol proof. Require completed-task token comparisons, preserved compatibility and actual installed-consumer evidence. |
| Emerging | 3–12 months | [Provable history](../.agents/pm/milestones/pm-w7ccmv.toon), reproducible observations and [measured self-improvement](../.agents/pm/milestones/pm-zzylb9.toon). Require independent replay, mutation coverage and three consecutive measured improvement cycles. |
| Expansion | 12–36 months | [Proven scale](../.agents/pm/milestones/pm-o87av6.toon), [universal domain platform](../.agents/pm/milestones/pm-t4d7nz.toon), [federated agents](../.agents/pm/milestones/pm-z1kr34.toon). Require published million-item/fleet distributions and SDK-only domain exemplars. |
| Exploratory | 36+ months | [Multi-decade continuity](../.agents/pm/milestones/pm-ljrh29.toon) and independently evaluated cognitive mechanisms. Require explicit architecture decisions, migration proofs, calibrated uncertainty and rejection criteria. |

The [SDK-complete outcome](../.agents/pm/milestones/pm-9rgaal.toon) and
[GA stability contract](../.agents/pm/milestones/pm-xp1xsw.toon) retain their own
acceptance boundaries. Earlier SDK promotion work remains completed history;
future integrations must use published SDK contracts and expose gaps as individual
items. New names or parallel roadmap trees do not improve traceability.

## Concrete planning refinements

- **Command simplicity:** root help already has thirteen entries including help.
  Evaluate the remaining grammar through complete orient/retrieve/claim/mutate/
  verify/close and recovery journeys. Preserve working aliases and capabilities.
  Count tokens across errors, retries, cursor pages and contract discovery.
  The new [Plan receipt issue](../.agents/pm/issues/pm-hqy7lr.toon) records
  whole-plan output amplification observed during single-step mutations; its
  acceptance requires bounded SDK-owned receipts and preserved full inspection.
- **Algorithms:** the [existing portfolio](CONTEXT_ALGORITHM_PORTFOLIO.md)
  remains authoritative. Individual items now detail bounded candidate quotas,
  evidence coverage per token, typed spreading activation, activation decay,
  approximate affinity sketches and content-addressed summary trees. Each names
  inputs, costs, fallback, negative controls and a promotion/rejection rule.
  Mathematical guarantees require their assumptions; a heuristic is not a proof.
- **Scale and branches:** separately measure cold build and warm reads at 3,
  100,000 and 1,000,000 items, and 1/10/100/1,000 agents. Exercise partitions,
  retries, expired claims, clock skew and arbitrary merge order. Record p50/p95/
  p99, memory, index amplification and no-lost-acknowledged-write evidence.
- **Recursive improvement:** bind observe, propose, evaluate, land and remeasure
  stages to immutable evidence. Keep the evaluator and held-out data independent
  of the change under evaluation. Rejected proposals stay searchable.
- **Universal environments:** episodes use SDK reset/observe/step/score contracts,
  seeded snapshots, idempotent actions, independent verdicts and temporal cutoffs.
  Distinguish termination from truncation and prevent future-evidence leakage.
- **Durability:** append-only API behavior, hash-chain tamper evidence,
  authenticated authorship and externally anchored proof are different guarantees.
  Migration, redaction and cryptographic rotation need explicit restore tests.

## Verified behavior and remaining limits

### Local qwen3 retrieval

The project already selects local Ollama `qwen3-embedding:0.6b`. Refresh embedded
1,085 stale inputs in 34 requests, with zero retries or splits, at approximately
11.91 inputs/second. This proves multi-input batching at the current corpus size;
it does not prove the outstanding 100k/1M performance acceptance.

Five project golden queries were evaluated at k=10:

| Mode | Mean nDCG | Mean MRR | Mean recall | Broad history/episode query recall |
| --- | ---: | ---: | ---: | ---: |
| Keyword | 0.7451 | 0.80 | 0.8727 | 4/11 |
| Semantic | 0.7944 | 0.85 | 0.8182 | 1/11 |
| Hybrid | 0.8405 | 0.90 | 0.8364 | 2/11 |

Aggregate passes conceal weak queries. The existing retrieval-quality owner
[pm-p1g43q](../.agents/pm/features/pm-p1g43q.toon) now carries this observation,
feasible per-query floors, held-out paraphrase evaluation and mode comparisons.
At k=10, a query with eleven relevant items cannot attain recall 1. The final
semantic index check covered all 2,829 current items with zero stale vectors.

### MCP and SDK

The official [versioning page](https://modelcontextprotocol.io/docs/2026-07-28/learn/versioning)
identifies `2026-07-28` as current. The repository
[conformance matrix](MCP_2026_07_28_CONFORMANCE.md) was compared with the official
[key changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog).
The focused SDK, stateless stdio, Streamable HTTP and legacy-handshake run passed
145 tests in twelve files. Exact-version public verification also passed direct
and package-selected npx/bunx CLI dispatch, MCP discovery, Skills, Apps and HTTP,
including missing-bin negative controls. This is focused conformance evidence, not an assertion
that every optional extension or every deployment is certified. Deprecated
features must not be newly advertised merely to increase a feature count.

Ordinary review mutations recorded detected Codex identity, model and effort
without `PM_AUTHOR` or author flags. Role/topic inference carries its source and
confidence. Missing signals remain unknown; configuration is not native proof.

### Daily release

Version `2026.9.28` exists in npm and GitHub. The
[original automatic attempt](https://github.com/unbraind/pm-cli/actions/runs/36375818142)
failed after Windows global npm installation failed in the child release run.
The [same-version recovery](https://github.com/unbraind/pm-cli/actions/runs/36380136948)
passed npm, global npm and Bun on Linux, macOS and Windows and advertised the
existing version. It did not create a second automatic version that day.

The new [installer-diagnostics issue](../.agents/pm/issues/pm-q7c36n.toon)
records why the original cause remains unknown: the subprocess wrapper discards
error/signal details and the installer labels every retry registry availability.
Recovery proves the artifact can pass; it does not erase the failed attempt or
establish its cause. Keep automatic reliability, publication and consumer
acceptance as separate measurements.

## Prevention and repeatability

Six active-only zero-debt assertions now join `tracker-context-quality` for
missing description, acceptance criteria, risk, confidence, estimate and expected
result. The existing local and hosted quality pipeline invokes this same native
SDK gate. Terminal evidence gaps are deliberately outside the active-only policy.
An isolated temporary workspace failed all six assertions with missing fields
and passed all six after repair. This checks presence; semantic quality still
requires evidence review.

For repeat reviews, follow the
[ecosystem planning skill](../.agents/skills/pm-user/references/ECOSYSTEM_PLANNING.md).
Use complete CLI snapshots outside the prompt, cursor-resumed event streams,
exact source fingerprints, all-status duplicate checks and bounded mutation
batches. At million-item scale, use streaming/indexed consumers rather than
loading a whole JSON collection into the agent's context. Every changed item
retains its canonical owner, history and original acceptance boundary.

## Verification record

Quiescent validation passed for all 2,829 final items. The 170 historical
structured-evidence warnings are unchanged. All 38 changed history streams pass
the public SDK chain verifier; the 35 pre-existing streams retain byte-identical
historical prefixes. The three enriched closed features retain identical status,
closure, resolution and release fields. Final graph-composition and all 47
tracker-context-quality assertions pass, including the six new readiness rules.

An earlier long-running context gate saw one history-drift failure while this
review was still mutating the tracker. Independent validation and the final gate
pass with writes stopped; the earlier result is retained as a concurrent-read
observation, not rewritten as success. Skill/document validation, local links
and the generated changelog check also pass. All review claims are released. Three distinct issues were added after duplicate
checks: installer diagnostics, Plan mutation receipts and startup admission
diagnosis. Existing programmes retain their original acceptance boundaries.

The broad static run passed its build, lint, generated contracts, SDK parity,
command grammar, task-token, MCP deprecation, gate-registry and context-quality
checks, then failed the import-cost timing gate (bare Node median 305 ms against
106 ms). An isolated rerun passed all ten SDK entrypoints with unchanged budgets.
The initial timing failure remains part of the evidence; it is not a continuous
all-green static invocation.

The remaining graph and record-integrity gates passed. The mutation gate passed
with 323 of 330 mutants killed and seven classified as equivalent. The CLI
transport benchmark initially exceeded its list threshold (442 ms versus 419 ms);
the isolated rerun also failed: get 385/362 ms, context 466/433 ms, next
457/440 ms and create 424/398 ms. No performance limit was raised. The new
[startup investigation](../.agents/pm/issues/pm-bj7rq0.toon) distinguishes runner
qualification from a demonstrated product regression and preserves the completed
transport-floor implementation. This is an unresolved validation limitation.

## PR review corrections

PR #1333 identified two overly broad relationship claims. The standing release
reminder predates the new installer-diagnostics issue, so their link is `related`
coordination rather than `discovered_from` provenance. Four `verifies` rows from
the historical batch were removed: checking citations, history continuity and
release attribution does not verify the source run or feature behavior. The three
source-backed discovery links on closed features remain valid and unchanged.

The original writes and their corrections remain in immutable history. Five
holder/target/text-scoped citation exemptions distinguish the batch inventory
from verification claims without raising the prose-edge ceiling. The corrected
graph-composition gate passes.

The follow-up review narrowed those five exemptions to the complete original
paragraphs, including their historical source-event coordinates. In an isolated
temporary tracker the original citations pass, while a later batch comment
asserting an unrecorded prerequisite is blocked with one detected gap. This
prevents the common phrase “Historical batch” from exempting future claims.
