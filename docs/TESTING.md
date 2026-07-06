# Testing

This page describes safe local tests, linked tests, coverage, and release-readiness checks.

Tracked implementation updates: [pm-52eh](../.agents/pm/features/pm-52eh.toon), [pm-mcxr](../.agents/pm/issues/pm-mcxr.toon), [pm-u42x](../.agents/pm/issues/pm-u42x.toon).

## Agent Quick Context

- Unit and integration tests must not read or write real `.agents/pm` data.
- Prefer `node scripts/run-tests.mjs ...` because it creates sandboxed `PM_PATH` and `PM_GLOBAL_PATH`.
- Linked tests added through `pm test` should use sandbox-safe commands.
  Package-manager scripts such as `pnpm test` are allowed because linked-test
  execution injects isolated `PM_PATH` and `PM_GLOBAL_PATH`; direct runners such
  as `vitest` still need `node scripts/run-tests.mjs ...` or inline sandbox env.
- Run linked tests before closing the item that owns the work.

Tracked documentation work: [pm-u9d0](../.agents/pm/epics/pm-u9d0.toon).

## Standard Local Checks

```bash
pnpm build
pnpm lint
pnpm typecheck
node scripts/run-tests.mjs test
node scripts/run-tests.mjs coverage
```

`node scripts/run-tests.mjs` wraps Vitest in temporary tracker roots, then cleans them up.

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

## Focused Test Runs

```bash
node scripts/run-tests.mjs test -- tests/unit/output.spec.ts
node scripts/run-tests.mjs test -- tests/integration/cli.integration.spec.ts
```

Use focused runs while iterating, then run coverage before closure when risk or scope warrants it.

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

CI currently runs this gate in advisory mode (`continue-on-error: true`), so failures do not block merges by default; treat failing nDCG as a quality signal to investigate, not as a silent ignore.

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

Strict governance flags:

```bash
pm test <item-id> --run \
  --fail-on-context-mismatch \
  --fail-on-skipped \
  --fail-on-empty-test-run \
  --require-assertions-for-pm
```

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
