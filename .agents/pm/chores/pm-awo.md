{
  "id": "pm-awo",
  "title": "Create contract verification sample",
  "description": "Verify and close create-contract sample with current release-readiness regression evidence.",
  "type": "Chore",
  "status": "closed",
  "priority": 2,
  "tags": [
    "area:verification",
    "core",
    "milestone:0",
    "pm-cli"
  ],
  "created_at": "2026-02-17T23:14:58.875Z",
  "updated_at": "2026-03-04T11:34:44.184Z",
  "deadline": "2026-03-05T11:19:39.284Z",
  "author": "steve",
  "estimated_minutes": 30,
  "acceptance_criteria": "release-readiness contract test passes via sandbox runner; pm test-all sweeps pass for in_progress and closed; item has linked docs/files/tests and closure evidence comment.",
  "comments": [
    {
      "created_at": "2026-03-04T11:19:44.696Z",
      "author": "cursor-maintainer",
      "text": "Plan: validate release-readiness create-contract behavior against current docs and CLI help, verify sandbox-safe test execution, then close with fresh evidence."
    },
    {
      "created_at": "2026-03-04T11:21:30.722Z",
      "author": "cursor-maintainer",
      "text": "Verified latest local package is globally available: ran npm i -g . and confirmed pm --version=0.1.0."
    },
    {
      "created_at": "2026-03-04T11:34:43.750Z",
      "author": "cursor-maintainer",
      "text": "Evidence: pm test pm-awo --run --timeout 2400 --json => passed=2 failed=0 skipped=0 (coverage run + targeted release-readiness contract run). pm test-all --status in_progress --timeout 2400 --json => items=8 linked_tests=35 passed=16 failed=0 skipped=19. pm test-all --status closed --timeout 2400 --json => items=37 linked_tests=128 passed=51 failed=0 skipped=77. Coverage remains 100% lines/branches/functions/statements."
    }
  ],
  "files": [
    {
      "path": "scripts/run-tests.mjs",
      "scope": "project",
      "note": "sandbox-safe test runner"
    },
    {
      "path": "tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "note": "contract coverage source"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 2400,
      "note": "full coverage gate regression"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "targeted contract regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "dogfood workflow requirements"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative requirements"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "documented command contract"
    }
  ]
}

Validate that full create options map into deterministic item and history records.
