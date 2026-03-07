{
  "id": "pm-3nv9",
  "title": "Enforce close-command closure path",
  "description": "Align docs and command behavior so terminal close transitions use pm close with explicit close reason.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:core",
    "area:docs",
    "close",
    "pm-cli",
    "workflow"
  ],
  "created_at": "2026-03-06T13:04:03.661Z",
  "updated_at": "2026-03-06T13:23:20.847Z",
  "deadline": "2026-03-07T13:04:03.661Z",
  "author": "maintainer-agent",
  "estimated_minutes": 120,
  "acceptance_criteria": "PRD README and AGENTS consistently document pm close for closed transitions; update command rejects --status closed with clear guidance; tests cover new guard; sandboxed regression and coverage remain 100%.",
  "comments": [
    {
      "created_at": "2026-03-06T13:04:03.661Z",
      "author": "maintainer-agent",
      "text": "Detected close workflow drift and opening alignment task"
    },
    {
      "created_at": "2026-03-06T13:04:19.260Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: update docs to use pm close for closed transitions, then enforce update --status closed guard and add test coverage."
    },
    {
      "created_at": "2026-03-06T13:04:28.516Z",
      "author": "maintainer-agent",
      "text": "Docs changeset start: clarify PRD update terminal-status semantics and sync README AGENTS close examples."
    },
    {
      "created_at": "2026-03-06T13:05:23.590Z",
      "author": "maintainer-agent",
      "text": "Code changeset start: enforce update status guard so closed transitions require pm close."
    },
    {
      "created_at": "2026-03-06T13:06:49.095Z",
      "author": "maintainer-agent",
      "text": "Implemented docs-first and code updates: PRD now forbids update --status closed, README and AGENTS close via pm close, update command now errors on closed status, and README integration test now uses close command."
    },
    {
      "created_at": "2026-03-06T13:07:54.822Z",
      "author": "maintainer-agent",
      "text": "Verification failure triage: canceled-status unit case hit ownership conflict because seeded assignee differs from default author; applying targeted test fix with explicit matching author then rerunning linked tests."
    },
    {
      "created_at": "2026-03-06T13:20:48.451Z",
      "author": "maintainer-agent",
      "text": "Evidence: node dist/cli.js test pm-3nv9 --run --timeout 7200 --json passed all 3 linked tests after one deterministic unit-test fixture adjustment; node dist/cli.js test-all --status in_progress --timeout 7200 --json passed totals items=1 linked_tests=3 passed=3 failed=0 skipped=0; node dist/cli.js test-all --status closed --timeout 7200 --json passed totals items=87 linked_tests=260 passed=62 failed=0 skipped=198; coverage remains 100% statements branches functions and lines."
    },
    {
      "created_at": "2026-03-06T13:23:12.675Z",
      "author": "maintainer-agent",
      "text": "Post-lint-cleanup verification: node dist/cli.js test pm-3nv9 --run --timeout 7200 --json passed all 3 linked tests; node dist/cli.js test-all --status in_progress --timeout 7200 --json passed totals items=1 linked_tests=3 passed=3 failed=0 skipped=0; coverage remains 100% statements branches functions and lines."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-06T13:04:03.661Z",
      "author": "maintainer-agent",
      "text": "Plan docs first then update guard then tests and regression"
    }
  ],
  "files": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "canonical close workflow sync"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "close workflow contract clarification"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "close workflow quickstart sync"
    },
    {
      "path": "src/cli/commands/update.ts",
      "scope": "project",
      "note": "guard closed status in update"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "update help text reflects close workflow"
    },
    {
      "path": "tests/integration/help-readme-contract.spec.ts",
      "scope": "project",
      "note": "quickstart lifecycle closes via close command"
    },
    {
      "path": "tests/unit/update-command.spec.ts",
      "scope": "project",
      "note": "coverage for closed-status guard"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 2400,
      "note": "full sandboxed coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/integration/help-readme-contract.spec.ts",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "README lifecycle contract regression"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/update-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "targeted update command regression"
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
      "note": "public workflow examples"
    }
  ],
  "close_reason": "Docs and update closure workflow aligned with contract and tests"
}

PRD requires close_reason semantics via pm close. README and AGENTS still demonstrate pm update --status closed, and update currently allows closed without close_reason. This task aligns contract docs and command behavior.
