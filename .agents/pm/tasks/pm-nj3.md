{
  "id": "pm-nj3",
  "title": "M4: Reindex command",
  "description": "Implement keyword baseline reindex operations for deterministic search cache artifacts.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:reindex",
    "core",
    "milestone:4",
    "pm-cli"
  ],
  "created_at": "2026-02-17T23:02:10.920Z",
  "updated_at": "2026-02-18T22:21:57.170Z",
  "deadline": "2026-03-07T23:02:10.920Z",
  "author": "steve",
  "estimated_minutes": 90,
  "acceptance_criteria": "pm reindex rebuilds index/manifest.json and search/embeddings.jsonl deterministically; tests and coverage remain 100%.",
  "dependencies": [
    {
      "id": "pm-54d",
      "kind": "blocks",
      "created_at": "2026-02-17T23:02:10.920Z",
      "author": "steve"
    },
    {
      "id": "pm-f45",
      "kind": "parent",
      "created_at": "2026-02-17T23:02:10.920Z",
      "author": "steve"
    }
  ],
  "comments": [
    {
      "created_at": "2026-02-18T22:00:24.444Z",
      "author": "cursor-maintainer",
      "text": "Planned change-set: docs-first add reindex command contract for keyword cache rebuild baseline, then implement pm reindex command + unit/integration coverage and run pm test/pm test-all evidence."
    },
    {
      "created_at": "2026-02-18T22:01:25.957Z",
      "author": "cursor-maintainer",
      "text": "Docs-first alignment applied: README and PRD now treat pm reindex as implemented keyword-cache baseline, while semantic/vector reindex behavior remains roadmap. Updated command matrix/output contract and milestone wording accordingly before code changes."
    },
    {
      "created_at": "2026-02-18T22:03:49.076Z",
      "author": "cursor-maintainer",
      "text": "Implemented reindex command baseline: added src/cli/commands/reindex.ts plus CLI wiring (main.ts + command index + legacy wrapper), updated integration + unit tests, and expanded coverage include for src/cli/commands/reindex.ts."
    },
    {
      "created_at": "2026-02-18T22:21:56.803Z",
      "author": "cursor-maintainer",
      "text": "Evidence: pm test pm-nj3 --run --timeout 1800 --json passed all linked tests (coverage/test/targeted reindex), with coverage at 100% lines/branches/functions/statements including src/cli/commands/reindex.ts. Regression sweeps: pm test-all --status in_progress --timeout 1800 --json => items=4 linked_tests=17 passed=16 failed=0 skipped=1; pm test-all --status closed --timeout 1800 --json => items=12 linked_tests=31 passed=28 failed=0 skipped=3."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "docs-first command contract update"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "docs-first command contract update"
    },
    {
      "path": "src/cli/commands/index.ts",
      "scope": "project",
      "note": "export reindex handler"
    },
    {
      "path": "src/cli/commands/reindex.ts",
      "scope": "project",
      "note": "implement keyword reindex"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "register reindex command"
    },
    {
      "path": "src/commands/reindex.ts",
      "scope": "project",
      "note": "legacy wrapper export"
    },
    {
      "path": "tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "note": "integration reindex smoke"
    },
    {
      "path": "tests/unit/reindex-command.spec.ts",
      "scope": "project",
      "note": "unit coverage for reindex"
    },
    {
      "path": "tests/unit/structure-exports.spec.ts",
      "scope": "project",
      "note": "export surface check for reindex"
    },
    {
      "path": "vitest.config.ts",
      "scope": "project",
      "note": "coverage include for reindex command"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "sandboxed coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "sandboxed regression suite"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/reindex-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 600,
      "note": "targeted reindex unit tests"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "agent operating rules"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "governing spec"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public contract"
    }
  ]
}

Add reindex workflows for search pipelines.
