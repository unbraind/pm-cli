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

## Pull Requests

- Include focused scope and rationale.
- Confirm all checks pass.
- Update docs/contracts when behavior changes.
- Add/maintain tests for any new behavior.
- Reference relevant `pm` item IDs in PR description.
