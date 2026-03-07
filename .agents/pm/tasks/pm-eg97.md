{
  "id": "pm-eg97",
  "title": "M4 roadmap: mutation-triggered semantic embedding refresh",
  "description": "Refresh semantic/vector index records on item mutations when semantic search is configured.",
  "type": "Task",
  "status": "closed",
  "priority": 2,
  "tags": [
    "area:search",
    "code",
    "milestone:4",
    "pm-cli",
    "priority:2",
    "roadmap"
  ],
  "created_at": "2026-03-04T21:46:22.475Z",
  "updated_at": "2026-03-04T22:25:16.415Z",
  "deadline": "2026-03-18T21:46:22.000Z",
  "author": "maintainer-agent",
  "estimated_minutes": 180,
  "acceptance_criteria": "Item mutations update semantic embeddings for affected items when semantic configuration is valid; fallback behavior remains deterministic when providers/stores are unavailable; tests cover success/failure paths and coverage gate remains 100%.",
  "dependencies": [
    {
      "id": "pm-f45",
      "kind": "related",
      "created_at": "2026-03-04T21:46:22.475Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-04T21:46:22.475Z",
      "author": "maintainer-agent",
      "text": "Roadmap gap from PRD Milestone 4 requires tracked implementation work."
    },
    {
      "created_at": "2026-03-04T21:51:09.470Z",
      "author": "cursor-maintainer-agent",
      "text": "Implement best-effort mutation-triggered semantic embedding refresh for changed item IDs while retaining deterministic keyword cache invalidation. Wire refresh dispatch in CLI mutation paths and add unit coverage for configured/unconfigured/failure scenarios."
    },
    {
      "created_at": "2026-03-04T22:25:11.756Z",
      "author": "cursor-maintainer-agent",
      "text": "Evidence: reran linked tests and regressions after final test fix. Commands: pm test pm-eg97 --run --timeout 1800 --json; pm test-all --status in_progress --timeout 1800 --json; pm test-all --status closed --timeout 1800 --json. Results: pm-eg97 linked tests 4/4 passed; in_progress totals items=1 linked_tests=4 passed=4 failed=0 skipped=0; closed totals items=62 linked_tests=196 passed=57 failed=0 skipped=139. Coverage gate remains 100% lines/branches/functions/statements (including src/core/search/cache.ts at 100/100/100/100)."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-04T21:46:22.475Z",
      "author": "maintainer-agent",
      "text": "Plan is docs first then targeted refresh implementation with coverage."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "update roadmap completion text"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "document semantic refresh baseline"
    },
    {
      "path": "src/cli/commands/search.ts",
      "scope": "project",
      "note": "search command behavior context"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "trigger semantic refresh after mutations"
    },
    {
      "path": "src/core/search/cache.ts",
      "scope": "project",
      "note": "mutation cache + semantic refresh orchestration"
    },
    {
      "path": "src/core/search/providers.ts",
      "scope": "project",
      "note": "embedding provider execution path"
    },
    {
      "path": "src/core/search/vector-stores.ts",
      "scope": "project",
      "note": "vector store upsert query path"
    },
    {
      "path": "tests/unit/search-cache.spec.ts",
      "scope": "project",
      "note": "unit coverage for refresh behavior"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/reindex-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "reindex baseline regression"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/search-cache.spec.ts",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "targeted mutation refresh tests"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/search-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "targeted search regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "governing maintainer workflow"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative roadmap contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public behavior notes"
    }
  ]
}

Implement deterministic mutation-triggered embedding refresh for changed items after successful item mutations when semantic search configuration is available. Preserve deterministic warning behavior when semantic configuration is absent or providers/stores fail.
