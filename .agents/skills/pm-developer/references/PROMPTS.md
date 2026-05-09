# Prompt Templates

## Implement Feature

`Implement <feature> on <ID>. Reuse existing architecture, link all changed files/tests/docs, run targeted + coverage checks, and append evidence before close.`

## Fix Bug

`Fix <bug> on <ID>. Add a regression test, keep the patch minimal, run focused tests first, then full gate commands if scope expands.`

## Refactor

`Refactor <area> on <ID> without behavior changes. Preserve API contracts, update docs where command behavior is clarified, and validate with existing regression suite.`

## Release Readiness Sweep

`Perform release readiness checks for <ID>. Run build, coverage, static quality, secret scan, and release gates. Document all results in a closure comment.`
