# Broad Test Audit Campaign

Use only for an authorized broad sweep. Adapted from the upstream
[campaign procedure](https://github.com/openclaw/openclaw/blob/e0d80000067d224e93af6107ed093a21e046879f/.agents/skills/test-audit/CAMPAIGN.md).

1. **Pin a baseline.** Record the commit, test inventory, full-suite outcomes,
   coverage, and existing failures in the canonical pm item. Baseline failures
   are investigations, not permission to discard tests. Check all-status lineage
   before creating follow-ups.
2. **Partition by owner.** Include SDK domains, CLI/MCP adapters, packages,
   release scripts, plugins, and shared harnesses within the requested scope.
   Assign each test one lane. If delegation is authorized, use read-only
   discovery lanes first and a single integration owner for shared harnesses.
3. **Build the ledger.** Apply [audit evidence](AUDIT.md) to every declaration in
   scope; distinguish table rows with different contracts. Mark retain, repair,
   consolidate, or delete. Record uncovered/unread inventory explicitly instead
   of claiming a complete sweep.
4. **Consolidate with proof.** Name and strengthen the keeper first. Preserve
   real SDK behavior and distinct CLI/MCP serialization, error, lifecycle,
   persistence, package, and release guarantees. A fake external service can be
   useful; a mock implementing the production algorithm proves nothing.
5. **Integrate coherently.** Serialize shared build/harness edits, remove only
   obsolete private seams, and update routing/inventory when required. Preserve
   the canonical coverage denominator and every mandatory gate. Do not weaken
   caps, thresholds, documentation requirements, or lint rules to pass.
6. **Check preservation independently.** Revisit each removed contract against
   the keeper and current production boundary. Use targeted mutations or pre-fix
   controls in an isolated copy with temporary `PM_PATH` and `PM_GLOBAL_PATH`
   for every direct stateful CLI command to establish meaningful failure. Record exact
   changed bytes, failure reason, restoration, and passing rerun. Never mutate
   the working tree under a running test command.
7. **Handle product defects explicitly.** Track a real defect separately within
   the coherent delivery, with failing-before/passing-after proof and the
   repository's structured defect evidence. Reuse existing lineage; do not hide
   unrelated repairs inside mass test deletion.
8. **Reconcile and verify.** Incorporate upstream changes without force-pushing
   shared history. Reassess newly introduced contracts rather than blindly
   preserving deletions. Run focused tests, full suite/coverage, static quality,
   and affected acceptance/package/performance gates on the integrated tree.
9. **Hand off honestly.** Report baseline and final counts, covered lanes, named
   keepers, production seams removed, regressions demonstrated, full commands,
   results, and remaining risks. A review inventory is not a correctness
   certificate. Follow the authorized PR workflow; unavailable reviewers are
   unavailable evidence, not approval.

Update pm files/docs/tests/comments and durable learnings as evidence accrues.
Close only implemented work with structured results and release ownership.
