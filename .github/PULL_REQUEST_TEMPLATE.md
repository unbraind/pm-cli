## Summary

<!-- Brief description of the change and what it addresses. -->

## Related items

<!-- pm item ID(s) this PR addresses (e.g. pm-a1b2). -->
<!-- pm get pm-a1b2 to see full context. -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Documentation update
- [ ] Refactoring (no behavior change)
- [ ] CI/tooling change
- [ ] Other: <!-- describe -->

## Checklist

- [ ] `pnpm build` passes
- [ ] `pnpm typecheck` passes
- [ ] `node scripts/run-tests.mjs coverage` passes at 100% coverage (lines/branches/functions/statements)
- [ ] `pnpm version:check` passes (calendar release version policy)
- [ ] `pnpm security:scan` passes (no tracked credential leaks)
- [ ] `pnpm smoke:npx` passes (packaged npx executable smoke test)
- [ ] All linked pm item files/tests/docs are updated
- [ ] PRD.md / README.md / AGENTS.md updated if behavior changed
- [ ] CHANGELOG.md updated under `[Unreleased]`
- [ ] No manual edits to `.agents/pm/**` (only via `pm` commands)

## Test evidence

<!-- Paste the test output summary or a link to the CI run. -->
<!-- Example: "535 tests passed; All files 100% coverage" -->
