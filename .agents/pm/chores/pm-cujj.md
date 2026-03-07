{
  "id": "pm-cujj",
  "title": "Release-readiness guard for update help/contract parity",
  "description": "Add integration contract coverage to keep PRD update-flag contract and pm update --help output aligned.",
  "type": "Chore",
  "status": "closed",
  "priority": 0,
  "tags": [
    "area:update",
    "milestone:6",
    "pm-cli",
    "priority:0",
    "release-readiness",
    "tests"
  ],
  "created_at": "2026-03-06T22:29:14.466Z",
  "updated_at": "2026-03-06T22:52:51.622Z",
  "deadline": "2026-03-08T23:59:00.000Z",
  "author": "maintainer-agent",
  "estimated_minutes": 60,
  "acceptance_criteria": "Release-readiness contract test asserts update section flags from PRD and README remain aligned with pm update --help and mandatory sweeps pass at 100% coverage.",
  "dependencies": [
    {
      "id": "pm-8mkp",
      "kind": "related",
      "created_at": "2026-03-06T22:29:14.466Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-06T22:29:14.466Z",
      "author": "maintainer-agent",
      "text": "Why this exists: release-readiness currently guards create and claim-release help but not update help parity."
    },
    {
      "created_at": "2026-03-06T22:29:37.939Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: add a release-readiness contract assertion that validates PRD/README update flag tokens against pm update --help output to prevent docs/help drift."
    },
    {
      "created_at": "2026-03-06T22:30:34.245Z",
      "author": "maintainer-agent",
      "text": "Implemented docs-first parity hardening: README now includes an explicit pm update mutation flag contract section, and release-readiness integration tests now assert PRD/README/update-help parity for update flags and close-workflow guidance."
    },
    {
      "created_at": "2026-03-06T22:52:42.338Z",
      "author": "maintainer-agent",
      "text": "Evidence: pnpm build passed. pm test pm-cujj --run --timeout 7200 --json passed linked tests (2/2): node scripts/run-tests.mjs coverage and node scripts/run-tests.mjs test -- tests/integration/release-readiness-contract.spec.ts. pm test-all --status in_progress --timeout 7200 --json passed (items=1 linked_tests=2 passed=2 failed=0 skipped=0). pm test-all --status closed --timeout 7200 --json passed (items=110 linked_tests=301 passed=63 failed=0 skipped=238). Coverage remains 100% lines/branches/functions/statements."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-06T22:29:14.466Z",
      "author": "maintainer-agent",
      "text": "Plan: add focused integration assertion in release-readiness-contract spec and run mandatory pm test/test-all sweeps."
    }
  ],
  "files": [
    {
      "path": "README.md",
      "scope": "project",
      "note": "document update explicit-flag contract"
    },
    {
      "path": "tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "note": "add update help parity guard"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 2400,
      "note": "coverage gate"
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
      "note": "dogfood release-readiness workflow"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "update-flag contract source"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "update-help contract source"
    }
  ],
  "close_reason": "Added README update flag contract section and enforced PRD/README/update-help parity in release-readiness integration tests; all mandatory sweeps passed with 100% coverage."
}

Add a non-duplicate release-readiness assertion for update command explicit-flag contract.
