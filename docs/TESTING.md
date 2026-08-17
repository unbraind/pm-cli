# Testing

This page describes safe local tests, linked tests, coverage, and release-readiness checks.

Tracked implementation updates: [pm-52eh](../.agents/pm/features/pm-52eh.toon), [pm-mcxr](../.agents/pm/issues/pm-mcxr.toon), [pm-u42x](../.agents/pm/issues/pm-u42x.toon), [pm-atfm](../.agents/pm/features/pm-atfm.toon), [pm-xmp5](../.agents/pm/tasks/pm-xmp5.toon), [pm-39cqqx](../.agents/pm/tasks/pm-39cqqx.toon), [pm-5cgm2z](../.agents/pm/chores/pm-5cgm2z.toon), [pm-avv3wx](../.agents/pm/issues/pm-avv3wx.toon), [pm-rizqb6](../.agents/pm/issues/pm-rizqb6.toon), [pm-95h7pg](../.agents/pm/issues/pm-95h7pg.toon), [pm-giks4s](../.agents/pm/issues/pm-giks4s.toon).

## Agent Quick Context

- Unit and integration tests must not read or write real `.agents/pm` data.
- Prefer `node scripts/run-tests.mjs ...` because it creates sandboxed `PM_PATH` and `PM_GLOBAL_PATH`.
- Linked tests added through `pm test` should use sandbox-safe commands.
  Package-manager scripts such as `pnpm test` are allowed because linked-test
  execution injects isolated `PM_PATH` and `PM_GLOBAL_PATH`; direct runners such
  as `vitest` still need `node scripts/run-tests.mjs ...` or inline sandbox env.
- Run linked tests before closing the item that owns the work.

Tracked documentation work: [pm-u9d0](../.agents/pm/epics/pm-u9d0.toon).

Local/hosted gate parity is tracked by [pm-ei6x66](../.agents/pm/tasks/pm-ei6x66.toon).

## Standard Local Checks

```bash
pnpm build
pnpm lint
pnpm typecheck
node scripts/run-tests.mjs test
node scripts/run-tests.mjs coverage
```

For the exact ordered local preflight used to make release-readiness claims,
run the registry-owned entrypoint:

```bash
pnpm verify:preflight
```

`scripts/release/gate-registry.json` is the executable plan for this command:
each ordered step declares its command, arguments, environment, capture mode,
and whether an explicit skip flag is permitted. Receipts distinguish passed
steps from declared skips, and `quality:gate-registry` maps hosted workflow
claims to the same canonical gate IDs. Hosted-only environment isolation and
tracker-integrity steps remain explicit entries with reasons rather than
silently disappearing from local parity.

`node scripts/run-tests.mjs` wraps Vitest in temporary tracker roots, then cleans them up.

Public SDK changes additionally run semantic surface and import-cost contracts:

```bash
pnpm sdk:surface:check
pnpm benchmark:sdk-entrypoints:check
pnpm benchmark:transport:check
```

The surface gate detects exported signature, type-parameter, declaration-kind,
and stable error-code drift across the aggregate and every narrow SDK
entrypoint. The performance gates protect entrypoint import cost and one-item
CLI cold-start overhead without touching the repository tracker.

`pnpm lint` is the local CodeFactor parity check. It layers ESLint rules for
shipped source, package, plugin, and script surfaces that match the CodeFactor
maintainability findings this repo tracks (`complexity`,
`no-unsafe-optional-chaining`, and the relevant `eslint-plugin-unicorn`
mechanical rules), jscpd duplicate detection across source and tests, and the
repo-specific `quality:static` gate. The dedicated `quality:static` gate remains
authoritative for source/exported docstring coverage, orphan-module checks,
directory-load caps, and the TypeScript-aware duplicate/complexity checks that
are tailored to pm's source layout; `pnpm lint` delegates to it instead of
running a second threshold profile. It also includes a changed-file
CodeFactor-parity complexity scan for shipped source, package, and script files
so PR-local CodeFactor maintainability annotations fail locally before commit or
push. Existing legacy high-complexity test fixtures are tracked separately and
must not be used as precedent for new changed production/script code.

