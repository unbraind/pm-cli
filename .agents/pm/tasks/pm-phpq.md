{
  "id": "pm-phpq",
  "title": "Release-readiness maintenance loop 2026-03-07 run 2",
  "description": "Run full docs-vs-implementation audit, implement one concrete gap fix, and verify via pm-driven tests.",
  "type": "Task",
  "status": "closed",
  "priority": 0,
  "tags": [
    "area:docs",
    "area:release-readiness",
    "area:tests",
    "code",
    "doc",
    "milestone:6",
    "pm-cli",
    "priority:0",
    "tests"
  ],
  "created_at": "2026-03-07T07:23:53.401Z",
  "updated_at": "2026-03-07T07:36:50.077Z",
  "deadline": "2026-03-08T23:59:00.000Z",
  "author": "maintainer-agent",
  "estimated_minutes": 120,
  "acceptance_criteria": "1) Identify and fix at least one docs/implementation/test contract gap. 2) Run linked pm test and pm test-all regression sweeps. 3) Keep coverage at 100 percent and log evidence.",
  "comments": [
    {
      "created_at": "2026-03-07T07:23:53.401Z",
      "author": "maintainer-agent",
      "text": "This item exists to keep docs implementation and tests aligned while preserving release readiness."
    },
    {
      "created_at": "2026-03-07T07:24:12.786Z",
      "author": "maintainer-agent",
      "text": "Starting gap audit from live --help output and contract tests to identify the smallest high-value hardening change for this run."
    },
    {
      "created_at": "2026-03-07T07:25:30.966Z",
      "author": "maintainer-agent",
      "text": "Implementing help-contract hardening: remove misleading default-array text from required create seed flags by adjusting option wiring and add a regression assertion."
    },
    {
      "created_at": "2026-03-07T07:36:17.106Z",
      "author": "maintainer-agent",
      "text": "Implemented create-help hardening: removed default-array rendering from required seed flags by dropping default [] registration for create repeatable options and making collector resilient to undefined accumulator."
    },
    {
      "created_at": "2026-03-07T07:36:22.743Z",
      "author": "maintainer-agent",
      "text": "Evidence: node scripts/run-tests.mjs test -- tests/integration/release-readiness-contract.spec.ts passed (28/28). pm test pm-phpq --run passed. pm test-all --status in_progress passed (items=1 linked_tests=1). pm test-all --status closed passed (items=115 linked_tests=311 passed=62 skipped=249 failed=0; dedupe behavior exercised). node scripts/run-tests.mjs coverage passed with 100% lines/branches/functions/statements."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-07T07:23:53.401Z",
      "author": "maintainer-agent",
      "text": "Start with authoritative doc + help output audit then implement smallest high-value hardening patch."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative requirements baseline"
    },
    {
      "path": "src/cli/commands/create.ts",
      "scope": "project",
      "note": "candidate help/contract hardening target"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "create option wiring adjusted to avoid misleading default help text"
    },
    {
      "path": "tests/integration/help-readme-contract.spec.ts",
      "scope": "project",
      "note": "candidate contract test target"
    },
    {
      "path": "tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "note": "create-help regression assertion"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs test",
      "scope": "project",
      "timeout_seconds": 240,
      "note": "sandbox-safe regression runner"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "maintainer operating contract"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative product requirements"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public contract parity"
    }
  ],
  "close_reason": "Create help now omits misleading default-array text for required seed flags; regression contract test added; pm test, test-all sweeps, and coverage passed at 100%."
}

Idempotent maintainer loop task for 2026-03-07 run 2.
