{
  "id": "pm-6mn1",
  "title": "M4 follow-up: semantic/hybrid search limit=0 deterministic empty result",
  "description": "Make semantic and hybrid search return deterministic empty results when --limit 0 is requested, without vector query execution.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:search",
    "code",
    "docs",
    "milestone:4",
    "pm-cli",
    "priority:1",
    "tests"
  ],
  "created_at": "2026-03-08T11:09:48.873Z",
  "updated_at": "2026-03-08T11:26:27.996Z",
  "deadline": "2026-03-10T23:59:00.000Z",
  "author": "maintainer-agent",
  "estimated_minutes": 75,
  "acceptance_criteria": "Semantic and hybrid search with --limit 0 return empty deterministic results and do not issue embedding/vector queries; docs and tests updated.",
  "definition_of_ready": "Reproduced semantic/hybrid --limit 0 failure path and identified command/test touch points.",
  "order": 1,
  "why_now": "Close an edge-case contract gap before release sweeps.",
  "parent": "pm-f45",
  "risk": "low",
  "confidence": "high",
  "component": "search",
  "regression": true,
  "dependencies": [
    {
      "id": "pm-f45",
      "kind": "parent",
      "created_at": "2026-03-08T11:09:48.873Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-08T11:09:48.873Z",
      "author": "maintainer-agent",
      "text": "Why this exists: semantic/hybrid --limit 0 should be deterministic empty output instead of runtime vector limit errors."
    },
    {
      "created_at": "2026-03-08T11:09:58.857Z",
      "author": "maintainer-agent",
      "text": "Planned change-set: docs-first note for search limit=0 semantics, then implement semantic/hybrid early return in runSearch and add regression tests asserting no embedding/vector calls when limit is zero."
    },
    {
      "created_at": "2026-03-08T11:10:25.845Z",
      "author": "maintainer-agent",
      "text": "Docs-first update complete: PRD and README now explicitly specify that --limit 0 yields deterministic empty search results after mode/config validation without embedding/vector requests."
    },
    {
      "created_at": "2026-03-08T11:26:12.027Z",
      "author": "maintainer-agent",
      "text": "Implemented runSearch limit-zero hardening: keyword mode now returns deterministic empty results when limit is 0, and semantic/hybrid modes now return deterministic empty results after provider/vector validation when limit is 0, avoiding embedding/vector query execution. Added regression unit test coverage for semantic+hybrid limit=0 fetch bypass and updated PRD/README contracts. Evidence: pm test pm-6mn1 --run --timeout 7200 --json passed (2/2 linked tests, coverage run shows 51 files and 455 tests passing with 100% lines/branches/functions/statements); pm test-all --status in_progress --timeout 7200 --json passed totals items=1 linked_tests=2 passed=2 failed=0 skipped=0; pm test-all --status closed --timeout 7200 --json passed totals items=146 linked_tests=374 passed=67 failed=0 skipped=307."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-08T11:09:48.873Z",
      "author": "maintainer-agent",
      "text": "Plan: docs-first note update then implement short-circuit in runSearch and add fetch-call regression coverage."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "limit-zero semantic/hybrid behavior contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public limit-zero search behavior note"
    },
    {
      "path": "src/cli/commands/search.ts",
      "scope": "project",
      "note": "semantic/hybrid limit-0 short-circuit"
    },
    {
      "path": "tests/unit/search-command.spec.ts",
      "scope": "project",
      "note": "regression coverage for limit-zero mode"
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
      "timeout_seconds": 240,
      "note": "targeted search regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "maintainer workflow contract"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "search limit behavior contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public search behavior reference"
    }
  ],
  "close_reason": "Implemented deterministic semantic/hybrid limit=0 empty-result short-circuit with regression tests; pm test and test-all sweeps passed with 100% coverage."
}

Address semantic/hybrid --limit 0 behavior drift and add regression coverage.
