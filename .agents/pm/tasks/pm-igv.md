{
  "id": "pm-igv",
  "title": "M5: Built-in Pi tool wrapper extension",
  "description": "Implement Pi tool wrapper exposing action-based pm interface.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:extensions-pi",
    "core",
    "milestone:5",
    "pm-cli"
  ],
  "created_at": "2026-02-17T23:02:12.269Z",
  "updated_at": "2026-03-05T09:33:50.435Z",
  "deadline": "2026-03-13T23:02:12.269Z",
  "author": "steve",
  "estimated_minutes": 120,
  "acceptance_criteria": "Pi wrapper action mapping stays CLI-parity for supported actions, including search include-linked semantics, with deterministic args and structured result envelope.",
  "dependencies": [
    {
      "id": "pm-b1w",
      "kind": "parent",
      "created_at": "2026-02-17T23:02:12.269Z",
      "author": "steve"
    },
    {
      "id": "pm-f45",
      "kind": "blocks",
      "created_at": "2026-02-17T23:02:12.269Z",
      "author": "steve"
    }
  ],
  "comments": [
    {
      "created_at": "2026-02-19T22:35:05.742Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: add built-in Pi wrapper extension command surface with action-dispatch mapping and deterministic tool response shape; update PRD/README before code to keep docs authoritative; add unit+integration coverage for wrapper action routing and output contract."
    },
    {
      "created_at": "2026-02-19T22:37:43.443Z",
      "author": "maintainer-agent",
      "text": "Doc-first alignment completed before code edits: README now lists pi wrapper in implemented command surface and planned-extensions baseline; PRD now includes pm pi pm command contract and marks Milestone 5 Pi wrapper as partial baseline; AGENTS now notes the wrapper command path."
    },
    {
      "created_at": "2026-02-19T22:43:16.980Z",
      "author": "maintainer-agent",
      "text": "Implemented baseline Pi-wrapper extension: added built-in extension module (builtin-pi-wrapper), action dispatcher, and CLI command path  that returns  envelopes. Supported actions now include init/list-open/get/create/update/append/claim/release/search/stats with command-shaped fields and deterministic TOON/JSON content rendering."
    },
    {
      "created_at": "2026-02-19T22:43:22.720Z",
      "author": "maintainer-agent",
      "text": "Implementation note correction: added built-in extension module named builtin-pi-wrapper and CLI command path pm pi pm. The wrapper returns an object envelope with content and details and currently supports actions init, list-open, get, create, update, append, claim, release, search, and stats."
    },
    {
      "created_at": "2026-02-19T23:29:19.623Z",
      "author": "maintainer-agent",
      "text": "Evidence: pm test pm-igv --run --timeout 2400 --json passed all linked tests (coverage command + integration + unit). Coverage gate remained 100% lines/branches/functions/statements in run-tests coverage output. Regression sweeps passed: pm test-all --status in_progress --timeout 2400 --json => items=8 linked_tests=37 passed=36 failed=0 skipped=1; pm test-all --status closed --timeout 2400 --json => items=17 linked_tests=47 passed=44 failed=0 skipped=3."
    },
    {
      "created_at": "2026-02-20T00:00:23.871Z",
      "author": "maintainer-agent",
      "text": "Scope correction: replace the prior pm-cli command-wrapper implementation with a true Pi agent extension module aligned to pi extension API semantics (registerTool). Plan: update docs first to define Pi-extension artifact contract, remove pm pi CLI surface, add pi-extension code under docs/pi/extensions, add tests for action-to-args mapping and registration behavior, then run pm test + test-all evidence cycle."
    },
    {
      "created_at": "2026-02-20T00:02:09.641Z",
      "author": "maintainer-agent",
      "text": "Docs-first correction applied: removed pm pi command from CLI command-surface docs and redefined Pi wrapper as a Pi agent extension module (`docs/pi/extensions/pm/index.ts`) registered through Pi registerTool semantics. README/PRD/AGENTS now describe Pi-side loading (`pi -e ...`) and tool envelope behavior."
    },
    {
      "created_at": "2026-02-20T00:07:58.937Z",
      "author": "maintainer-agent",
      "text": "Implemented scope correction in code: removed mistaken pm CLI command path and built-in src extension wrapper (`pi` command + src/extensions/builtins/pi/*), added actual Pi agent extension source module at docs/pi/extensions/pm/index.ts that registers tool `pm` with action-based dispatch and pm->node fallback invocation, and replaced wrapper-specific tests with unit coverage for extension mapping/registration behavior."
    },
    {
      "created_at": "2026-02-20T00:35:20.960Z",
      "author": "maintainer-agent",
      "text": "Evidence (corrected Pi extension scope): pm test pm-igv --run --timeout 2400 --json passed all linked commands (coverage + integration + targeted unit). Coverage remains 100% lines/branches/functions/statements. Regression sweeps passed: pm test-all --status in_progress --timeout 2400 --json => items=8 linked_tests=37 passed=36 failed=0 skipped=1; pm test-all --status closed --timeout 2400 --json => items=17 linked_tests=47 passed=44 failed=0 skipped=3."
    },
    {
      "created_at": "2026-02-20T00:41:04.431Z",
      "author": "cursor-maintainer",
      "text": "Planned changeset: docs-first Pi wrapper parity sync to reflect currently implemented action map (including list variants, history/activity, comments/files/docs/test/test-all, health/gc, beads/todos import-export), then add targeted unit assertions for these action mappings and fallback/error envelopes."
    },
    {
      "created_at": "2026-02-20T00:42:28.895Z",
      "author": "cursor-maintainer",
      "text": "Implemented docs-first parity sync for Pi wrapper action coverage in PRD/README and expanded unit assertions in tests/unit/pi-agent-extension.spec.ts for extended action-to-CLI mapping plus failure-envelope behavior."
    },
    {
      "created_at": "2026-02-20T01:10:43.848Z",
      "author": "cursor-maintainer",
      "text": "Evidence: ran node dist/cli.js test pm-igv --run --timeout 2400 --json (linked tests 3/3 passed). Ran node dist/cli.js test-all --status in_progress --timeout 2400 --json => items=8 linked_tests=37 passed=36 failed=0 skipped=1. Ran node dist/cli.js test-all --status closed --timeout 2400 --json => items=17 linked_tests=47 passed=44 failed=0 skipped=3. Coverage remains 100% lines/branches/functions/statements in sandboxed coverage runs (node scripts/run-tests.mjs coverage)."
    },
    {
      "created_at": "2026-02-21T19:17:10.916Z",
      "author": "cursor-maintainer",
      "text": "Planned change-set: docs-first clarify Pi wrapper search parameters include includeLinked -> --include-linked mapping, then implement wrapper arg/schema support and targeted unit assertions."
    },
    {
      "created_at": "2026-02-21T19:18:11.021Z",
      "author": "cursor-maintainer",
      "text": "Docs-first update completed: PRD and README now explicitly document Pi wrapper search parity for includeLinked -> --include-linked mapping. Next step is extension schema/arg mapping + unit assertions."
    },
    {
      "created_at": "2026-02-21T19:18:55.625Z",
      "author": "cursor-maintainer",
      "text": "Implemented includeLinked parity in Pi wrapper: docs/pi/extensions/pm/index.ts now accepts includeLinked in tool params/schema and maps search includeLinked=true to --include-linked. Updated tests/unit/pi-agent-extension.spec.ts to assert schema exposure and deterministic arg mapping for search include-linked path."
    },
    {
      "created_at": "2026-02-21T19:46:06.024Z",
      "author": "cursor-maintainer",
      "text": "Evidence: node dist/cli.js test pm-igv --run --timeout 2400 --json passed all 3 linked tests (coverage + integration + pi-wrapper unit). Regression sweeps: node dist/cli.js test-all --status in_progress --timeout 2400 --json => items=11 linked_tests=63 passed=37 failed=0 skipped=26; node dist/cli.js test-all --status closed --timeout 2400 --json => items=21 linked_tests=57 passed=20 failed=0 skipped=37. Coverage proof from sandboxed coverage run remains 100% lines/branches/functions/statements. Follow-up items created: none."
    },
    {
      "created_at": "2026-02-21T23:33:32.665Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: add Pi wrapper action parity for close (docs-first), then implement close action mapping/schema in docs/pi/extensions/pm/index.ts with targeted unit coverage and full pm test + test-all evidence."
    },
    {
      "created_at": "2026-02-21T23:35:13.861Z",
      "author": "maintainer-agent",
      "text": "Docs-first update complete: PRD.md and README.md now include Pi wrapper close action in the documented v0.1 command-aligned action set before implementation changes."
    },
    {
      "created_at": "2026-02-21T23:35:56.491Z",
      "author": "maintainer-agent",
      "text": "Implemented close-action parity in Pi wrapper: docs/pi/extensions/pm/index.ts now includes action=close and maps it to pm close <id> <text> with --author/--message/--force passthrough; tests/unit/pi-agent-extension.spec.ts now covers required close text validation and deterministic close arg mapping."
    },
    {
      "created_at": "2026-02-21T23:50:53.491Z",
      "author": "maintainer-agent",
      "text": "Evidence: pm test pm-igv --run --timeout 3600 --json passed all linked tests (count=3, passed=3, failed=0, skipped=0), including node scripts/run-tests.mjs coverage and targeted pi-agent wrapper unit/integration commands. Regression sweeps passed: pm test-all --status in_progress --timeout 3600 --json => items=11 linked_tests=63 passed=37 failed=0 skipped=26; pm test-all --status closed --timeout 3600 --json => items=21 linked_tests=57 passed=20 failed=0 skipped=37. Coverage proof remained 100% lines/branches/functions/statements (\"All files | 100 | 100 | 100 | 100\"). Follow-up items created: none."
    },
    {
      "created_at": "2026-02-22T11:04:10.740Z",
      "author": "cursor-maintainer",
      "text": "Plan: docs-first clarify Pi wrapper preserves explicit empty-string field intent for CLI parity, then update arg builder to forward empty strings for create/update/append/comments/close and add targeted unit coverage."
    },
    {
      "created_at": "2026-02-22T11:21:03.099Z",
      "author": "cursor-maintainer",
      "text": "Implemented docs-first Pi wrapper parity fix for explicit empty-string passthrough: README.md + PRD.md now require preserving empty-allowed CLI flag intent, docs/pi/extensions/pm/index.ts now forwards explicit empty strings for create/update/append/message paths, and tests/unit/pi-agent-extension.spec.ts adds regression coverage for create/update/append empty-string mapping. Evidence: pm test pm-igv --run --timeout 3600 --json passed 3/3 linked tests; pm test-all --status in_progress --timeout 3600 --json passed totals items=10 linked_tests=35 passed=15 failed=0 skipped=20; pm test-all --status closed --timeout 3600 --json passed totals items=22 linked_tests=86 passed=42 failed=0 skipped=44. Coverage remains 100% lines/branches/functions/statements (All files 100/100/100/100). Follow-up items created: none."
    },
    {
      "created_at": "2026-03-04T09:30:57.793Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: align npm packaging with documented Pi wrapper module by adding docs/pi/extensions/pm/index.ts to publish allowlist and extending release-readiness contract coverage for that path."
    },
    {
      "created_at": "2026-03-04T09:42:14.283Z",
      "author": "maintainer-agent",
      "text": "Implemented Pi-wrapper packaging parity hardening: added docs/pi/extensions/pm/index.ts to npm publish allowlist in package.json and extended tests/integration/release-readiness-contract.spec.ts packaging contract to require that path. Evidence: node scripts/run-tests.mjs test -- tests/integration/release-readiness-contract.spec.ts passed (16/16); pm test pm-igv --run --timeout 7200 --json passed linked tests (4 passed, 0 failed, 0 skipped); pm test-all --status in_progress --timeout 7200 --json passed totals items=7 linked_tests=33 passed=16 failed=0 skipped=17; pm test-all --status closed --timeout 7200 --json passed totals items=37 linked_tests=128 passed=51 failed=0 skipped=77; npm pack --dry-run --json confirms packaged file count includes docs/pi/extensions/pm/index.ts (pi_wrapper=1). Coverage statement: sandboxed coverage runs remain 100% lines/branches/functions/statements. Follow-up items created: none."
    },
    {
      "created_at": "2026-03-04T10:10:53.551Z",
      "author": "cursor-maintainer",
      "text": "Planned changeset: docs-first clarify Pi wrapper claim/release metadata passthrough for author/message/force, then implement arg mapping in docs/pi/extensions/pm/index.ts and add targeted unit coverage in tests/unit/pi-agent-extension.spec.ts before mandatory pm test + test-all evidence."
    },
    {
      "created_at": "2026-03-04T10:11:45.508Z",
      "author": "cursor-maintainer",
      "text": "Implemented docs-first claim/release metadata parity increment: PRD/README now explicitly require Pi-wrapper forwarding of author/message/force for claim and release actions, docs/pi/extensions/pm/index.ts now routes claim/release through shared author-message-force flag plumbing, and unit coverage now asserts deterministic claim/release argument mapping."
    },
    {
      "created_at": "2026-03-04T10:24:15.536Z",
      "author": "cursor-maintainer",
      "text": "Evidence: node scripts/run-tests.mjs test -- tests/unit/pi-agent-extension.spec.ts passed (7/7); pnpm build passed; pm test pm-igv --run --timeout 7200 --json passed linked tests (4 passed, 0 failed, 0 skipped) including sandboxed coverage with 100% lines/branches/functions/statements; pm test-all --status in_progress --timeout 7200 --json passed totals items=7 linked_tests=33 passed=16 failed=0 skipped=17; pm test-all --status closed --timeout 7200 --json passed totals items=37 linked_tests=128 passed=51 failed=0 skipped=77; npm i -g . verified pm remains globally available at version 0.1.0. Follow-up items created: none."
    },
    {
      "created_at": "2026-03-04T11:50:42.571Z",
      "author": "cursor-agent",
      "text": "Iteration verification complete. Docs-to-implementation parity check: PRD.md + README.md + AGENTS.md reviewed against `pm --help` and current Pi wrapper action surface (`docs/pi/extensions/pm/index.ts`), with no new drift identified for this item scope.\nValidation run:\n1) pm test pm-igv --run --timeout 7200 --json => passed (4/4 linked tests, 0 failed, 0 skipped).\n2) pm test-all --status in_progress --timeout 7200 --json => totals items=7 linked_tests=33 passed=16 failed=0 skipped=17.\n3) pm test-all --status closed --timeout 7200 --json => totals items=38 linked_tests=130 passed=51 failed=0 skipped=79.\nCoverage proof: sandboxed coverage outputs in this run remained 100% lines/branches/functions/statements (All files 100/100/100/100).\nRelease-readiness check: `npm i -g .` then `pm --version` succeeded (0.1.0), confirming global availability of latest local build."
    }
  ],
  "files": [
    {
      "path": ".pi/extensions/pm-cli/index.ts",
      "scope": "project",
      "note": "Pi wrapper project-scoped module path"
    },
    {
      "path": "package.json",
      "scope": "project",
      "note": "publish allowlist includes Pi wrapper source module"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "docs-first Pi wrapper include-linked parameter contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "docs-first Pi wrapper include-linked usage contract"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "remove_cli_wrapper"
    },
    {
      "path": "tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "note": "remove_obsolete_pi_cli_case"
    },
    {
      "path": "tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "note": "packaging allowlist contract coverage for Pi wrapper path"
    },
    {
      "path": "tests/unit/pi-agent-extension.spec.ts",
      "scope": "project",
      "note": "unit coverage for pi extension mapping/registration"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "sandboxed full coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "sandboxed integration regression"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "targeted packaging contract regression"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/pi-agent-extension.spec.ts",
      "scope": "project",
      "timeout_seconds": 600,
      "note": "targeted Pi agent extension regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "agent workflow + Pi wrapper contract"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "governing spec"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "user-facing command contract"
    }
  ]
}

Ship built-in Pi wrapper extension.
