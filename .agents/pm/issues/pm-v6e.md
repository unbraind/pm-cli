{
  "id": "pm-v6e",
  "title": "Deduplicate test-all linked test execution across items",
  "description": "test-all currently re-runs identical linked commands/files for multiple items, causing excessive runtime on large boards.",
  "type": "Issue",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:test-all",
    "code",
    "milestone:3",
    "pm-cli",
    "priority:1",
    "tests"
  ],
  "created_at": "2026-02-20T20:58:59.997Z",
  "updated_at": "2026-02-20T21:47:55.636Z",
  "deadline": "2026-02-27T20:58:59.000Z",
  "author": "steve-maintainer",
  "estimated_minutes": 120,
  "acceptance_criteria": "test-all executes each unique linked command/path at most once per invocation, duplicates are marked skipped (not failed), totals remain deterministic, and unit/integration tests cover duplicate command and duplicate path scenarios.",
  "dependencies": [
    {
      "id": "pm-54d",
      "kind": "parent",
      "created_at": "2026-02-20T20:58:59.997Z",
      "author": "steve-maintainer"
    },
    {
      "id": "pm-66o",
      "kind": "related",
      "created_at": "2026-02-20T20:58:59.997Z",
      "author": "steve-maintainer"
    }
  ],
  "comments": [
    {
      "created_at": "2026-02-20T20:58:59.997Z",
      "author": "steve-maintainer",
      "text": "Issue requested: test-all should skip duplicate linked commands/files to reduce runtime on repos where many items share the same linked tests."
    },
    {
      "created_at": "2026-02-20T21:05:34.649Z",
      "author": "cursor-maintainer",
      "text": "Implement deterministic test-all dedupe by normalized command/path key; duplicates should be skipped with explicit reason and excluded from duplicate execution."
    },
    {
      "created_at": "2026-02-20T21:09:21.362Z",
      "author": "cursor-maintainer",
      "text": "Docs-first update completed in PRD.md and README.md to codify duplicate skip semantics for test-all. Implemented test-all dedupe by normalized linked-test keys (command/path), executing each unique key once and returning deterministic skipped results for duplicates."
    },
    {
      "created_at": "2026-02-20T21:17:13.009Z",
      "author": "cursor-maintainer",
      "text": "Fixed wrapper export parity by re-exporting runLinkedTests from src/commands/test.ts; this resolves command-wrapper-exports regression triggered by new shared runner export."
    },
    {
      "created_at": "2026-02-20T21:47:55.205Z",
      "author": "cursor-maintainer",
      "text": "Evidence: (1) node dist/cli.js test pm-v6e --run --timeout 1200 --json passed (tests/unit/test-all-command.spec.ts: 5/5). (2) node dist/cli.js test-all --status in_progress --timeout 1800 --json passed with totals items=10 linked_tests=52 passed=34 failed=0 skipped=18. (3) node dist/cli.js test-all --status closed --timeout 1800 --json passed with totals items=19 linked_tests=53 passed=19 failed=0 skipped=34. Coverage proof: in in_progress run_results, command node scripts/run-tests.mjs coverage returned status=passed exit_code=0, keeping the 100% coverage gate satisfied."
    }
  ],
  "notes": [
    {
      "created_at": "2026-02-20T20:58:59.997Z",
      "author": "steve-maintainer",
      "text": "Likely implementation point is src/cli/commands/test-all.ts by tracking a normalized command/path key set per invocation."
    }
  ],
  "learnings": [
    {
      "created_at": "2026-02-20T20:58:59.997Z",
      "author": "steve-maintainer",
      "text": "Performance bottleneck scales with duplicate linked tests across items; deduping at orchestration layer should reduce wall time substantially."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "document test-all duplicate skip semantics"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "document deterministic duplicate-skip orchestration behavior"
    },
    {
      "path": "src/cli/commands/test-all.ts",
      "scope": "project",
      "note": "deduplicate execution keys for linked tests"
    },
    {
      "path": "src/cli/commands/test.ts",
      "scope": "project",
      "note": "export shared linked-test runner for test-all dedupe"
    },
    {
      "path": "src/commands/test.ts",
      "scope": "project",
      "note": "keep legacy wrapper export surface aligned after runLinkedTests export"
    },
    {
      "path": "tests/unit/test-all-command.spec.ts",
      "scope": "project",
      "note": "add duplicate skip behavior coverage"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/test-all-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 900,
      "note": "targeted test-all dedupe behavior regression"
    }
  ],
  "docs": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "update test-all deterministic orchestration contract if behavior/output changes"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "document duplicate-skip semantics for test-all"
    }
  ]
}

Problem: when multiple items link the same test command/path, pm test-all executes duplicates repeatedly. Proposed behavior: skip duplicate command/path entries within a single test-all run while preserving deterministic results and reporting.
