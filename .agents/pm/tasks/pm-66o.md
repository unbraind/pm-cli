{
  "id": "pm-66o",
  "title": "M3: test-all orchestration and dependency-failed exit handling",
  "description": "Implement aggregate test execution with failure aggregation.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:test-orchestration",
    "core",
    "milestone:3",
    "pm-cli"
  ],
  "created_at": "2026-02-17T23:02:09.686Z",
  "updated_at": "2026-02-22T17:15:27.349Z",
  "deadline": "2026-03-03T23:02:09.686Z",
  "author": "steve",
  "estimated_minutes": 120,
  "acceptance_criteria": "test-all reports deterministic passed/failed/skipped totals and no linked regression command flakes due to default test timeouts.",
  "dependencies": [
    {
      "id": "pm-54d",
      "kind": "parent",
      "created_at": "2026-02-17T23:02:09.686Z",
      "author": "steve"
    },
    {
      "id": "pm-c0r",
      "kind": "blocks",
      "created_at": "2026-02-17T23:02:09.686Z",
      "author": "steve"
    }
  ],
  "comments": [
    {
      "created_at": "2026-02-18T01:40:00.761Z",
      "author": "agent",
      "text": "Cross-item evidence: integration test tests/integration/cli.integration.spec.ts now asserts pm test-all returns exit code 5 when a linked command fails, validating dependency-failed semantics in CLI execution path."
    },
    {
      "created_at": "2026-02-18T03:23:31.818Z",
      "author": "maintainer-agent",
      "text": "Plan: prevent recursive pm test-all self-invocation via linked test entries, then add unit and integration assertions for the guard."
    },
    {
      "created_at": "2026-02-18T03:25:25.640Z",
      "author": "maintainer-agent",
      "text": "Implemented docs-first change: PRD and README now declare that linked test entries invoking pm test-all are rejected. Added parser-level guard in src/commands/test.ts and regression tests in unit+integration suites."
    },
    {
      "created_at": "2026-02-18T03:28:24.211Z",
      "author": "maintainer-agent",
      "text": "Evidence: pm test pm-66o --run --timeout 360 passed (47/47 tests). pm test-all --status in_progress --timeout 360 passed with totals items=5 linked_tests=8 passed=8 failed=0 skipped=0. Coverage gate remained 100% statements/branches/functions/lines via sandboxed run-tests.mjs coverage execution in regression sweep."
    },
    {
      "created_at": "2026-02-18T03:29:05.029Z",
      "author": "maintainer-agent",
      "text": "Follow-up hardening: replaced complex regex with normalized string checks in recursion guard to satisfy lint complexity constraints, then re-ran pm test and pm test-all with all pass results unchanged."
    },
    {
      "created_at": "2026-02-22T17:00:33.262Z",
      "author": "maintainer-agent",
      "text": "Failure evidence from pm test-all --status closed: linked command node scripts/run-tests.mjs test -- tests/unit/test-all-command.spec.ts tests/integration/cli.integration.spec.ts failed due vitest timeout (30000ms) in cli.integration restore-by-version test. Planned fix: remove flake by giving this long-running integration case an explicit higher timeout and rerun pm test + both test-all sweeps."
    },
    {
      "created_at": "2026-02-22T17:01:13.929Z",
      "author": "maintainer-agent",
      "text": "Implemented reliability fix in tests/integration/cli.integration.spec.ts: added explicit 120_000ms timeout to restore-by-version integration case so it no longer flakes at Vitest default 30s during test-all closed-sweep orchestration."
    },
    {
      "created_at": "2026-02-22T17:15:26.517Z",
      "author": "maintainer-agent",
      "text": "Evidence: pm test pm-66o --run --timeout 3600 --json passed (1 linked test, 0 failed). pm test-all --status in_progress --timeout 3600 --json passed totals items=10 linked_tests=35 passed=15 failed=0 skipped=20. pm test-all --status closed --timeout 3600 --json passed totals items=24 linked_tests=92 passed=43 failed=0 skipped=49. Coverage gate remains 100% lines/branches/functions/statements in sandboxed coverage runs. Follow-up items created: none."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "security-contract-update"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "documented-behavior"
    },
    {
      "path": "src/commands/test.ts",
      "scope": "project",
      "note": "linked-test-validation"
    },
    {
      "path": "tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "note": "cli-dependency-exit-and-safety"
    },
    {
      "path": "tests/unit/test-all-command.spec.ts",
      "scope": "project",
      "note": "unit-orchestration-safety-coverage"
    },
    {
      "path": "tests/unit/test-command.spec.ts",
      "scope": "project",
      "note": "runTest-recursion-guard-unit-tests"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/test-all-command.spec.ts tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "timeout_seconds": 360,
      "note": "sandboxed-targeted-regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "dogfood-protocol"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "governing-spec"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "user-contract"
    }
  ]
}

Implement orchestration and dependency-failed semantics.
