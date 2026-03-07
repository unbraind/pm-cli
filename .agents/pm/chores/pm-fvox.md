{
  "id": "pm-fvox",
  "title": "Close-workflow contract guard across docs and runtime",
  "description": "Add release-readiness contract coverage that enforces close command workflow guidance and prevents --status closed update guidance drift in PRD README and AGENTS.",
  "type": "Chore",
  "status": "closed",
  "priority": 0,
  "tags": [
    "contract-sync",
    "maintenance",
    "pm-cli",
    "release-readiness"
  ],
  "created_at": "2026-03-06T19:44:34.375Z",
  "updated_at": "2026-03-06T20:07:58.912Z",
  "deadline": "2026-03-07T19:44:34.375Z",
  "author": "maintainer-agent",
  "estimated_minutes": 90,
  "acceptance_criteria": "Release-readiness tests assert docs require pm close workflow and disallow update --status closed guidance; sandbox-safe verification and coverage remain 100%.",
  "comments": [
    {
      "created_at": "2026-03-06T19:44:34.375Z",
      "author": "maintainer-agent",
      "text": "Queue next non-duplicate release-hardening guard around close workflow semantics."
    },
    {
      "created_at": "2026-03-06T19:44:50.643Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: add release-readiness integration assertions that docs retain pm close workflow guidance and avoid update --status closed instructions; include a runtime check that update --status closed remains usage-invalid."
    },
    {
      "created_at": "2026-03-06T19:46:38.841Z",
      "author": "maintainer-agent",
      "text": "Implemented changeset: extended update-close workflow release-readiness contract test to assert README quickstart and AGENTS Step F keep pm close guidance and avoid update --status closed instructions, while preserving runtime usage-error validation."
    },
    {
      "created_at": "2026-03-06T20:07:46.330Z",
      "author": "maintainer-agent",
      "text": "Evidence: node scripts/run-tests.mjs test -- tests/integration/release-readiness-contract.spec.ts passed (25/25). pm test pm-fvox --run --timeout 3600 passed linked tests (2 passed, 0 failed) including node scripts/run-tests.mjs coverage with 100% lines/branches/functions/statements. pm test-all --status in_progress --timeout 3600 passed after sequential rerun (items=1 linked_tests=2 passed=2 failed=0 skipped=0). pm test-all --status closed --timeout 3600 passed after sequential rerun (items=102 linked_tests=287 passed=63 failed=0 skipped=224)."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-06T19:44:34.375Z",
      "author": "maintainer-agent",
      "text": "Add focused integration assertions in release-readiness-contract spec and verify full sweeps."
    }
  ],
  "files": [
    {
      "path": "tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "note": "close-workflow contract assertions"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 600,
      "note": "sandbox-safe coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test",
      "scope": "project",
      "timeout_seconds": 240,
      "note": "sandbox-safe regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "maintainer close workflow guidance"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "close and update status contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public close workflow contract"
    }
  ],
  "close_reason": "Close-workflow contract guard added; docs and runtime close semantics remain enforced; sandbox-safe regression/coverage/test-all sweeps passed."
}

Strengthen docs/runtime contract checks for close workflow semantics from PRD section 5.2 and 11.4.
