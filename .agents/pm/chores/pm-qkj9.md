{
  "id": "pm-qkj9",
  "title": "Release-readiness contract audit and next fix (2026-03-06 run)",
  "description": "Audit PRD/README/AGENTS alignment, run sandbox-safe verification, and implement the next highest-value contract-aligned improvement.",
  "type": "Chore",
  "status": "closed",
  "priority": 0,
  "tags": [
    "contract-sync",
    "maintenance",
    "pm-cli",
    "release-readiness"
  ],
  "created_at": "2026-03-06T16:52:18.127Z",
  "updated_at": "2026-03-06T17:07:08.294Z",
  "deadline": "2026-03-07T16:52:18.127Z",
  "author": "maintainer-agent",
  "estimated_minutes": 120,
  "acceptance_criteria": "One concrete contract-aligned improvement is implemented, verified with sandbox-safe tests, and fully logged in pm history/comments.",
  "comments": [
    {
      "created_at": "2026-03-06T16:52:18.127Z",
      "author": "maintainer-agent",
      "text": "Starting maintainer loop to keep repo release ready and contract aligned"
    },
    {
      "created_at": "2026-03-06T16:52:28.058Z",
      "author": "maintainer-agent",
      "text": "Bootstrap complete: read PRD README AGENTS fully and confirmed PM_CMD=node dist/cli.js with PM_AUTHOR=maintainer-agent."
    },
    {
      "created_at": "2026-03-06T16:53:00.148Z",
      "author": "maintainer-agent",
      "text": "Discovery: running release-readiness contract tests to detect docs and CLI drift and select the next smallest high value fix."
    },
    {
      "created_at": "2026-03-06T16:54:39.725Z",
      "author": "maintainer-agent",
      "text": "Next changeset: sync README repository structure away from missing docs/prompts paths and update release-readiness contract test to validate legacy prompt docs only when present."
    },
    {
      "created_at": "2026-03-06T16:55:36.585Z",
      "author": "maintainer-agent",
      "text": "Implemented docs and test sync: README repository structure no longer references missing docs/prompts paths, and release-readiness legacy prompt contract test now runs only when docs/prompts markdown files are present."
    },
    {
      "created_at": "2026-03-06T17:07:07.929Z",
      "author": "maintainer-agent",
      "text": "Evidence: node scripts/run-tests.mjs test -- tests/integration/release-readiness-contract.spec.ts passed (21 of 21). node dist/cli.js test pm-qkj9 --run --timeout 3600 passed linked tests (2 passed 0 failed) including node scripts/run-tests.mjs coverage with 100 percent lines branches functions statements. node dist/cli.js test-all --status in_progress --timeout 3600 passed (items=1 linked_tests=2 passed=2 failed=0 skipped=0). node dist/cli.js test-all --status closed --timeout 3600 passed (items=97 linked_tests=277 passed=63 failed=0 skipped=214)."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-06T16:52:18.127Z",
      "author": "maintainer-agent",
      "text": "Bootstrap first then detect drift then implement one high value fix"
    }
  ],
  "files": [
    {
      "path": "README.md",
      "scope": "project",
      "note": "repository structure contract sync"
    },
    {
      "path": "tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "note": "legacy prompt-doc contract check tolerates absent docs directory"
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
  "close_reason": "README structure and release-readiness prompt-doc contract test are now aligned with the current repository state; sandbox-safe regression and coverage checks passed."
}

Execute one maintainer loop iteration: bootstrap, detect drift, apply smallest highest-value fix, verify, and log evidence.