The local parity rules catch analyzer classes before push. The mandatory hosted
proof runs after the final commit is pushed and both apps have finished:

```bash
pnpm quality:hosted-analysis
```

This command reads commit-scoped GitHub results for `git rev-parse HEAD`. It
passes only when DeepScan explicitly reports `0 new` issues and CodeFactor
completes successfully with `No issues found.` The exact commit is authoritative.
For GitHub merge and squash commits whose apps report only on the reviewed PR
head, the gate accepts that evidence only after proving the source and target
have the same immutable Git tree. Squash commits also require one unambiguous
GitHub PR association to a closed PR merged into `main`. Missing, pending,
failed, skipped, stale, ambiguous, and different-tree results all fail.
`pnpm release:gates` includes the same non-skippable verification, so run it
only after the pushed reviewed head's hosted analyzers are terminal.

## Focused Test Runs

```bash
node scripts/run-tests.mjs test -- tests/unit/output.spec.ts
node scripts/run-tests.mjs test -- tests/integration/cli.integration.spec.ts
```

Use focused runs while iterating, then run coverage before closure when risk or scope warrants it.

## CI Retry and Timeout Diagnostics

CI retains the 30-second per-test timeout and retries one failed attempt. A
test that passes only on retry is reported as flaky rather than silently folded
into the pass count; a persistent assertion still fails after the bounded
retry. Local runs do not retry, so deterministic failures stay immediate while
iterating.

Vitest's GitHub reporter emits annotations and retry evidence. The repository
reliability reporter additionally writes
`.vitest-reports/reliability-<shard>.json` and appends a job-summary table with
the test identity, file, duration, effective timeout, retry count, shard, and
failure detail. Tests completing at or above 80% of their timeout are recorded
as at-risk before load turns them into timeouts. Coverage shards upload this
JSON beside their blob report, so recurrence can be measured without decoding
the coverage artifact or re-reading raw logs.

`PM_TEST_SHARD` supplies a stable shard identity and
`PM_TEST_RELIABILITY_REPORT_DIR` can redirect the JSON report for an isolated
harness. These variables affect diagnostics only; they do not change test
selection, retry count, timeout, or verdicts.

## Coverage Governance

Coverage gating now targets literal all-source coverage across runtime code families:

- `vitest.config.ts` includes canonical authoring sources across `src`, `packages` (`.ts`), `scripts`, `plugins`, and `docs/examples`.
- Generated package JavaScript mirrors are not separately gated; coverage is enforced on their TypeScript sources.
- Thresholds are strict `100/100/100/100` for lines, branches, functions, and statements.
- Avoid reintroducing curated coverage allowlists; keep the full all-source corpus measurable and gated.
- Prefer extending existing test files and shared helpers so new coverage remains fast and non-duplicative.
- Prefer extracting deterministic pure helpers (and unit-testing them) when an orchestration-heavy file is difficult to cover directly.

Static quality also enforces source documentation coverage through `pnpm
quality:static`: every `src/**/*.ts` source file needs a module TSDoc block,
every exported declaration needs a non-module TSDoc block, and known generated
boilerplate summaries are rejected.

## TOON Storage Round-Trip Gate

TOON item serialization is a fail-closed storage boundary. Before returning
bytes to any create, update, merge, migration, or package caller, pm decodes the
new `@toon-format/toon` output and compares it with the JSON-like canonical
payload. A decode failure or the first field-level mismatch raises
`item_document_roundtrip_failed`; no item bytes are written.

The property suite exercises generated and adversarial agent text, including
array-header spellings, colons, quotes, backslashes, newlines, Unicode, comment
prefixes, and bracketed endpoint-shaped strings:

```bash
node scripts/run-tests.mjs test -- tests/fuzz/project-boundaries.fuzz.spec.ts
```

