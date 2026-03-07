{
  "id": "pm-fdla",
  "title": "M4 follow-up: remove deleted items from semantic vector indexes",
  "description": "Ensure mutation-triggered semantic refresh removes vector entries for deleted items so semantic/hybrid search indexes stay fresh.",
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
  "created_at": "2026-03-05T13:05:50.978Z",
  "updated_at": "2026-03-05T13:33:52.425Z",
  "deadline": "2026-03-06T23:59:00.000Z",
  "author": "maintainer-agent",
  "estimated_minutes": 90,
  "acceptance_criteria": "Delete and other missing-ID mutation refresh paths remove corresponding vectors in active stores (Qdrant/LanceDB). Warnings stay deterministic and coverage remains 100%.",
  "dependencies": [
    {
      "id": "pm-f45",
      "kind": "parent",
      "created_at": "2026-03-05T13:05:50.978Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-05T13:05:50.978Z",
      "author": "maintainer-agent",
      "text": "Why this exists semantic mutation refresh skips missing IDs and delete flows can leave stale vector records"
    },
    {
      "created_at": "2026-03-05T13:06:04.251Z",
      "author": "maintainer-agent",
      "text": "Planned change-set docs first: clarify semantic mutation refresh delete behavior in PRD and README, then implement vector-store delete execution and missing-ID refresh pruning with deterministic warnings plus targeted/unit regression tests."
    },
    {
      "created_at": "2026-03-05T13:07:11.485Z",
      "author": "maintainer-agent",
      "text": "Docs-first update complete: PRD and README now explicitly require mutation refresh to prune vectors for missing or deleted affected IDs while preserving deterministic warning behavior on failures."
    },
    {
      "created_at": "2026-03-05T13:09:56.362Z",
      "author": "maintainer-agent",
      "text": "Implemented code changes: added vector delete plan/execution in src/core/search/vector-stores.ts and wired src/core/search/cache.ts mutation refresh to prune missing IDs via best-effort vector deletes while keeping deterministic warning/skip behavior for failures."
    },
    {
      "created_at": "2026-03-05T13:09:56.589Z",
      "author": "maintainer-agent",
      "text": "Added regression coverage in tests/unit/vector-store-adapter.spec.ts for build/execute delete behavior and in tests/unit/search-cache.spec.ts for successful missing-ID prune plus deterministic prune-failure warnings."
    },
    {
      "created_at": "2026-03-05T13:33:15.768Z",
      "author": "maintainer-agent",
      "text": "Evidence: pm test pm-fdla --run --timeout 3600 --json passed all linked tests (coverage + targeted search-cache + targeted vector-store-adapter). Regression sweeps passed: pm test-all --status in_progress --timeout 3600 --json => items=1 linked_tests=3 passed=3 failed=0 skipped=0; pm test-all --status closed --timeout 3600 --json => items=71 linked_tests=218 passed=59 failed=0 skipped=159 deterministic dedupe. Coverage proof from linked coverage command remains 100% lines/branches/functions/statements (All files 100/100/100/100). Follow-up items created: none."
    },
    {
      "created_at": "2026-03-05T13:33:52.425Z",
      "author": "maintainer-agent",
      "text": "Post-close release-readiness check: rebuilt and reinstalled pm-cli globally from this repository (pnpm build && npm install -g /home/steve/GITHUB_RELEASE/pm-cli), then verified pm --version=0.1.0 and command availability on PATH."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-05T13:05:50.978Z",
      "author": "maintainer-agent",
      "text": "Plan docs first updates in PRD and README then vector delete support plus unit and integration tests"
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "docs-first semantic refresh delete-pruning contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "docs-first search baseline delete-pruning contract"
    },
    {
      "path": "src/core/search/cache.ts",
      "scope": "project",
      "note": "mutation semantic refresh flow"
    },
    {
      "path": "src/core/search/vector-stores.ts",
      "scope": "project",
      "note": "vector store execution primitives"
    },
    {
      "path": "tests/unit/search-cache.spec.ts",
      "scope": "project",
      "note": "mutation semantic refresh behavior coverage"
    },
    {
      "path": "tests/unit/vector-store-adapter.spec.ts",
      "scope": "project",
      "note": "vector store operation coverage"
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
      "command": "node scripts/run-tests.mjs test -- tests/unit/search-cache.spec.ts",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "targeted mutation refresh regression"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/vector-store-adapter.spec.ts",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "vector store delete operation regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "dogfood workflow and test safety"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative semantic refresh contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "user-facing semantic refresh contract"
    }
  ]
}

Delete mutations currently refresh existing item embeddings but skip missing IDs. This can leave stale vectors in configured stores. This task adds docs-first contract clarification, vector-delete execution support, and mutation refresh behavior that prunes deleted IDs.
