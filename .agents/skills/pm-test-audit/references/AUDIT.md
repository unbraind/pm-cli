# Evidence Before Removing a Test

Start with read-only discovery. Test count, runtime, coverage percentage, or a
suspicious name is a lead, not proof that a test is low-value.

## Candidates to Investigate

- Assertion-free probes, self-comparisons, or expected values calculated by the
  same implementation under test.
- Copied export/manifest inventories or source-text checks without an independent
  compatibility, packaging, security, or architecture contract.
- Private predicate, mock-call-shape, and wiring assertions that repeat stronger
  observable behavior coverage.
- Identical scenarios across SDK, CLI, MCP, and packages without distinct
  boundary failure modes; prefer a named keeper over another copy.
- Fixtures that pre-seed the receipt, ordering, admission, or callback result the
  production owner should produce; persistence tests that never write anything.
- Tests that assert a flag was forwarded but never prove its promised behavior.
- Test-only production exports, globals, wrappers, dead branches, or injected
  switches with no supported consumer contract.
- Negative controls that fail at an unrelated guard, and names claiming behavior
  that their assertions never observe.

Read the complete test and production owner, trace non-test callers and relevant
callees, and inspect overlapping tests, CI routing, history, and configuration.
Do not assume no in-repo caller means a published SDK export is unused.

## Reasons to Retain

Keep independent public SDK, protocol, configuration, migration, storage,
security, platform, default, package/release, and generated cross-language
contracts. Observable ordering can be a contract. Static inspection can be the
cheapest independent architectural guard; ask whether it survives harmless
identifier refactoring. Slowness and use of mocks are not deletion criteria on
their own. A previously failing retained test may expose a product defect.

## Candidate Ledger

For each candidate, record:

| Evidence | Required detail |
| --- | --- |
| Identity | Exact path and test/table row; production owner and callers |
| Failure | Credible regression the assertion can detect |
| Contract | Independent external obligation, or why none exists |
| Overlap | Named keeper and distinct behavior it still proves |
| Seam | Production change deletion would permit, or none |
| Decision | Retain, repair, consolidate, or delete, with rationale |
| Verification | Exact command, negative control where appropriate, and result |

Establish the keeper before removing duplicates. Remove private obsolete seams
only after caller and public-contract checks. Prefer simpler production code,
but do not use net lines deleted as a success quota. Avoid trivial one-use
wrappers or test helpers that merely mirror the implementation.
