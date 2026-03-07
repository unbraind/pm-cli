{
  "id": "pm-siz",
  "title": "M0: Error model and exit code mapping",
  "description": "Implement and verify structured error model and PRD exit code mapping through integration coverage for usage, not-found, conflict, dependency-failed, and generic failure paths.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:error-model",
    "core",
    "milestone:0",
    "pm-cli"
  ],
  "created_at": "2026-02-17T23:02:07.105Z",
  "updated_at": "2026-02-19T21:58:55.319Z",
  "deadline": "2026-02-20T23:02:07.105Z",
  "author": "steve",
  "estimated_minutes": 120,
  "acceptance_criteria": "Error and command-failure paths deterministically map to exit codes 1/2/3/4/5 per PRD, with integration tests and regression sweeps passing at 100% coverage.",
  "dependencies": [
    {
      "id": "pm-2xl",
      "kind": "parent",
      "created_at": "2026-02-17T23:02:07.105Z",
      "author": "steve"
    }
  ],
  "comments": [
    {
      "created_at": "2026-02-19T21:34:16.277Z",
      "author": "cursor-maintainer",
      "text": "Planned change-set: add deterministic integration coverage for CLI exit-code mapping paths (usage, not-found, conflict, dependency-failed, generic failure), validate existing error model contracts in src/core/shared/errors.ts and src/cli/main.ts, then run pm test + test-all regression sweeps with 100% coverage evidence."
    },
    {
      "created_at": "2026-02-19T21:58:54.806Z",
      "author": "cursor-maintainer",
      "text": "Implemented exit-code hardening for generic-failure path by adding integration coverage in tests/integration/cli.integration.spec.ts (new test: returns generic-failure exit code for unexpected init filesystem errors), which validates top-level unknown-error mapping to exit code 1 while preserving existing checks for usage/not-found/conflict/dependency-failed. Evidence: pm test pm-siz --run --timeout 2400 --json passed all linked tests (3/3); pm test-all --status in_progress --timeout 2400 --json passed totals items=8 linked_tests=36 passed=35 failed=0 skipped=1; pm test-all --status closed --timeout 2400 --json passed totals items=16 linked_tests=44 passed=41 failed=0 skipped=3; coverage remains 100% statements/branches/functions/lines."
    },
    {
      "created_at": "2026-02-19T21:58:54.970Z",
      "author": "cursor-maintainer",
      "text": "Docs alignment check: PRD.md, README.md, and AGENTS.md remain accurate for this change-set; no contract text updates were required because behavior already specified exit code mapping and this iteration adds regression coverage."
    }
  ],
  "files": [
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "top-level-error-to-exit-code-mapping"
    },
    {
      "path": "src/core/shared/constants.ts",
      "scope": "project",
      "note": "authoritative-exit-code-map"
    },
    {
      "path": "src/core/shared/errors.ts",
      "scope": "project",
      "note": "structured-error-type"
    },
    {
      "path": "tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "note": "integration-exit-code-regression-tests"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 2400,
      "note": "coverage-gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "exit-code-integration-regression"
    },
    {
      "command": "pnpm build",
      "scope": "project",
      "timeout_seconds": 240,
      "note": "compile-gate"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "dogfood-test-safety-protocol"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "governing-exit-code-contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public-exit-code-contract"
    }
  ]
}

Define shared error classes and command-level exit handling.
