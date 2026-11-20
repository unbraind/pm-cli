# Repository Testing

Repository-only: this page is excluded from the npm package. It describes the
checks this repository runs on itself: standard local checks, CI layout and
retries, coverage governance, quality gates and release readiness. Product
linked-test behavior (`pm test`, context modes, source workspace modes and
command trust) is documented in [Testing](TESTING.md). Split from Testing to
keep contributor-only material out of the published package (pm-998juj).

## Standard Local Checks

```bash
pnpm build
pnpm lint
pnpm typecheck
node scripts/run-tests.mjs test
node scripts/run-tests.mjs coverage
```

Coverage mode records assertion results in a fresh, private runner workspace.
Its verdict distinguishes those results from Vitest's process exit and the
independent exact-count coverage gate. Vitest can exit nonzero for coverage or
reporter failures even when assertions passed. Missing or malformed receipts
never establish a passing assertion result. Exit codes retain their existing
meaning: `1` for a Vitest refusal, `2` for an exact-gate refusal, and `3` when
both processes refuse admission. No coverage threshold or source denominator
is reduced. This behavior is tracked by
[pm-qmb6h8](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-qmb6h8.toon)
(repository-only tracker record, excluded from npm).

The Linux killed-owner integration suite always exercises Node. Its additional
Bun case runs locally when `bun --version` succeeds; CI requires Bun and retains
the case even when the executable is missing, so a broken CI setup fails visibly.
Install Bun before claiming local Node-and-Bun recovery coverage. This fixture
policy is tracked by
[pm-gh1609](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-gh1609.toon)
(repository tracker record excluded from npm).

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

The full-source command-example scan runs after parallel contract files in the
existing serial cohort. It keeps the same source corpus, assertions and
30-second deadline, so concurrent contract workers do not consume its
policy-check budget. This allocation is tracked by
[pm-a3c6g4](../.agents/pm/tasks/pm-a3c6g4.toon); broader runner qualification
remains with [pm-bj7rq0](../.agents/pm/issues/pm-bj7rq0.toon).

The same cohort runs the complete cold transport-floor and executable refusal
gate fixture files after parallel contracts
([pm-serial-cold-gates](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-serial-cold-gates.toon),
a repository-only tracker record excluded from npm). Their original 30-second
and 360-second test deadlines, assertions, negative controls, retries, and product
benchmark thresholds are unchanged. Isolated passes qualify this allocation;
they do not establish passing product latency or replace complete-suite proof.

The same serial cohort runs the ten-thousand-item aggregation, cold governance
read, and surface-replication fixture files after parallel contracts
([pm-ckb8w5](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-ckb8w5.toon),
a repository-only tracker record excluded from npm). Their original input
populations, assertions, per-test deadlines and retry policy remain in force.

The context decision keeper also runs in that phase, preserving its 200-item
corpus and 30-second completion-regression deadline. Allocation is tracked by
[pm-j2vwbh](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-j2vwbh.toon)
(a repository-only tracker record excluded from npm).

`node scripts/run-tests.mjs` wraps Vitest in temporary tracker roots, disables
external Sentry delivery for the build, test workers, and their nested CLI
children, then cleans the roots up. Instrumentation tests can still exercise
Sentry initialization through their mocked module boundary; ordinary negative
fixtures must never create production incidents from a developer host.

Temporary directories must live outside the checkout and outside any ancestor
workspace with initialized tracker data. The runner rejects a checkout-local
temporary root and every initialized standard or root-layout ancestor tracker,
including physical symlink aliases, before allocating fixtures or starting build
or test processes ([pm-bukwmy](../.agents/pm/issues/pm-bukwmy.toon),
[pm-runner-ancestor-tracker](../.agents/pm/issues/pm-runner-ancestor-tracker.toon)).
Unrelated valid settings files remain admissible; unreadable or invalid ancestor
settings refuse ancestry certification. If the default
temporary filesystem is full, set `TMPDIR` (or `TEMP`/`TMP` on Windows) to an
existing isolated scratch directory; an ignored directory inside the repository
is not isolated. Filesystem fixtures must honor `node:os`'s `tmpdir()` and remove
only the temporary directories they created.

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

`pnpm lint` and `pnpm quality:static` are the same canonical local static gate.
The gate layers ESLint rules for
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

