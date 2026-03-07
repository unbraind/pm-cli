{
  "id": "pm-tkie",
  "title": "Release-readiness maintenance loop 2026-03-06",
  "description": "Run docs/contract drift audit and implement one highest-value fix with evidence.",
  "type": "Chore",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:maintenance",
    "milestone:6",
    "pm-cli",
    "release-readiness"
  ],
  "created_at": "2026-03-06T15:56:24.745Z",
  "updated_at": "2026-03-06T16:11:43.966Z",
  "deadline": "2026-03-07T15:56:24.745Z",
  "author": "maintainer-agent",
  "estimated_minutes": 90,
  "acceptance_criteria": "At least one concrete release-readiness improvement is implemented and verified with sandbox-safe tests and evidence is logged.",
  "comments": [
    {
      "created_at": "2026-03-06T15:56:24.745Z",
      "author": "maintainer-agent",
      "text": "Queue is empty and this item captures the current maintenance iteration."
    },
    {
      "created_at": "2026-03-06T15:58:11.782Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: add release-readiness contract coverage that enforces update --status closed rejection and close-command guidance per PRD workflow."
    },
    {
      "created_at": "2026-03-06T16:11:40.651Z",
      "author": "maintainer-agent",
      "text": "Implemented release-readiness hardening in tests/integration/release-readiness-contract.spec.ts by adding an integration test that enforces pm update --status closed rejection and pm close workflow guidance per PRD."
    },
    {
      "created_at": "2026-03-06T16:11:40.828Z",
      "author": "maintainer-agent",
      "text": "Evidence: node scripts/run-tests.mjs test -- tests/integration/release-readiness-contract.spec.ts passed (21/21); pm test pm-tkie --run --timeout 7200 --json passed (2 linked tests, 2 passed, 0 failed, 0 skipped); pm test-all --status in_progress --timeout 7200 --json passed (items=1 linked_tests=2 passed=2 failed=0 skipped=0); pm test-all --status closed --timeout 7200 --json passed (items=95 linked_tests=274 passed=63 failed=0 skipped=211). Coverage remains 100% lines/branches/functions/statements."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-06T15:56:24.745Z",
      "author": "maintainer-agent",
      "text": "Plan uses targeted drift checks then one focused improvement with verification."
    }
  ],
  "files": [
    {
      "path": "tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "note": "add close-workflow status contract coverage"
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
      "note": "sandbox-safe baseline test runner"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "agent workflow contract"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public contract"
    }
  ],
  "close_reason": "Added update-close workflow release-readiness contract coverage and verified required sweeps."
}

Idempotent maintainer loop for this session. Select highest-value gap after baseline checks then apply a small docs-first/code/test changeset with verification evidence.
