{
  "id": "pm-i25f",
  "title": "M4: Honor embedding batch + retry settings in semantic indexing",
  "description": "Wire search.embedding_batch_size and search.scanner_max_batch_retries into semantic reindex and mutation refresh flows with deterministic retry warnings.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:search",
    "code",
    "milestone:4",
    "pm-cli",
    "priority:1",
    "tests"
  ],
  "created_at": "2026-03-07T10:27:27.606Z",
  "updated_at": "2026-03-07T10:44:20.607Z",
  "deadline": "2026-03-08T23:59:00.000Z",
  "author": "maintainer-agent",
  "estimated_minutes": 120,
  "acceptance_criteria": "Semantic embedding generation uses search.embedding_batch_size batches and retries each failed batch up to search.scanner_max_batch_retries with deterministic warning output; tests cover success and failure paths.",
  "comments": [
    {
      "created_at": "2026-03-07T10:27:27.606Z",
      "author": "maintainer-agent",
      "text": "Roadmap gap settings expose embedding_batch_size and scanner_max_batch_retries but command-path semantic indexing does not consume them yet."
    },
    {
      "created_at": "2026-03-07T10:27:34.029Z",
      "author": "maintainer-agent",
      "text": "Planned change-set: docs-first clarify that semantic reindex and mutation refresh honor embedding_batch_size and scanner_max_batch_retries, then implement shared batched embedding retry helper and add deterministic unit coverage for retry exhaustion behavior."
    },
    {
      "created_at": "2026-03-07T10:29:51.560Z",
      "author": "maintainer-agent",
      "text": "Implemented docs-first and code change-set: added shared embedding batch+retry helper, wired semantic reindex and mutation semantic refresh to honor settings.search.embedding_batch_size and settings.search.scanner_max_batch_retries, and added targeted unit tests for retry success paths."
    },
    {
      "created_at": "2026-03-07T10:44:09.924Z",
      "author": "maintainer-agent",
      "text": "Evidence: (1) pm test pm-i25f --run --timeout 2400 --json passed 3/3 linked tests including node scripts/run-tests.mjs coverage with 100% statements/branches/functions/lines. (2) pm test-all --status in_progress --timeout 2400 --json passed totals items=1 linked_tests=3 passed=3 failed=0 skipped=0. (3) pm test-all --status closed --timeout 2400 --json passed totals items=122 linked_tests=330 passed=62 failed=0 skipped=268. Behavior proof: semantic embedding execution now honors settings.search.embedding_batch_size + settings.search.scanner_max_batch_retries in reindex and mutation refresh paths with deterministic retry-success warnings."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-07T10:27:27.606Z",
      "author": "maintainer-agent",
      "text": "Plan docs-first update then shared batched retry helper then reindex and cache tests."
    }
  ],
  "files": [
    {
      "path": "src/cli/commands/reindex.ts",
      "scope": "project",
      "note": "semantic reindex batching wiring"
    },
    {
      "path": "src/core/search/cache.ts",
      "scope": "project",
      "note": "mutation refresh batching wiring"
    },
    {
      "path": "src/core/search/embedding-batches.ts",
      "scope": "project",
      "note": "shared embedding batching+retry helper"
    },
    {
      "path": "tests/unit/reindex-command.spec.ts",
      "scope": "project",
      "note": "reindex batching tests"
    },
    {
      "path": "tests/unit/search-cache.spec.ts",
      "scope": "project",
      "note": "semantic refresh batching tests"
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
      "command": "node scripts/run-tests.mjs test -- tests/unit/reindex-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "targeted reindex regression"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/search-cache.spec.ts",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "targeted semantic refresh regression"
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
      "note": "search settings contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public search settings behavior"
    }
  ],
  "close_reason": "Implemented batched semantic embedding execution with deterministic retry policy and full passing regression sweeps"
}

Implement deterministic batched embedding execution for semantic/hybrid reindex and mutation refresh. Respect configured batch size and retry attempts. Preserve vector upsert determinism and emit stable warnings when retries are exhausted.
