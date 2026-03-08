{
  "id": "pm-f35q",
  "title": "M4 follow-up: resolve search sonar warnings",
  "description": "Refactor search command and unit test mocks to clear active Sonar warnings while preserving behavior.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:search",
    "milestone:4",
    "pm-cli",
    "quality",
    "tests"
  ],
  "created_at": "2026-03-08T11:27:13.069Z",
  "updated_at": "2026-03-08T12:55:22.502Z",
  "deadline": "2026-03-10T11:27:13.069Z",
  "author": "maintainer-agent",
  "estimated_minutes": 90,
  "acceptance_criteria": "No active Sonar warnings remain in search.ts or search-command.spec.ts; search behavior and tests remain passing with 100% coverage.",
  "definition_of_ready": "Warnings reproduced and file-level diagnostics captured.",
  "order": 2,
  "value": "Reduce static-analysis debt in search path.",
  "impact": "Improves maintainability and release confidence.",
  "outcome": "Cleaner command logic and safer test mock parsing.",
  "why_now": "Outstanding warnings are the only known follow-up after pm-6mn1 verification.",
  "parent": "pm-f45",
  "risk": "low",
  "confidence": "high",
  "component": "search",
  "regression": true,
  "dependencies": [
    {
      "id": "pm-f45",
      "kind": "parent",
      "created_at": "2026-03-08T11:27:13.069Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-08T11:27:13.069Z",
      "author": "maintainer-agent",
      "text": "Why this exists: clear active Sonar warnings in search command + tests after limit-zero follow-up."
    },
    {
      "created_at": "2026-03-08T11:43:31.827Z",
      "author": "maintainer-agent",
      "text": "Implemented warning cleanup in search command/tests: introduced SearchMode type alias and extracted semantic/hybrid execution helpers (dependency validation, semantic-hit projection, hybrid merge) to reduce runSearch complexity; updated fetch mock utilities to use explicit URL/body normalization without Object default stringification. Verification: ReadLints reports no diagnostics for src/cli/commands/search.ts and tests/unit/search-command.spec.ts. Evidence: pm test pm-f35q --run --timeout 7200 --json passed (2/2 linked tests; coverage run reports 51 files and 455 tests passing at 100% statements/branches/functions/lines); pm test-all --status in_progress --timeout 7200 --json passed totals items=1 linked_tests=2 passed=2 failed=0 skipped=0; pm test-all --status closed --timeout 7200 --json passed totals items=147 linked_tests=376 passed=67 failed=0 skipped=309."
    },
    {
      "created_at": "2026-03-08T12:55:22.502Z",
      "author": "maintainer-agent",
      "text": "Revalidation before commit: pm test pm-f35q --run --timeout 7200 --json passed (2/2 linked tests: coverage + targeted search suite). pm test-all --status in_progress --timeout 7200 --json passed totals items=0 linked_tests=0 passed=0 failed=0 skipped=0. pm test-all --status closed --timeout 7200 --json passed totals items=148 linked_tests=378 passed=67 failed=0 skipped=311. Coverage remains 100% lines/branches/functions/statements."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-08T11:27:13.069Z",
      "author": "maintainer-agent",
      "text": "Plan: extract helper(s) in runSearch and harden fetch request parsing in tests."
    }
  ],
  "files": [
    {
      "path": "src/cli/commands/search.ts",
      "scope": "project",
      "note": "primary warning source"
    },
    {
      "path": "tests/unit/search-command.spec.ts",
      "scope": "project",
      "note": "test warning source"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/search-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 300,
      "note": "targeted regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "workflow contract"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "search behavior contract"
    }
  ],
  "close_reason": "Cleared active Sonar warnings in search command/tests with helper refactor and explicit fetch mock parsing; linked tests and full test-all sweeps passed with 100% coverage."
}

Address current Sonar warnings in src/cli/commands/search.ts and tests/unit/search-command.spec.ts as a release-readiness cleanup.
