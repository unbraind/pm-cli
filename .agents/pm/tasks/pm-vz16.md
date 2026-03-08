{
  "id": "pm-vz16",
  "title": "Release-readiness maintenance loop 2026-03-08 run 1",
  "description": "Add missing restore help contract guard in release-readiness integration suite.",
  "type": "Task",
  "status": "closed",
  "priority": 0,
  "tags": [
    "area:release",
    "code",
    "milestone:6",
    "pm-cli",
    "priority:0",
    "tests"
  ],
  "created_at": "2026-03-08T13:38:46.107Z",
  "updated_at": "2026-03-08T13:52:54.494Z",
  "deadline": "2026-03-09T13:38:45.000Z",
  "author": "maintainer-agent",
  "estimated_minutes": 45,
  "acceptance_criteria": "Release-readiness integration suite asserts pm restore --help usage/description and --author/--message/--force metadata flags aligned with PRD contract.",
  "definition_of_ready": "Gap confirmed via release-readiness contract scan and no duplicate active task.",
  "why_now": "Prevent silent restore-help contract drift before release.",
  "risk": "low",
  "confidence": "high",
  "comments": [
    {
      "created_at": "2026-03-08T13:38:46.107Z",
      "author": "maintainer-agent",
      "text": "Why this exists: explicit restore help metadata contract is not covered by release-readiness guard suite yet."
    },
    {
      "created_at": "2026-03-08T13:38:56.395Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: add explicit restore help metadata parity assertions (usage/description and --author/--message/--force) to release-readiness contract suite before running linked tests and regression sweeps."
    },
    {
      "created_at": "2026-03-08T13:39:20.208Z",
      "author": "maintainer-agent",
      "text": "Implemented release-readiness contract hardening in tests/integration/release-readiness-contract.spec.ts by adding restore help metadata parity assertions (PRD row token + restore --help usage/description + --author/--message/--force checks)."
    },
    {
      "created_at": "2026-03-08T13:52:54.158Z",
      "author": "maintainer-agent",
      "text": "Evidence: pm test pm-vz16 --run --timeout 1800 passed linked tests (2/2) including node scripts/run-tests.mjs coverage and targeted release-readiness spec. pm test-all --status in_progress --timeout 1800 passed (items=1, linked_tests=2, failed=0). pm test-all --status closed --timeout 1800 passed (items=149, linked_tests=380, passed=68, failed=0, skipped=312). Coverage remains 100% lines/branches/functions/statements (All files 100/100/100/100)."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-08T13:38:46.107Z",
      "author": "maintainer-agent",
      "text": "Validation plan: add test case in release-readiness-contract.spec.ts and run pm test + pm test-all + sandbox coverage."
    }
  ],
  "files": [
    {
      "path": "tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "note": "planned restore help parity test"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "coverage gate verification"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "timeout_seconds": 240,
      "note": "targeted release-contract regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "agent workflow contract reference"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative output and help contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "contract reference"
    }
  ],
  "close_reason": "Restore help contract guard added and required regression sweeps passed."
}

Context: release-readiness contracts currently verify append/close/delete/claim/release help parity, but restore help metadata parity lacks explicit regression coverage. Plan: docs-alignment check then add restore help contract test and validate full sandbox test loops.