Major codec upgrades additionally require a complete read/serialize/read sweep
over every tracked `.toon` item, strict history and storage validation, the
packed npx consumer smoke, and Bun SDK/bunx execution. A dependency-only green
unit suite is not sufficient evidence for changing the canonical storage
codec.

### Directory-load cap and the `tests/unit` split

`pnpm quality:static` also caps each directory under `src/`, `tests/`, and
`packages/` at **120 `.ts` files** (`--max-files-per-dir`, default `120`). This
keeps any single directory navigable and forces load to be partitioned by area
rather than piling into one folder. `tests/unit/` is therefore split into
per-area subdirectories (`tests/unit/commands/`, `tests/unit/core/`,
`tests/unit/cli/`, `tests/unit/mcp/`, `tests/unit/extensions/`, …) instead of a
single flat directory.

When adding a unit test, place it in the matching `tests/unit/<area>/`
subdirectory (or merge into an existing spec there); never add a file directly
to `tests/unit/`. The
[`static-quality-gate directory-load contract`](../tests/integration/ci-workflow-contract.spec.ts)
test asserts the live repository stays at or below the cap and that the magic
number matches the gate default, so drift is caught before CI's `static` gate
fails.

## Search Quality Evaluation

`search-advanced` exposes an advisory golden-query harness for relevance drift checks.

Fixture source:

- `tests/search-eval/golden-queries.json`

Local run:

```bash
pm install search-advanced --project
pm reindex --mode keyword --eval --eval-fixtures tests/search-eval/golden-queries.json --json
```

Fixture authoring notes:

- Each fixture must include `query`, `expected_top_ids`, and optionally `mode` (`keyword|semantic|hybrid`) and `min_ndcg_at_5` (`0..1`).
- Keep expected IDs deterministic and scoped to stable seed data so CI does not flap.
- Add new fixtures for regressions before tuning search defaults.

The repository-native `pm eval` corpus is a required CI and release gate:

```bash
pnpm build
pnpm quality:retrieval-eval
```

`tests/search-eval/retrieval-gate-baseline.json` enforces query count, nDCG,
MRR, precision, and recall. The corpus includes at least one intentionally
non-saturated judgment set so recall regressions remain observable. The
required context-quality command also runs an impossible perfect-score negative
control and fails if `pm eval --fail-under` stops returning a non-zero exit.
Refresh the baseline only with `pnpm quality:retrieval-eval:update` after
reviewing query-level ranking changes.

## Context Quality Evaluation

The required context relevance gate proves that `pm context` and `pm next`
assemble the right bounded working set, not only that search returns relevant
documents.

Fixture and baseline sources:

- `tests/context-eval/golden-scenarios.json` — reviewable scratch,
  real-shaped, synthetic-scale, and returning-agent continuity judgments.
- `tests/context-eval/baseline.json` — committed aggregate and per-scenario
  metrics from the accepted structural/scorer behavior.

Run the required gate locally:

```bash
pnpm build
pnpm quality:context-eval
```

The gate creates isolated temporary trackers through `PmClient`, reads them only
through the public `context()` / `next()` SDK primitives, and reports nDCG,
reciprocal rank, required-item recall, continuity coverage, token-budget
adherence, and served-item signal attribution. It fails when an explicit corpus
threshold is missed or any aggregate metric regresses below the committed
baseline.

Benchmark and evaluation populations that need realistic project structure
should use the public SDK shapes documented in
[Portable Corpus Shapes](CORPUS_SHAPES.md). `pnpm benchmark:corpus-shapes`
remeasures the same SDK operations across equal-count `scratch` and
`representative` populations and records their measured profiles.

When a deliberate ranking change improves or intentionally redefines the golden
judgments, review the scenario-level diff first, then refresh the baseline:

```bash
pnpm quality:context-eval -- --update
pnpm quality:context-eval
```

Do not update the baseline merely to make CI green. Change judgments and
rationales in the corpus when product intent changes, and commit the corpus,
baseline, scorer tests, and SDK documentation together.

## Hosted Gate Registry

