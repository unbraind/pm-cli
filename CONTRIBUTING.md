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
2. Keep docs aligned with behavior (`PRD.md`, `README.md`, `AGENTS.md`) before implementation changes.
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

## Extension Development

`pm-cli` extensions live in `.agents/pm/extensions/` (project) or `~/.pm-cli/extensions/` (global). Each extension needs:

1. A manifest file `manifest.json` declaring `name`, `version`, `entry`, `priority`, and `capabilities`.
2. An entry module exporting `activate(api)`.

The `api` object provides:

- `api.registerCommand({ name, run })` — add or override command handlers.
- `api.registerRenderer(format, renderer)` — override `toon`/`json` output.
- `api.registerImporter(name, importer)` — adds `<name> import` command path.
- `api.registerExporter(name, exporter)` — adds `<name> export` command path.
- `api.registerFlags(targetCommand, flags)` — declare flags for extension commands.
- `api.registerItemFields(fields)` — declare custom schema fields.
- `api.registerMigration(def)` — declare schema migrations.
- `api.registerSearchProvider(provider)` — add custom search providers.
- `api.registerVectorStoreAdapter(adapter)` — add custom vector store adapters.
- `api.hooks.beforeCommand/afterCommand/onWrite/onRead/onIndex` — lifecycle hooks.

Only register capabilities that are listed in your manifest's `capabilities` array. Registration outside declared capabilities fails extension activation deterministically.

Run `pm health` to inspect extension load/activation status and migration summaries.

## Pull Requests

- Include focused scope and rationale.
- Confirm all checks pass (`pnpm build && pnpm typecheck && pnpm test:coverage`).
- Update docs/contracts when behavior changes (`PRD.md`, `README.md`, `AGENTS.md`).
- Add/maintain tests for any new behavior (100% coverage required).
- Reference relevant `pm` item IDs in PR description.
