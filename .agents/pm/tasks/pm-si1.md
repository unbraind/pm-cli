{
  "id": "pm-si1",
  "title": "M6: Fixture corpus for restore import and search",
  "description": "Create deterministic fixture corpus consumed by restore, beads import, and search command regressions.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:fixtures",
    "core",
    "milestone:6",
    "pm-cli"
  ],
  "created_at": "2026-02-17T23:02:12.642Z",
  "updated_at": "2026-02-20T10:12:29.810Z",
  "deadline": "2026-03-19T23:02:12.642Z",
  "author": "steve",
  "estimated_minutes": 180,
  "acceptance_criteria": "Fixtures live under tests/fixtures and are consumed by restore/beads/search tests; pm test and test-all pass with 100% coverage.",
  "dependencies": [
    {
      "id": "pm-b1w",
      "kind": "blocks",
      "created_at": "2026-02-17T23:02:12.642Z",
      "author": "steve"
    },
    {
      "id": "pm-jiw",
      "kind": "parent",
      "created_at": "2026-02-17T23:02:12.642Z",
      "author": "steve"
    }
  ],
  "comments": [
    {
      "created_at": "2026-02-20T09:14:28.160Z",
      "author": "cursor-maintainer-agent",
      "text": "Planned change-set: add deterministic fixture corpus under tests/fixtures for restore, beads import, and keyword search scenarios; refactor/extend unit tests to consume fixtures; then run pm test + test-all and log 100% coverage evidence."
    },
    {
      "created_at": "2026-02-20T09:19:03.247Z",
      "author": "cursor-maintainer-agent",
      "text": "Implemented change-set: added deterministic fixture corpus files under tests/fixtures (restore create seed, beads import/conversion JSONL, search keyword corpus) plus shared fixture loader helpers; updated restore/beads/search unit tests to consume these fixtures; updated PRD Milestone 6 checklist to mark fixture corpus complete."
    },
    {
      "created_at": "2026-02-20T09:42:54.056Z",
      "author": "cursor-maintainer-agent",
      "text": "Follow-up cleanup: removed an unused local assignment in beads fixture test wiring (updatedAt) to keep static analysis clean without behavioral change."
    },
    {
      "created_at": "2026-02-20T10:12:03.337Z",
      "author": "cursor-maintainer-agent",
      "text": "Evidence: node dist/cli.js test pm-si1 --run --timeout 2400 --json passed 4/4 linked tests (coverage + restore/beads/search fixture regressions). Regression sweeps (rerun after lint cleanup) passed: node dist/cli.js test-all --status in_progress --timeout 2400 --json => items=9 linked_tests=45 passed=44 failed=0 skipped=1; node dist/cli.js test-all --status closed --timeout 2400 --json => items=18 linked_tests=49 passed=46 failed=0 skipped=3. Coverage proof: node scripts/run-tests.mjs coverage reports 100% lines/branches/functions/statements. Follow-up items created: none."
    }
  ],
  "files": [
    {
      "path": "tests/fixtures/beads/conversion-branches.jsonl",
      "scope": "project",
      "note": "beads conversion branch fixture corpus"
    },
    {
      "path": "tests/fixtures/beads/import-records.jsonl",
      "scope": "project",
      "note": "beads import fixture corpus"
    },
    {
      "path": "tests/fixtures/restore/create-seed.json",
      "scope": "project",
      "note": "restore create seed fixture"
    },
    {
      "path": "tests/fixtures/restore/history-stream.jsonl",
      "scope": "project",
      "note": "deterministic restore fixture stream"
    },
    {
      "path": "tests/fixtures/search/keyword-corpus.json",
      "scope": "project",
      "note": "search keyword corpus fixture"
    },
    {
      "path": "tests/helpers/fixtures.ts",
      "scope": "project",
      "note": "shared deterministic fixture loader helpers"
    },
    {
      "path": "tests/unit/beads-command.spec.ts",
      "scope": "project",
      "note": "beads fixture-driven tests"
    },
    {
      "path": "tests/unit/restore-command.spec.ts",
      "scope": "project",
      "note": "restore fixture-driven tests"
    },
    {
      "path": "tests/unit/search-command.spec.ts",
      "scope": "project",
      "note": "search fixture-driven tests"
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
      "command": "node scripts/run-tests.mjs test -- tests/unit/beads-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 900,
      "note": "beads fixture regression"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/restore-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 900,
      "note": "restore fixture regression"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/search-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 900,
      "note": "search fixture regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "dogfood workflow and evidence protocol"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "governing spec for milestone 6 fixtures"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public behavior and testing contract"
    }
  ]
}

Add deterministic fixture corpus for test coverage.