Tracked by [pm-k6t4yb](../.agents/pm/tasks/pm-k6t4yb.toon) and
[pm-b2hc4x](../.agents/pm/tasks/pm-b2hc4x.toon).

Every workflow job is discovered by its stable `workflow-file#job-id` identity
and matched exactly against `scripts/release/gate-registry.json`; human-facing
step names never define the inventory. Each registry entry declares:

- a canonical pm owner;
- the enforced workflow jobs it participates in;
- actionable failure taxonomy;
- explicit bypass policy and audit rationale;
- an executable negative-control test and assertion.

Run the fail-closed inventory locally:

```bash
pnpm quality:gate-registry
node scripts/release/gate-registry.mjs --inventory
```

`pnpm quality:static` includes the registry. A new workflow job fails until it
is declared under at least one canonical gate, and a removed or renamed job id
fails until stale policy is reconciled. Display-name edits do not mutate gate
identity. Public source claims are mapped to exact evidence strings and an
enforced registry entry so documentation cannot silently advertise advisory
behavior.
The inventory output lists registry-derived `registered` job IDs beside the
parsed `workflow_jobs`; validation requires the two sets to match exactly.

## Tracker Context-Quality Ratchets

Tracked by [pm-ips23h](../.agents/pm/issues/pm-ips23h.toon),
[pm-kpftft](../.agents/pm/tasks/pm-kpftft.toon), and
[pm-4ok4ex](../.agents/pm/tasks/pm-4ok4ex.toon), with lifecycle-stable outcome
reachability owned by [pm-g4k74y](../.agents/pm/issues/pm-g4k74y.toon) and
[pm-bzmeaa](../.agents/pm/tasks/pm-bzmeaa.toon).

The SDK-owned assurance registry stores tracker context-quality measurements,
floors, ceilings, lifetimes, enforcement, and executable negative controls in
`.agents/pm/assurance.json`. The `tracker-context-quality` gate covers stored
relationship kinds, validator debt, health checks, graph findings, structural
cut points, and typed reachability to outcome milestones. One workspace
assurance context reuses identical graph, validate, and health evaluations, so
a broad gate has one authoritative snapshot without repeatedly rescanning it.
Outcome enforcement uses an all-status reachable population, unreachable
ceiling, and basis-point floor. Active and terminal populations remain
diagnostics: absolute per-lifecycle floors would mistake normal close or reopen
transitions for relationship loss.

Run the same gate used by hosted CI:

```bash
pnpm quality:tracker-measurements
pm assurance run tracker-context-quality --trigger ci --dry-run --json
```

Every native assertion contains both a passing boundary case and an impossible
case that must fail. Changes flow through `pm assurance put`, which refuses a
weaker bound, scope, lifetime, or enforcement unless a verified Decision item
authorizes it. `scripts/release/gate-registry.json` separately inventories the
retired bespoke gate and gives every graph subcommand either a named automated
consumer or an explicit interactive-only classification.

## Agent Output Token Budgets

Run the required PR gate locally:

```bash
pnpm build
pnpm quality:token-budget
```

The isolated fixture contains a medium-scale linked workspace. Discovery
surfaces (`--help` and contract projections) use reviewable ratcheted byte
baselines. Answer surfaces including activity, deps, graph, duplicates, events,
health, list, get, context, next, search, and validate are measured against
their live SDK command contracts. A deliberately full, unbounded activity query
must exceed the default contract, proving the gate can fail when a default
becomes accidentally unbounded.

Refresh `scripts/release/token-budgets.json` only for an intentional discovery
surface change:

```bash
node scripts/release/token-budget-gate.mjs --update
pnpm quality:token-budget
```

The manifest records baseline bytes and estimated tokens for visible review
deltas. Updating it cannot raise answer ceilings, which remain owned by
`PM_COMMAND_OUTPUT_BUDGET_CONTRACTS`.

