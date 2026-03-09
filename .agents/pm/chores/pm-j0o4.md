{
  "id": "pm-j0o4",
  "title": "Maintain release readiness 2026-03-09 (Run 6)",
  "description": "Fix PRD linked-test example to sandbox-safe command and add release-readiness contract guard against unsafe linked-test examples.",
  "type": "Chore",
  "status": "closed",
  "priority": 0,
  "tags": [
    "area:docs",
    "area:tests",
    "doc",
    "milestone:6",
    "pm-cli",
    "priority:0",
    "tests"
  ],
  "created_at": "2026-03-09T16:37:21.792Z",
  "updated_at": "2026-03-09T16:55:26.199Z",
  "deadline": "2026-03-10T23:59:00.000Z",
  "author": "maintainer-agent",
  "estimated_minutes": 60,
  "acceptance_criteria": "PRD linked test example uses sandbox-safe node scripts/run-tests.mjs command and release-readiness contract test fails on unsafe example strings; pm test and pm test-all sweeps pass with 100 percent coverage.",
  "definition_of_ready": "Docs drift identified and release-readiness contract test target selected.",
  "order": 1,
  "goal": "Release-hardening",
  "objective": "Keep docs and contracts aligned with sandbox-safe linked-test policy",
  "value": "Prevents unsafe linked-test guidance drift",
  "impact": "Reduces risk of unsandboxed pm test entries from docs",
  "outcome": "Authoritative docs and contract tests enforce sandbox-safe linked test examples",
  "why_now": "PRD currently includes unsafe linked test example contradicting hard requirements",
  "risk": "low",
  "confidence": "high",
  "sprint": "maintainer-loop-2026-03-09-6",
  "release": "v0.1",
  "regression": false,
  "comments": [
    {
      "created_at": "2026-03-09T16:37:21.792Z",
      "author": "maintainer-agent",
      "text": "Why this exists PRD linked test example is sandbox-unsafe and must align with hard policy."
    },
    {
      "created_at": "2026-03-09T16:37:32.785Z",
      "author": "maintainer-agent",
      "text": "Planned changeset update PRD example linked test command to sandbox-safe runner and add release-readiness contract assertion preventing unsandboxed linked-test examples in authoritative docs."
    },
    {
      "created_at": "2026-03-09T16:38:05.054Z",
      "author": "maintainer-agent",
      "text": "Implemented docs-first change: PRD section 7.4 example linked test command now uses node scripts/run-tests.mjs test -- tests/unit/history-command.spec.ts instead of unsandboxed pnpm test history; added release-readiness contract assertion to lock this policy in tests/integration/release-readiness-contract.spec.ts."
    },
    {
      "created_at": "2026-03-09T16:55:24.324Z",
      "author": "maintainer-agent",
      "text": "Validation evidence: pm test pm-j0o4 --run --timeout 3600 passed (linked tests coverage + release-readiness contract). pm test-all --status in_progress --timeout 3600 passed totals items=1 linked_tests=2 passed=2 failed=0 skipped=0. pm test-all --status closed --timeout 3600 passed totals items=178 linked_tests=424 passed=79 failed=0 skipped=345. Coverage remained 100 percent for lines branches functions and statements."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-09T16:37:21.792Z",
      "author": "maintainer-agent",
      "text": "Plan update PRD example and add release-readiness contract assertion then run pm test and test-all sweeps."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "update linked test example to sandbox-safe command"
    },
    {
      "path": "tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "note": "add guard against unsafe linked-test examples in docs"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 2400,
      "note": "full coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "targeted release contract regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "maintainer workflow source"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative contract update"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public testing policy reference"
    }
  ],
  "close_reason": "PRD sandbox-safe linked test example restored and release regression sweeps passed with 100 percent coverage"
}

Continue maintainer loop by resolving docs drift where PRD item example linked test command is sandbox-unsafe despite hard policy; add contract test to keep docs aligned.
