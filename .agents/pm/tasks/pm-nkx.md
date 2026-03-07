{
  "id": "pm-nkx",
  "title": "M1: Lock acquire release with TTL and conflicts",
  "description": "Implement lock file behavior stale handling and conflict exit flow.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:locking",
    "core",
    "milestone:1",
    "pm-cli"
  ],
  "created_at": "2026-02-17T23:02:08.036Z",
  "updated_at": "2026-02-22T19:17:01.504Z",
  "deadline": "2026-02-23T23:02:08.036Z",
  "author": "steve",
  "estimated_minutes": 120,
  "acceptance_criteria": "Met: Lock behavior enforces conflict and stale lock policy, verified by linked lock tests and full regression sweeps.",
  "dependencies": [
    {
      "id": "pm-2xl",
      "kind": "blocks",
      "created_at": "2026-02-17T23:02:08.036Z",
      "author": "steve"
    },
    {
      "id": "pm-u9r",
      "kind": "parent",
      "created_at": "2026-02-17T23:02:08.036Z",
      "author": "steve"
    }
  ],
  "comments": [
    {
      "created_at": "2026-02-22T19:06:47.516Z",
      "author": "cursor-maintainer",
      "text": "Validation plan: confirm lock acquire/release TTL conflict behavior against src/core/lock/lock.ts and close this stale-open task if linked tests and regression sweeps pass."
    },
    {
      "created_at": "2026-02-22T19:17:01.051Z",
      "author": "cursor-maintainer",
      "text": "Evidence: pm test pm-nkx --run --timeout 3600 --json passed 2/2 linked tests (coverage + targeted lock suite); pm test-all --status in_progress --timeout 3600 --json totals items=9 linked_tests=30 passed=11 failed=0 skipped=19; pm test-all --status closed --timeout 3600 --json totals items=27 linked_tests=101 passed=46 failed=0 skipped=55. Coverage remains 100% lines/branches/functions/statements."
    }
  ],
  "files": [
    {
      "path": "src/core/lock/lock.ts",
      "scope": "project",
      "note": "lock acquire release implementation"
    },
    {
      "path": "src/core/store/item-store.ts",
      "scope": "project",
      "note": "mutation lock integration"
    },
    {
      "path": "tests/unit/core-item-lock-coverage.spec.ts",
      "scope": "project",
      "note": "lock conflict and stale handling coverage"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 2400,
      "note": "coverage gate verification"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/core-item-lock-coverage.spec.ts",
      "scope": "project",
      "timeout_seconds": 900,
      "note": "targeted lock behavior verification"
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
      "note": "governing spec"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "user-facing contract"
    }
  ]
}

Implement lock acquire and release primitives with TTL support.