The gate derives every supported harness, model, session, and provenance
environment key from the SDK-owned harness descriptor registry. It deletes
those host inputs before each fixture invocation, then supplies only the
fixture's deterministic author and isolated tracker settings. Unrelated host
environment values remain available, so the test process stays representative
without allowing the launching agent or CI harness to change measured output.

## Linked Tests

Add tests to the item that owns the work:

```bash
pm test <item-id> --add command="node scripts/run-tests.mjs test -- tests/unit/output.spec.ts",timeout_seconds=240
pm test <item-id> --run --progress
```

For broader sweeps:

```bash
pm test-all --status in_progress --progress
```

Do not link `pm test-all` itself as an item-level test command. It creates recursive orchestration.
Use `--fail-on-empty-test-run` for release/readiness gates where selecting zero
linked tests should fail instead of producing an inconclusive pass.
Use `--progress` for long foreground sweeps; it prints parent-level
`pm test-all` selection, per-item start/end, and final summary lines in addition
to the linked-test command progress emitted by `pm test`.

## Package Ecosystem Smoke

After `pnpm build`, external package compatibility can be checked without
touching the repository tracker:

```bash
pnpm smoke:external-packages -- --limit 10
pnpm smoke:external-packages -- --package pm-changelog
```

The harness creates one temporary project per package, sets sandboxed `PM_PATH`
and `PM_GLOBAL_PATH`, installs the package with `pm install npm:<name>
--project`, runs `pm package doctor --project --detail deep --trace`, and probes
runtime contracts with `pm contracts --runtime-only --availability-only`. Use
`--discover-only` for the npm package list and `--keep-temp` only when debugging
a failing package root.

## PM Context Modes

Linked PM commands default to schema context: settings and extensions are seeded, but tracker item data stays isolated.
When a linked command is a PM tracker-read such as `pm validate`, the default mismatch error suggests
`--auto-pm-context`, which keeps schema isolation for ordinary commands and routes only tracker-read PM commands
through seeded tracker data.

The runner resolves every selected command's effective context before it
creates temporary sandboxes. Schema and non-PM runs initialize only their
schema roots; tracker roots and item data are materialized only when at least
one selected command requires tracker context. This preserves source isolation
without copying an unrelated tracker into constrained temporary storage.
Capacity, permission, and resource failures while seeding a required tracker
surface as typed, path-redacted host-environment refusals with recovery steps.

Use explicit modes when needed:

```bash
pm test <item-id> --run --pm-context schema
pm test <item-id> --run --pm-context tracker
pm test <item-id> --run --pm-context auto --check-context --auto-pm-context
```

For complex linked-test commands, prefer JSON input so shell syntax survives unchanged:

```bash
pm test <item-id> --add-json '{"command":"node scripts/run-tests.mjs test -- tests/unit/output.spec.ts","timeout_seconds":240}'
```

To rerun a focused subset without editing linked-test metadata:

```bash
pm test <item-id> --run --match output
pm test <item-id> --run --only-index 2
pm test <item-id> --run --only-last
```

Linked-command stdout and stderr are captured through temporary regular files,
then read back with the 20 MiB per-stream retention bound. This keeps inherited
descriptors blocking for Bun, Rust, and other runtimes that treat `EAGAIN` on a
non-blocking stdout pipe as fatal. Output beyond the bound is drained to disk,
the child still completes normally, and the result records a truncation notice
instead of misclassifying a transport failure as a test assertion.

Strict governance flags:

```bash
pm test <item-id> --run \
  --fail-on-context-mismatch \
  --fail-on-skipped \
  --fail-on-empty-test-run \
  --require-assertions-for-pm
```

Structured quantitative evidence can be recorded and queried without parsing
logs or comments:

```bash
pm test <item-id> --run \
  --measure coverage=100,unit=percent,threshold=100 \
  --measure p95_latency=42,unit=ms,threshold=50
pm test <item-id> --metric-below coverage=100 --metric-diff p95_latency
```

Measurements are stored on the producing `test_runs` row, retained with the
bounded run history, and exposed consistently by CLI, SDK, MCP, and contracts.

## Linked-Test Assertions

