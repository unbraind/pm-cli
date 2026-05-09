# SDK Integration Checklist

## Contract Capture

```bash
pm contracts --schema-only --json
pm contracts --runtime-only --availability-only --json
pm contracts --command <command> --flags-only --json
```

## Implementation Rules

- Use `@unbrained/pm-cli/sdk` exports only.
- Do not import internal runtime modules from `src/core/...`.
- Keep action/flag mappings derived from `pm contracts` outputs.
- Handle extension-unavailable states through availability metadata.

## Validation

```bash
pnpm build
node scripts/run-tests.mjs test -- <targeted sdk/integration tests>
node scripts/run-tests.mjs coverage
```

## Release Readiness

```bash
node scripts/release/docs-skills-gate.mjs
node scripts/release/run-gates.mjs --telemetry-mode best-effort
```
