{
  "id": "pm-x89f",
  "title": "Release-readiness contract audit and next fix (2026-03-06 run 5)",
  "description": "Audit PRD README AGENTS alignment and implement the next highest-value contract guard without duplicating prior work.",
  "type": "Chore",
  "status": "closed",
  "priority": 0,
  "tags": [
    "contract-sync",
    "maintenance",
    "pm-cli",
    "release-readiness"
  ],
  "created_at": "2026-03-06T19:26:24.210Z",
  "updated_at": "2026-03-06T19:39:02.287Z",
  "deadline": "2026-03-07T19:26:24.210Z",
  "author": "maintainer-agent",
  "estimated_minutes": 90,
  "acceptance_criteria": "Release-readiness tests enforce that planned/not-yet-canonical flags are absent from active create/help contracts, and sandbox-safe verification passes with 100% coverage preserved.",
  "comments": [
    {
      "created_at": "2026-03-06T19:26:24.210Z",
      "author": "maintainer-agent",
      "text": "Bootstrap run 5 from empty active queue and choose smallest high-value non-duplicate contract guard."
    },
    {
      "created_at": "2026-03-06T19:26:33.676Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: extend release-readiness integration contracts to assert planned/not-yet-canonical create flags remain absent from active CLI help and docs-backed create contract sections."
    },
    {
      "created_at": "2026-03-06T19:39:01.784Z",
      "author": "maintainer-agent",
      "text": "Implemented changeset: added a release-readiness integration guard in tests/integration/release-readiness-contract.spec.ts that asserts planned/not-yet-canonical flags remain absent from active create contract sections (PRD/README/AGENTS) and from pm create --help output."
    },
    {
      "created_at": "2026-03-06T19:39:01.951Z",
      "author": "maintainer-agent",
      "text": "Evidence: node scripts/run-tests.mjs test -- tests/integration/release-readiness-contract.spec.ts passed (25/25). pm test pm-x89f --run --timeout 3600 passed linked tests (2 passed, 0 failed), including node scripts/run-tests.mjs coverage with 100% lines/branches/functions/statements. pm test-all --status in_progress --timeout 3600 passed (items=1 linked_tests=2 passed=2 failed=0 skipped=0). pm test-all --status closed --timeout 3600 passed (items=101 linked_tests=285 passed=63 failed=0 skipped=222). Follow-up items: none."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-06T19:26:24.210Z",
      "author": "maintainer-agent",
      "text": "Add integration guard for planned flag absence in CLI help and docs-backed create contract."
    }
  ],
  "files": [
    {
      "path": "tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "note": "add planned-flag absence contract test"
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
  "close_reason": "Planned-flag absence contract guard added and full sandbox-safe verification sweeps passed with 100% coverage intact."
}

Targeted improvement for this run: guard against accidental exposure of planned/not-yet-canonical flags in active CLI help and user-facing create contracts.