Linked tests can include assertion metadata:

```bash
pm test <item-id> --add \
  command="pm list-open --json",timeout_seconds=120,assert_json_field_gte=count:0
```

Common assertion keys include:

- `assert_stdout_contains`
- `assert_stdout_regex`
- `assert_stderr_contains`
- `assert_stderr_regex`
- `assert_stdout_min_lines`
- `assert_json_field_equals`
- `assert_json_field_gte`

## Background Runs

```bash
pm test <item-id> --run --background
pm test-all --status in_progress --background
pm test-runs
pm test-runs status <run-id>
pm test-runs logs <run-id> --tail 100
pm test-runs stop <run-id>
pm test-runs resume <run-id>
```

Background run fingerprints prevent duplicate parallel runs for the same linked-test set.
For long `test-all` runs, `pm test-runs status <run-id> --json` includes the
latest aggregate item coordinates (`item_index`, `item_total`, `item_id`) plus
linked-test coordinates and `current_command` when the child emits progress.
Use `pm test-runs logs <run-id> --stream stderr` only when the compact status
message is not enough.

The bundled `pm-linked-test-adapters` package is the first-party package
exemplar for background run management. Install it in an isolated project when
validating package-provided test-run surfaces:

```bash
pm install linked-test-adapters --project
pm package doctor --project --detail deep --trace
pm test-runs list --json
```

The package activates the `test-runs` command family and keeps subprocess
handling behind an explicit package permission declaration, so it is a useful
smoke target for package, permission, and command-contract changes.

## Release-Readiness Checks

For substantial changes:

```bash
pnpm build
pnpm typecheck
node scripts/run-tests.mjs coverage
pm validate --check-resolution --check-history-drift
pm health --check-only
```

When release readiness requires external GitHub security telemetry in addition to
local checks, run:

```bash
gh issue list --state open --limit 100 --json number,title,updatedAt,url
gh pr list --state open --limit 50 --json number,title,headRefName,reviewDecision,url
gh api "repos/unbraind/pm-cli/dependabot/alerts?state=open&per_page=100"
gh api "repos/unbraind/pm-cli/secret-scanning/alerts?state=open&per_page=100"
gh api "repos/unbraind/pm-cli/code-scanning/alerts?state=open&per_page=100"
```

`code-scanning/alerts` can return `404 no analysis found` until at least one
CodeQL run has completed.

For documentation-only changes, at minimum run:

```bash
pnpm build
rg -n "forbidden-private-token-or-path" README.md docs
```

Replace the placeholder pattern with the actual sensitive term being guarded in the current task.

## Contract Snapshot Gate

Tracked by [pm-d6kq](../.agents/pm/tasks/pm-d6kq.toon).

`pm contracts --full --json` is a public machine-readable SDK and agent surface.
Keep its committed golden snapshot current when command contracts, schemas,
aliases, or extension-provided command contracts intentionally change:

```bash
pnpm build
pnpm contracts:update
pnpm contracts:check
```

CI runs `pnpm contracts:check` in the static gate. Snapshot diffs should be
reviewed like an API change and paired with the package-owned changelog flow
when the contract surface changes intentionally.

The agent-facing output-size gate is separate from schema drift. Run
`pnpm quality:token-surface` after changing help, contracts, or MCP tool
registration. It measures root help, every advertised command help page, the
summary/default/full contracts family, and MCP `tools/list` against
`scripts/agent-token-surface-baseline.json`. Use
`pnpm quality:token-surface:update` only for an intentional reviewed change;
the baseline stores explicit byte ceilings with headroom rather than volatile
timestamps or package versions.

The CLI contract snapshot is separate from the TypeScript SDK surface snapshot.
When public SDK declarations or SDK error codes change, also run:

```bash
pnpm sdk:surface:check
```

Use `pnpm sdk:surface:update` only for reviewed additive changes. Breaking
changes require the explicit `--acknowledge-breaking "<release rationale>"`
argument documented in [SDK](SDK.md#public-surface-compatibility).
