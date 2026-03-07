{
  "id": "pm-f45",
  "title": "Milestone 4 - Search",
  "description": "Milestone epic for keyword semantic hybrid search and indexing.",
  "type": "Epic",
  "status": "closed",
  "priority": 0,
  "tags": [
    "area:search",
    "core",
    "milestone:4",
    "pm-cli"
  ],
  "created_at": "2026-02-17T23:01:11.736Z",
  "updated_at": "2026-03-04T15:27:57.518Z",
  "deadline": "2026-03-07T23:01:11.736Z",
  "author": "steve",
  "estimated_minutes": 480,
  "acceptance_criteria": "Milestone 4 checklist items are implemented with reindexing behavior.",
  "dependencies": [
    {
      "id": "pm-54d",
      "kind": "blocks",
      "created_at": "2026-02-17T23:01:11.736Z",
      "author": "steve"
    },
    {
      "id": "pm-j7a",
      "kind": "child",
      "created_at": "2026-02-17T23:01:11.736Z",
      "author": "steve"
    }
  ],
  "comments": [
    {
      "created_at": "2026-02-17T23:01:11.736Z",
      "author": "steve",
      "text": "Milestone 4 provides discoverability across item and linked content."
    },
    {
      "created_at": "2026-03-04T15:17:54.037Z",
      "author": "cursor-agent",
      "text": "Planned closure validation: verify search/reindex command parity and run sandbox-safe targeted + full coverage regressions before closing."
    },
    {
      "created_at": "2026-03-04T15:27:21.511Z",
      "author": "cursor-agent",
      "text": "Evidence: pm test pm-f45 --run --timeout 3600 passed (2/2 linked tests). pm test-all --status in_progress --timeout 3600 passed (items=1, passed=2, failed=0). pm test-all --status closed --timeout 3600 passed (items=48, linked_tests=169, passed=54, failed=0, skipped=115 duplicate-dedup expected). Coverage artifact coverage/coverage-summary.json reports 100% lines/statements/functions/branches. PRD-vs-help command parity check confirms required command surface present for milestone search scope."
    },
    {
      "created_at": "2026-03-04T15:27:57.518Z",
      "author": "cursor-agent",
      "text": "Session bootstrap evidence: detected PM_CMD=pm, enforced global installation from this repo via npm i -g ., verified command path and pm --version=0.1.0, and baseline pnpm build completed successfully before milestone validation."
    }
  ],
  "notes": [
    {
      "created_at": "2026-02-17T23:01:11.736Z",
      "author": "steve",
      "text": "Success means keyword mode always works and semantic mode is optional."
    }
  ],
  "files": [
    {
      "path": "src/cli/commands/reindex.ts",
      "scope": "project",
      "note": "reindex command entrypoint"
    },
    {
      "path": "src/cli/commands/search.ts",
      "scope": "project",
      "note": "search command entrypoint"
    },
    {
      "path": "src/core/search/providers.ts",
      "scope": "project",
      "note": "embedding provider abstraction"
    },
    {
      "path": "src/core/search/vector-stores.ts",
      "scope": "project",
      "note": "vector store abstraction"
    },
    {
      "path": "tests/unit/embedding-provider.spec.ts",
      "scope": "project",
      "note": "provider tests"
    },
    {
      "path": "tests/unit/reindex-command.spec.ts",
      "scope": "project",
      "note": "reindex tests"
    },
    {
      "path": "tests/unit/search-command.spec.ts",
      "scope": "project",
      "note": "search command tests"
    },
    {
      "path": "tests/unit/vector-store-adapter.spec.ts",
      "scope": "project",
      "note": "vector adapter tests"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "full coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/search-command.spec.ts tests/unit/reindex-command.spec.ts tests/unit/embedding-provider.spec.ts tests/unit/vector-store-adapter.spec.ts",
      "scope": "project",
      "timeout_seconds": 900,
      "note": "targeted milestone4 regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "agent workflow and dogfood rules"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative requirements"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public contract alignment"
    }
  ]
}

Implement deterministic keyword and optional semantic search paths.