Module-usage checks share the SDK boundary's literal-specifier parser and walk
nested AST nodes, including lazy `import("./module.js")` references. Unused
modules, comment-only references, and computed paths do not gain incoming
references. The regression is tracked by
[pm-f38ovr](../.agents/pm/issues/pm-f38ovr.toon); no module allowance or threshold
increase is required to keep optional SDK capabilities lazy.

The same required static gate validates an explicit seven-day Dependabot
cooldown for every updater and requires both npm and GitHub Actions entries.
Missing values, semver overrides outside 7–90 days, invalid YAML, removed
updaters, and include/exclude bypasses fail the gate. The maximum follows
[GitHub's cooldown limits](https://docs.github.com/en/code-security/tutorials/secure-your-dependencies/optimizing-pr-creation-version-updates).
Security updates retain GitHub's separate security-update behavior.
The negative controls are tracked by [pm-gkut](../.agents/pm/issues/pm-gkut.toon)
and [pm-dmo5](../.agents/pm/issues/pm-dmo5.toon).

Release synchronization and commit staging share one distribution manifest
inventory. The [pm-t4prek regression](../tests/unit/scripts/release/version-manifests.spec.ts)
bumps versions in a temporary Git repository and reads the resulting commit to
verify workspace versions and exact plugin runtime pins. The pipeline checks
version consistency immediately before staging, including required string
versions and runtime pins in both plugin package manifests; tests of a prepared working
tree alone cannot establish that the release commit contains those changes.

`lint:duplicates` runs three zero-clone profiles: the broad repository profile,
the production cross-format profile, and a supplemental long-table profile at
28 lines / 80 tokens. The last profile detects the historical GH-508 normalizer
tables below the other profiles' token floors; it does not replace their shorter
line thresholds. Its real detector regression rejects the historical table rows
and accepts a shared declaration. The earlier 12-line / 60-token exploratory
census informed calibration, but is not the enforced profile. These bounded
profiles do not claim complete equivalence with hosted analyzers.
See [pm-xspd](../.agents/pm/chores/pm-xspd.toon) for calibration evidence.

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

## Published Workspace Compatibility

Tracked by [pm-pae3wo](../.agents/pm/tasks/pm-pae3wo.toon) and [pm-gh1458](../.agents/pm/issues/pm-gh1458.toon).
Run `node scripts/release/workspace-compatibility.mjs --json` after building.
The policy in `scripts/release/workspace-compatibility-policy.json` requires
the two immediately preceding stable calendar releases. Each installed release
writes a disposable workspace read by the current runtime, and the current
runtime writes one read by that release. Exact scalar and container values must
survive CLI and public SDK reads, ordinary writes with their registration
disabled, history restoration, native Git merges, reconciliation, and history
verification. Missing releases, metadata loss, or invalid merged histories fail
the gate. CI, nightly quality, release publication, and local preflight require
this matrix alongside the independent legacy Markdown migration check.

Metadata probes and installs explicitly use the public npm registry with
separate empty user/global configurations and a fresh temporary cache. Inherited
npm settings and registry-auth environment variables are removed, so host
configuration cannot change the artifacts selected by the declared window.

The current item-operation boundary refuses a stored `pm_format_version`
ahead of its supported version with `item_format_version_unsupported` and
upgrade guidance. Reads, updates, deletion, and restoration preserve the
original item/history on refusal, including documents whose metadata/body
shapes are invalid for the current runtime. Admission precedes schema validation
so restore cannot misclassify newer data as ordinary corruption. Static fixture
modules read separate JSON data; published SDK probes use the public package
entrypoint from their own consumer directory. Raw parsers still preserve future version
markers for integrity inspection; inventory diagnostics are not permission to
rewrite an unsupported item.

Format 1 remains readable and is still used for ordinary records. Persisting
linked-test editor stamps requires format 2, and a linked-test setup entry
(`phase: setup`) requires format 3, on create as well as on edit. The same mutation records that
marker in history; ordinary subsequent writes, restoration and current-runtime
merges retain it. Restoring an older state does not lower the reader requirement
while newer history remains. Existing format-1 editor records written by
2026.10.12–13 keep their original hashes during inspection and acquire the
format-2 guard on the next real write. Upgrade every reader, CI runtime and Git
merge driver before operating on guarded records. Never re-anchor history or
remove the marker to make an older verifier pass.

The additional published-artifact matrix pins the reported 2026.10.9, 10 and 13
hosts. It proves original history-prefix preservation, exact nested stamps,
write refusal when the project still pins 2026.10.9, and CLI/public SDK format
refusal by 2026.10.10 and 13 without byte changes, ordinary
current writes, restored states, and native Git merge/reconciliation with the
upgraded driver. Baseline records still pass the two-prior-release matrix.
The 2026.10.9 host predates format admission and is not a supported reader of
guarded records; update project pins and resolved dependencies before writing
them. That host's mutation bootstrap can then reject the newer project pin.

Run the matrix from the built workspace root. Exact-tag release recovery retains
the reviewed matrix controls, policy and static fixtures outside the checkout,
then tests the selected tagged runtime through its manifest and public SDK. A
historical tag need not contain newly added gate scripts; recovery still runs
the mandatory matrix without rewriting the tagged source or skipping policy.

## Focused Test Runs

```bash
node scripts/run-tests.mjs test -- tests/unit/core/output/output.spec.ts
node scripts/run-tests.mjs test -- tests/integration/cli.integration.spec.ts
```

Use focused runs while iterating, then run coverage before closure when risk or scope warrants it.

## CI Job Layout and Runner Budget

Every pull-request push draws from the account-wide hosted-runner pool (20
concurrent jobs, 5 on macOS, shared by every repository on the account), so the
required CI asks for as few runners as the proofs allow
([pm-m6ig79](../.agents/pm/issues/pm-m6ig79.toon)):

| Job | Runs |
| --- | --- |
| `Build foundation (Ubuntu, Node 24)` | Build, `dist` artifact, packed tarball. |
| `Packed runtime (<os>)` × 3 | Packed first run on Node 22.18.0 and 24 in isolated prefixes, dist version smoke; Ubuntu adds the Node 22 telemetry and snapshot regressions, macOS the native shell and portability checks, Windows the full npm npx and Bun bunx acceptance. |
| `Gates (static)` | Typecheck, version, changelog, secret scan, `pnpm lint` (`quality:static`), package artifact, token budgets, tracker merge-safety and assurance gates. |
| `Gates (smokes)` | Shell completion, npx/plugin smokes, host isolation, context evaluation, compatibility migration and published workspace compatibility. |
| `Coverage shard N/4` × 4, `Gates (coverage)` | Sharded coverage, then the merged 100% threshold. |
| `Windows regression cohort` × 3, `Windows regression (Node 24)` | Script and native Windows cohorts, all running at once, then their aggregate. |

Add a proof as a step inside the job that owns its platform and runtime rather
than as a new job: a sub-minute job still waits in the shared queue before it
starts.

## CI Retry and Timeout Diagnostics

The required `Gates (coverage)` job runs after the coverage matrix settles and
explicitly requires every shard to succeed. Failed, canceled, skipped, or missing
shard outcomes fail that required context before checkout or report merging.
Shard artifacts retain failure diagnostics. After successful shard admission,
coverage-threshold failures still retain merged reports and Codecov uploads.
This enforcement is tracked by [pm-0p4aal](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/issues/pm-0p4aal.toon).
Tracker records live in the repository and are excluded from the npm package.

Platform regressions from [pm-hrhfgi](../.agents/pm/issues/pm-hrhfgi.toon) and
[pm-zk67yf](../.agents/pm/issues/pm-zk67yf.toon) have portable negative controls.
Complete source scans process at most 32 item files per batch; the descriptor
pressure fixture fails unbounded reads while requiring genuine permission
failures to remain visible. The 10,000-item aggregation fixture separately
verifies completeness before pagination. Git fixtures that assert exact bytes
declare repository-local `core.autocrlf=false` and `core.eol=lf` so host defaults
cannot change the restoration target. Send generated shell scripts through
stdin (`bash -s`) so their size cannot exceed Windows command-line limits.
Runtime compaction is tested through a
real directory alias as well as its physical path, including original source
mapping and repeated-compaction byte stability. These tests run in the full
suite on the Nightly Validation platform matrix.

CI retains the 30-second per-test timeout and retries one failed attempt. A
test that passes only on retry is reported as flaky rather than silently folded
into the pass count; a persistent assertion still fails after the bounded
retry. Local runs do not retry, so deterministic failures stay immediate while
iterating.

The complete receipt-operation, receipt-health classification, aborted-operation recovery, receipt-settlement, merge-portability and
lossless-collection-union integration files run in the existing serial
`lifecycle-performance` project after parallel contracts. Both nightly shards and
full coverage use that same project partition, retaining every case and its
original assertions, deadlines and retry policy. This allocation is tracked by
[pm-89297t](../.agents/pm/tasks/pm-89297t.toon) and
[pm-receipt-serial](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/tasks/pm-receipt-serial.toon)
(tracker records are excluded from npm); it does not classify or erase
historical failed attempts.

The complete nightly suites use two Vitest shards on Linux Node 22/26 and
macOS Node 24, and four shards on Windows Node 24 and Linux Node 24 coverage.
Every partition must pass within the existing 20-minute job limit. Sharding
retains the complete file population, serial phase, assertions, per-test
deadlines and retry policy. Linux coverage blobs merge only after all native
partitions succeed; the aggregate retains exact 100% lines, branches, functions
and statements. Missing, canceled, skipped or failed partitions refuse admission.
The recurrence collector retains retired families alongside current partitions
and the coverage aggregate, preserving original failed attempts. This allocation
is tracked by [pm-gxq0dt](../.agents/pm/issues/pm-gxq0dt.toon); the prior macOS
allocation remains completed in [pm-qrirz8](../.agents/pm/tasks/pm-qrirz8.toon).

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
- Vitest 5 clears every mock's recorded calls before each test (`clearMocks` defaults to `true`; [pm-fokyhh](https://github.com/unbraind/pm-cli/blob/main/.agents/pm/chores/pm-fokyhh.toon), a repository-only tracker record excluded from npm). A spy created in `vi.hoisted` that observes work done while the module under test is imported must record into its own array, as the SDK exemplar entry specs do; `mock.calls` is empty by the time the test body runs.

Static quality also enforces source documentation coverage through `pnpm
quality:static`: every `src/**/*.ts` source file needs a module TSDoc block,
every exported declaration needs a non-module TSDoc block, and known generated
boilerplate summaries are rejected.

## Test Strength and Documentation Content

The required static gate also runs [SDK mutation testing and the documentation
content ratchet](QUALITY_EVIDENCE.md), tracked by
[pm-zclzll](../.agents/pm/tasks/pm-zclzll.toon) and
[pm-dvwm](../.agents/pm/chores/pm-dvwm.toon). These add behavioral and content
checks while retaining exact 100/100/100/100 coverage and all docstring floors.

## TOON Storage Round-Trip Gate

History-only lifecycle reconstruction and recovery contracts are described in
[History durability and recovery](HISTORY_RECOVERY.md). Their integration suite
is part of the required all-source test run and compares historical projections
against independently captured item files, including after removing those files.

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
pm package install search-advanced --project
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

Development tools must also pass the [development dependency security gate](https://github.com/unbraind/pm-cli/blob/main/docs/DEVELOPMENT_DEPENDENCY_SECURITY.md) (repository-only, excluded from npm), including the full audit and installed bundle integrity policy.

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

Context-intent classification has a separate calibration receipt and one
manifest-backed recovery spelling:

```bash
pnpm context:intent:calibrate
pnpm context:intent:calibrate --update
```

The gate verifies that `package.json` exposes that exact script before it reads
or refreshes `scripts/release/context-intent-calibration.json`. A missing or
renamed script therefore fails with the same command contributors are told to
run, and pnpm forwards `--update` to the calibration gate.

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

Diagnostic ceilings share the executable refusal gate:

```bash
pnpm quality:recovery-closure
```

The gate replays 117 refusal contracts: 18 closed-domain rows, 88
grammar-derived required-argument omissions, seven closed positional-action
families, and four tracker-preflight states. It also ratchets ten representative
failure paths against `PM_DIAGNOSTIC_OUTPUT_BUDGET_CONTRACTS`. Every diagnostic
must fit its declared JSON ceiling and preserve a mechanically actionable
correction; executable retry argv is never collection-truncated. The
missing-probe negative control and the authoritative tracker-state snapshot
prove that the corpus cannot silently shrink or turn a refusal into a mutation.

The gate starts every fixture command from a closed environment allowlist. It
retains only declared process-portability inputs such as `PATH`, temporary and
home roots, and Windows process-launch variables, then supplies fixed locale,
timezone, author, telemetry, and isolated tracker settings. Undeclared host
values cannot reach measured output, including future harness variables that
the descriptor registry does not yet know about.

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
