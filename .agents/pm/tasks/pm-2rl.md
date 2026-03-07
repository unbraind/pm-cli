{
  "id": "pm-2rl",
  "title": "Fix sandbox runner passthrough for targeted test commands",
  "description": "Ensure scripts/run-tests.mjs preserves targeted Vitest file filters and keeps sandbox PM_PATH safety for linked tests.",
  "type": "Task",
  "status": "closed",
  "priority": 2,
  "tags": [
    "area:testing",
    "milestone:6",
    "pm-cli",
    "priority:2",
    "tests"
  ],
  "created_at": "2026-02-19T02:36:38.700Z",
  "updated_at": "2026-02-19T04:00:56.376Z",
  "deadline": "2026-02-26T02:36:38.700Z",
  "author": "maintainer-agent",
  "estimated_minutes": 45,
  "acceptance_criteria": "Running node scripts/run-tests.mjs test -- tests/unit/health-command.spec.ts executes only requested files in sandbox; pm-linked targeted tests no longer fan out to full suite.",
  "dependencies": [
    {
      "id": "pm-jiw",
      "kind": "parent",
      "created_at": "2026-02-19T02:36:38.700Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-02-19T02:36:38.700Z",
      "author": "maintainer-agent",
      "text": "Created from verification evidence: targeted linked tests currently fan out to full-suite runs; fix is required for efficient deterministic pm test-all sweeps."
    },
    {
      "created_at": "2026-02-19T03:19:51.483Z",
      "author": "maintainer-agent",
      "text": "Intent: patch sandbox runner argument forwarding so targeted filters after '--' are normalized before invoking Vitest, then verify with targeted run + coverage + test-all sweeps."
    },
    {
      "created_at": "2026-02-19T03:22:04.362Z",
      "author": "maintainer-agent",
      "text": "Implemented docs-first + code changeset: README now documents '-- <vitest args...>' passthrough contract; scripts/run-tests.mjs now normalizes leading '--', runs build explicitly, and invokes vitest directly via pnpm exec to preserve targeted file filters. Added integration test tests/integration/run-tests-script.integration.spec.ts to lock this behavior."
    },
    {
      "created_at": "2026-02-19T03:47:33.354Z",
      "author": "maintainer-agent",
      "text": "Follow-up hardening: added PM_RUN_TESTS_SKIP_BUILD=1 support in scripts/run-tests.mjs and use it in tests/integration/run-tests-script.integration.spec.ts to prevent nested build races when run-tests is invoked from within an active Vitest run."
    },
    {
      "created_at": "2026-02-19T04:00:47.193Z",
      "author": "maintainer-agent",
      "text": "Evidence: pm test pm-2rl --run --timeout 1800 --json passed 3/3 linked commands (coverage + targeted integration + targeted health). Regression sweeps passed after metadata cleanup and race hardening: pm test-all --status in_progress --timeout 1800 --json => items=5 linked_tests=23 passed=22 failed=0 skipped=1; pm test-all --status closed --timeout 1800 --json => items=14 linked_tests=37 passed=34 failed=0 skipped=3. Coverage gate remains 100% lines/branches/functions/statements in sandboxed runs. Follow-up maintenance applied: removed stale pm-wo8 linked command/path for tests/unit/create-update-command.spec.ts that became invalid once targeted passthrough was fixed."
    }
  ],
  "notes": [
    {
      "created_at": "2026-02-19T02:36:38.700Z",
      "author": "maintainer-agent",
      "text": "Plan: adjust run-tests script or package scripts to preserve forwarded args after mode selection; add integration assertion for filtered execution."
    }
  ],
  "learnings": [
    {
      "created_at": "2026-02-19T02:36:38.700Z",
      "author": "maintainer-agent",
      "text": "Long regression sweeps revealed that targeted linked test commands currently execute full suites due argument forwarding behavior."
    }
  ],
  "files": [
    {
      "path": "README.md",
      "scope": "project",
      "note": "document targeted passthrough behavior"
    },
    {
      "path": "scripts/run-tests.mjs",
      "scope": "project",
      "note": "fix argument passthrough semantics"
    },
    {
      "path": "tests/integration/run-tests-script.integration.spec.ts",
      "scope": "project",
      "note": "verify runner targeted passthrough contract"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "coverage gate in sandbox after runner fix"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/integration/run-tests-script.integration.spec.ts",
      "scope": "project",
      "timeout_seconds": 900,
      "note": "runner passthrough regression"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/health-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 600,
      "note": "verify targeted execution remains filtered"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "dogfood workflow contract"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "governing spec"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "document sandbox runner targeted command behavior"
    }
  ]
}

Observed during pm test-all sweeps: commands like node scripts/run-tests.mjs test -- tests/unit/extension-loader.spec.ts trigger full-suite execution, which inflates regression runtime and weakens item-level test specificity. Implement deterministic passthrough so targeted linked commands execute only requested tests while preserving sandbox PM_PATH safety.
