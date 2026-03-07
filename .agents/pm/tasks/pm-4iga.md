{
  "id": "pm-4iga",
  "title": "M4 follow-up: exact-title lexical boost for deterministic search ranking",
  "description": "Improve keyword and hybrid relevance by adding deterministic exact-title token match weighting while preserving stable ordering and output contracts.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:search",
    "code",
    "doc",
    "milestone:4",
    "pm-cli",
    "priority:1",
    "roadmap",
    "tests"
  ],
  "created_at": "2026-03-06T22:11:04.906Z",
  "updated_at": "2026-03-06T22:25:48.883Z",
  "deadline": "2026-03-08T22:11:04.906Z",
  "author": "maintainer-agent",
  "estimated_minutes": 120,
  "acceptance_criteria": "Keyword and hybrid search apply deterministic exact-title token boost; docs are aligned first; tests cover ranking behavior; pm test + test-all sweeps pass with 100% coverage.",
  "dependencies": [
    {
      "id": "pm-f45",
      "kind": "related",
      "created_at": "2026-03-06T22:11:04.906Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-06T22:11:04.906Z",
      "author": "maintainer-agent",
      "text": "Why this exists: Milestone 4 still tracks advanced relevance tuning and exact-title boosting is a bounded deterministic increment."
    },
    {
      "created_at": "2026-03-06T22:11:18.394Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: docs-first update PRD/README search tuning notes for exact-title boost, then implement deterministic title-token bonus in keyword/hybrid scoring and add ranking assertions in search command tests."
    },
    {
      "created_at": "2026-03-06T22:12:41.864Z",
      "author": "maintainer-agent",
      "text": "Implemented docs-first + code changes: PRD/README now describe deterministic exact-title token lexical boost, search scoring adds additive full-token title bonus, and unit tests now verify exact-token titles outrank substring-only title matches."
    },
    {
      "created_at": "2026-03-06T22:15:40.081Z",
      "author": "maintainer-agent",
      "text": "Follow-up during verification: coverage gate revealed nondeterministic branch hit in test-all timeout dedupe path due random item-id ordering. Added deterministic single-item timeout-variant test to always cover max-timeout branch."
    },
    {
      "created_at": "2026-03-06T22:25:48.581Z",
      "author": "maintainer-agent",
      "text": "Evidence: pm test pm-4iga --run --timeout 7200 --json passed linked tests (2/2). pm test-all --status in_progress --timeout 7200 --json passed (items=1 linked_tests=2 passed=2 failed=0 skipped=0). pm test-all --status closed --timeout 7200 --json passed (items=109 linked_tests=299 passed=63 failed=0 skipped=236). Coverage gate is back to 100% lines/branches/functions/statements after deterministic timeout-branch coverage hardening in tests/unit/test-all-command.spec.ts."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-06T22:11:04.906Z",
      "author": "maintainer-agent",
      "text": "Plan docs-first then scoring implementation then ranking tests and full verification sweeps."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative milestone and search scoring update"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "document exact-title lexical boost baseline"
    },
    {
      "path": "src/cli/commands/search.ts",
      "scope": "project",
      "note": "keyword and hybrid scoring logic"
    },
    {
      "path": "tests/unit/search-command.spec.ts",
      "scope": "project",
      "note": "exact-title ranking regression coverage"
    },
    {
      "path": "tests/unit/test-all-command.spec.ts",
      "scope": "project",
      "note": "stabilize deterministic coverage for timeout max-branch"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 2400,
      "note": "coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/search-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "search ranking regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "dogfood workflow rules"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative search roadmap contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public search contract"
    }
  ],
  "close_reason": "Exact-title lexical boost is implemented and docs/tests are aligned with deterministic 100% coverage verification evidence."
}

Advance PRD Milestone 4 hybrid relevance tuning with a bounded deterministic lexical boost for exact title-token matches. Update docs first, then implement scoring changes and regression coverage.
