{
  "id": "pm-gsd9",
  "title": "AGENTS closed-sweep guidance and contract guard",
  "description": "Align AGENTS validation workflow with closed-status test-all sweep guidance and guard it in release-readiness contract tests.",
  "type": "Chore",
  "status": "closed",
  "priority": 0,
  "tags": [
    "contract-sync",
    "maintenance",
    "pm-cli",
    "release-readiness"
  ],
  "created_at": "2026-03-06T17:35:26.962Z",
  "updated_at": "2026-03-06T17:49:46.856Z",
  "deadline": "2026-03-07T17:35:26.962Z",
  "author": "maintainer-agent",
  "estimated_minutes": 90,
  "acceptance_criteria": "AGENTS Step F includes explicit closed-status sweep guidance; release-readiness contract tests assert both in_progress and closed sweep tokens; sandbox-safe regression and coverage checks pass with 100% coverage.",
  "comments": [
    {
      "created_at": "2026-03-06T17:35:26.962Z",
      "author": "maintainer-agent",
      "text": "Bootstrap discovery complete no open items; implementing next highest-value docs+contract guard sync for AGENTS test-all closed sweep guidance."
    },
    {
      "created_at": "2026-03-06T17:35:40.366Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: update AGENTS Step F project sweep guidance to include pm test-all --status closed when relevant, and add release-readiness contract assertions that guard both in_progress and closed sweep tokens."
    },
    {
      "created_at": "2026-03-06T17:36:22.153Z",
      "author": "maintainer-agent",
      "text": "Implemented changeset: AGENTS Step F now documents optional pm test-all --status closed sweep guidance for broader release-readiness checks, and release-readiness contract integration tests now assert both in_progress and closed project-sweep tokens to prevent workflow drift."
    },
    {
      "created_at": "2026-03-06T17:48:31.989Z",
      "author": "maintainer-agent",
      "text": "Evidence: node scripts/run-tests.mjs test -- tests/integration/release-readiness-contract.spec.ts passed (23/23). node dist/cli.js test pm-gsd9 --run --timeout 3600 passed linked tests (2 passed, 0 failed) including node scripts/run-tests.mjs coverage with 100% lines/branches/functions/statements. node dist/cli.js test-all --status in_progress --timeout 3600 passed (items=1 linked_tests=2 passed=2 failed=0 skipped=0). node dist/cli.js test-all --status closed --timeout 3600 passed (items=99 linked_tests=281 passed=63 failed=0 skipped=218). Follow-up items: none."
    },
    {
      "created_at": "2026-03-06T17:49:23.562Z",
      "author": "maintainer-agent",
      "text": "Follow-up polish: fixed markdown indentation for the newly added AGENTS Step F closed-sweep bullet so list formatting remains consistent."
    },
    {
      "created_at": "2026-03-06T17:49:46.856Z",
      "author": "maintainer-agent",
      "text": "Verification follow-up: reran node scripts/run-tests.mjs test -- tests/integration/release-readiness-contract.spec.ts after AGENTS formatting polish; passed 23/23."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-06T17:35:26.962Z",
      "author": "maintainer-agent",
      "text": "Keep behavior unchanged docs-first for workflow guidance and add contract test coverage to prevent drift."
    }
  ],
  "files": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "workflow guidance sync"
    },
    {
      "path": "tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "note": "contract guard for AGENTS sweep tokens"
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
      "note": "public contract alignment check"
    }
  ],
  "close_reason": "AGENTS Step F now includes optional pm test-all --status closed guidance and release-readiness contract tests guard both in_progress and closed sweep tokens; sandbox-safe regression and 100% coverage checks passed."
}

Update AGENTS Step F project sweep guidance to include pm test-all --status closed (when safe), and add integration contract assertions to prevent drift.
