# Testing

This page describes safe local tests, linked tests, coverage, and release-readiness checks.

## Agent Quick Context

- Unit and integration tests must not read or write real `.agents/pm` data.
- Prefer `node scripts/run-tests.mjs ...` because it creates sandboxed `PM_PATH` and `PM_GLOBAL_PATH`.
- Linked tests added through `pm test` should use sandbox-safe commands.
- Run linked tests before closing the item that owns the work.

Tracked documentation work: [pm-1sb2](../.agents/pm/tasks/pm-1sb2.toon).

## Standard Local Checks

```bash
pnpm build
pnpm typecheck
node scripts/run-tests.mjs test
node scripts/run-tests.mjs coverage
```

`node scripts/run-tests.mjs` wraps Vitest in temporary tracker roots, then cleans them up.

## Focused Test Runs

```bash
node scripts/run-tests.mjs test -- tests/unit/output.spec.ts
node scripts/run-tests.mjs test -- tests/integration/cli.integration.spec.ts
```

Use focused runs while iterating, then run coverage before closure when risk or scope warrants it.

## Linked Tests

Add tests to the item that owns the work:

```bash
pm test <item-id> --add command="node scripts/run-tests.mjs test -- tests/unit/output.spec.ts",scope=project,timeout_seconds=240
pm test <item-id> --run --progress
```

For broader sweeps:

```bash
pm test-all --status in_progress --progress
```

Do not link `pm test-all` itself as an item-level test command. It creates recursive orchestration.

## PM Context Modes

Linked PM commands default to schema context: settings and extensions are seeded, but tracker item data stays isolated.

Use explicit modes when needed:

```bash
pm test <item-id> --run --pm-context schema
pm test <item-id> --run --pm-context tracker
pm test <item-id> --run --pm-context auto --check-context --auto-pm-context
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
  command="pm list-open --json",scope=project,timeout_seconds=120,assert_json_field_gte=count:0
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

## Release-Readiness Checks

For substantial changes:

```bash
pnpm build
pnpm typecheck
node scripts/run-tests.mjs coverage
pm validate --check-resolution --check-history-drift
pm health --check-only
```

For documentation-only changes, at minimum run:

```bash
pnpm build
rg -n "forbidden-private-token-or-path" README.md docs
```

Replace the placeholder pattern with the actual sensitive term being guarded in the current task.
