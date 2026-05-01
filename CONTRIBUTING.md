# Contributing to pm-cli

Thanks for helping improve `pm-cli`. This project is designed for deterministic, agent-friendly workflows and uses `pm` itself as the source of truth for planning and implementation tracking.

## Prerequisites

- Node.js 20+
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
- Update relevant user-facing docs when behavior changes, but keep enforcement in `pm` data and runtime tests.
- Keep private operations artifacts out of tracked public docs and package output.
- Add/maintain tests for any new behavior (100% coverage required).
- Reference relevant `pm` item IDs in PR description.
