# Contributing to pm-cli

Thanks for helping improve `pm-cli`. This project is designed for deterministic, agent-friendly workflows and uses `pm` itself as the source of truth for planning and implementation tracking.

## Prerequisites

- Node.js 22.18+
- pnpm 10+

## Setup

```bash
pnpm install
pnpm build
node dist/cli.js --help
```

## Maintainer Bootstrap (Dogfooding Runs)

For maintainer sessions that mutate real tracker data in this repository:

```bash
# from repository root
export PM_AUTHOR="maintainer-agent"

# refresh global pm from this repository and verify availability
npm install -g .
pm --version

# prefer global pm after refresh; fallback to the built CLI if needed
export PM_CMD="pm"
# export PM_CMD="node dist/cli.js"

$PM_CMD --version
node -v
pnpm -v
pnpm build
```

For real repository tracking, do not override `PM_PATH`.
For tests, always use sandboxed storage via `node scripts/run-tests.mjs ...` (sets both `PM_PATH` and `PM_GLOBAL_PATH`).

## Development Workflow

1. Track work in `pm` items (claim, link files/tests/docs, and log comments/evidence).
2. Treat `pm` data and runtime behavior as the source of truth; update user-facing docs as needed without using them as test contracts.
3. Prefer small, reviewable changesets with deterministic behavior.

## Testing

Run standard checks:

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm test:coverage
```

For pm-linked safe execution (required when running tests through `pm test` / `pm test-all`), use:

```bash
node scripts/run-tests.mjs test
node scripts/run-tests.mjs coverage
```

The runner creates a temporary sandbox and sets `PM_PATH` and `PM_GLOBAL_PATH` so tests never touch repository planning data.

When validating linked-test automation behavior, include guard-flag coverage for `--fail-on-skipped`, `--fail-on-empty-test-run`, and `--require-assertions-for-pm`.

When changing validation behavior, include targeted checks for:

- `pm validate --check-metadata --metadata-profile core|strict|custom`
- `pm validate --check-files --scan-mode tracked-all`
- `pm validate --check-files --scan-mode tracked-all-strict`

## Code Quality Gates (no regressions)

Every change must *only improve* the codebase — CI blocks any pull request that
introduces a new quality issue. Run the lint suite before pushing:

```bash
pnpm lint           # eslint (recommended + complexity + maintainability) + jscpd duplication + static-quality gate
```

**ESLint strict baseline.** The flat config layers `@eslint/js` recommended,
`typescript-eslint` recommended, and the CodeFactor-calibrated maintainability
rules over *all* surfaces including tests, with
`reportUnusedDisableDirectives: "error"` so stale inline disables fail the run.
It also enforces twin complexity ceilings — no function may exceed **16** on
either metric: `complexity` (cyclomatic) max 16 and
`sonarjs/cognitive-complexity` max 16. The cognitive ceiling is the
load-bearing half of the CodeFactor "Complex Method" calibration: CodeFactor's
detector is nesting-weighted, and GH-518 proved a cyclomatic-14 method can
still be flagged (cognitive 22) while a flat cyclomatic-16 function passes.
The full set of pre-existing violations is grandfathered in
`eslint-suppressions.json` (ESLint native bulk suppressions), so:

- A **new** complex method (or making an existing one worse) fails `pnpm lint` in
  CI — you must simplify it.
- **Fixing** a complex method makes its suppression unused, which also fails lint
  until you prune the baseline. Run `pnpm lint:eslint:prune` and commit the smaller
  `eslint-suppressions.json` — the baseline only ever shrinks.

Do not regenerate the whole baseline (`pnpm lint:complexity:baseline`) to silence a
new violation; that defeats the gate — and the static quality gate enforces a hard
budget (`MAX_ESLINT_SUPPRESSIONS` in `scripts/release/static-quality-gate.mts`) on
the baseline's total size, so growing it fails CI outright. Lower the budget as the
baseline burns down. Driving the baseline to empty is the path to a CodeFactor
**A+** (tracked under epic `pm-92if`).

**jscpd duplication gate.** `jscpd` runs in `strict` mode with `threshold: 0`
(any clone ≥ 22 lines / 115 tokens across src, packages, plugins, scripts,
docs/examples, and tests fails). Extract shared helpers instead of loosening
`.jscpd.json`.

**Inline pragma budgets.** The static quality gate enforces hard ceilings on the
inline escape hatches that could otherwise silence a gate without touching any
config file a reviewer would watch: inline `eslint-disable` comments, coverage
ignore pragmas (`v8 ignore` / `c8 ignore` / `istanbul ignore`), and
`jscpd:ignore` blocks (budget 0 — never allowed). The ceilings live in
`scripts/release/static-quality-gate.mts` (`MAX_INLINE_ESLINT_DISABLES`,
`MAX_COVERAGE_IGNORE_PRAGMAS`, `MAX_JSCPD_IGNORE_PRAGMAS`); adding a new pragma
anywhere in the scanned surfaces fails CI. Lower the budgets as usage burns
down — never raise them.

**Security & script gates (`.github/workflows/security.yml`).** Every PR also
runs Trivy (dependency vulnerabilities, secrets, misconfigurations — any
HIGH/CRITICAL finding fails), ShellCheck at `--severity=style` over all tracked
`*.sh`, PSScriptAnalyzer over all tracked PowerShell at Error/Warning/Information
severity, and actionlint over the workflows themselves. All four are required
branch-protection checks.

**Greptile review.** `pnpm review:greptile:gate` runs the Greptile CLI reviewer over
the current branch and fails on findings. It is wired into `pnpm release:gates`
(skip with `--skip-greptile`) and skips gracefully when the Greptile CLI is
unavailable or unauthenticated, so token-less CI never blocks on it; the Greptile
GitHub App still reviews every PR independently.

## Terminal Compatibility Checks

When changing stdin, output, exit handling, or linked test execution, run targeted terminal-compatibility regressions before full-suite validation:

```bash
node scripts/run-tests.mjs test -- \
  tests/unit/parse-utils.spec.ts \
  tests/unit/beads-command.spec.ts \
  tests/unit/test-command.spec.ts \
  tests/integration/cli.integration.spec.ts \
  tests/integration/release-readiness-runtime.spec.ts
```

Behavior expectations to preserve:

- Interactive TTY stdin is rejected for piped-only `-` inputs with actionable guidance.
- Exit-code mappings stay stable (`0..5`) while CLI failures remain deterministic.
- Linked test orchestration remains non-interactive and reports timeout/maxBuffer failures clearly.

## Developer Documentation

Start with the [documentation index](docs/README.md). Focused pages:

- [Onboarding](docs/ONBOARDING.md) - first-two-hours maintainer and contributor setup.
- [Quickstart](docs/QUICKSTART.md) - first repository setup and item lifecycle.
- [Agent Guide](docs/AGENT_GUIDE.md) - canonical `pm` workflow for coding agents.
- [Command Reference](docs/COMMANDS.md) - command families and examples.
- [Configuration](docs/CONFIGURATION.md) - settings, output, storage, search, and validation.
- [Testing](docs/TESTING.md) - sandbox-safe local and linked-test workflows.
- [Architecture](docs/ARCHITECTURE.md) - source tree, storage, mutation contract, history, search, and extension host internals.
- [Extensions](docs/EXTENSIONS.md) and [SDK](docs/SDK.md) - extension lifecycle and public SDK.
- [Releasing](docs/RELEASING.md) - maintainer release procedure.

## Extension Development

`pm-cli` extensions live in `.agents/pm/extensions/` (project) or `~/.pm-cli/extensions/` (global). See [docs/EXTENSIONS.md](docs/EXTENSIONS.md) for the full guide. Each extension needs:

1. A manifest file `manifest.json` declaring `name`, `version`, `entry`, `priority`, and `capabilities`.
2. An entry module exporting `activate(api)`.

The `api` object provides:

- `api.registerCommand({ name, run })` — add or override command handlers (`handler` remains backward-compatible but emits migration warning; prefer `run`).
- `api.registerRenderer(format, renderer)` — override `toon`/`json` output.
- `api.registerImporter(name, importer)` — adds `<name> import` command path.
- `api.registerExporter(name, exporter)` — adds `<name> export` command path.
- `api.registerFlags(targetCommand, flags)` — declare flags for extension commands.
- `api.registerItemFields(fields)` — declare custom schema fields.
- `api.registerMigration(def)` — declare schema migrations.
- `api.registerSearchProvider(provider)` — add custom search providers.
- `api.registerVectorStoreAdapter(adapter)` — add custom vector store adapters.
- `api.hooks.beforeCommand/afterCommand/onWrite/onRead/onIndex` — lifecycle hooks.

Use the published SDK import path for extension type contracts:

```ts
import { defineExtension, type ExtensionApi } from "@unbrained/pm-cli/sdk";
```

Dispatch behavior is extension-first for registered command handlers: matching extension command paths can replace core command execution at runtime. Keep compatibility in mind and provide explicit rollback instructions (`--no-extensions`) in docs/tests when introducing new override behavior.

Only register capabilities that are listed in your manifest's `capabilities` array. Registration outside declared capabilities fails extension activation deterministically.

Run `pm health` to inspect extension load/activation status, capability guidance/contract metadata, and migration summaries.
Use `pm extension --doctor --detail deep --trace` when triaging activation failures, and `pm extension --manage --runtime-probe` when you need opt-in runtime parity in manage output.
When unmanaged extension state is expected to be managed, use `pm extension --doctor --fix-managed-state` or `pm extension --manage --fix-managed-state` before re-running diagnostics.

## Pull Requests

- Include focused scope and rationale.
- Confirm all checks pass (`pnpm build && pnpm typecheck && pnpm test:coverage`).
- CI runs the full build/test matrix — `ubuntu-latest` (Node 22, 24) and `macos-latest` (Node 24) — on every pull request and on `main` pushes (doc/markdown-only pushes to `main` are skipped via `paths-ignore`; pull requests always run regardless of the changed paths). Nightly keeps broader regression coverage (Windows and Node 25).
- Update relevant user-facing docs when behavior changes, but keep enforcement in `pm` data and runtime tests.
- Keep private operations artifacts out of tracked public docs and package output.
- Add/maintain tests for any new behavior (100% coverage required).
- Reference relevant `pm` item IDs in PR description.
