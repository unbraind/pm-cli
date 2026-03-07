{
  "id": "pm-kj4",
  "title": "M4: Vector store adapters for Qdrant and LanceDB",
  "description": "Implement deterministic vector store adapter resolution/planning for Qdrant and LanceDB, then wire semantic/hybrid mode validation to include provider + vector resolution context.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:search-vector",
    "core",
    "milestone:4",
    "pm-cli"
  ],
  "created_at": "2026-02-17T23:02:10.455Z",
  "updated_at": "2026-02-23T11:31:28.373Z",
  "deadline": "2026-03-07T23:02:10.455Z",
  "author": "steve",
  "estimated_minutes": 180,
  "acceptance_criteria": "Vector-store adapters resolve deterministic active/available config for Qdrant/LanceDB, semantic/hybrid search+reindex validate both provider and vector store with explicit diagnostics, and coverage remains 100%.",
  "dependencies": [
    {
      "id": "pm-54d",
      "kind": "blocks",
      "created_at": "2026-02-17T23:02:10.455Z",
      "author": "steve"
    },
    {
      "id": "pm-f45",
      "kind": "parent",
      "created_at": "2026-02-17T23:02:10.455Z",
      "author": "steve"
    }
  ],
  "comments": [
    {
      "created_at": "2026-02-21T01:51:29.039Z",
      "author": "cursor-maintainer-agent",
      "text": "Planned docs-first change-set: update PRD.md and README.md to mark vector-store adapter resolution/planning baseline as partial, then implement deterministic Qdrant/LanceDB adapter helpers and wire semantic/hybrid search/reindex validation to require both embedding provider and vector store before returning roadmap-not-implemented diagnostics."
    },
    {
      "created_at": "2026-02-21T02:07:06.006Z",
      "author": "cursor-maintainer-agent",
      "text": "Implemented docs-first vector-store adapter baseline increment. Docs: updated PRD.md Milestone 4 checklist + provider/vector baseline text and README.md planned-search section to mark Qdrant/LanceDB config-resolution/request-target-planning baseline as partial while semantic/vector execution remains roadmap. Code: added src/core/search/vector-stores.ts with deterministic Qdrant/LanceDB resolver + request/query/upsert plan helpers; wired src/cli/commands/search.ts and src/cli/commands/reindex.ts semantic/hybrid gating to require both embedding provider and vector store and emit explicit provider/vector diagnostics; added tests/unit/vector-store-adapter.spec.ts and updated tests/unit/search-command.spec.ts + tests/unit/reindex-command.spec.ts; added vitest coverage include for src/core/search/vector-stores.ts. Evidence: node dist/cli.js test pm-kj4 --run --timeout 3000 --json passed all linked tests (4/4). Regression: node dist/cli.js test-all --status in_progress --timeout 3000 --json => items=11 linked_tests=59 passed=35 failed=0 skipped=24; node dist/cli.js test-all --status closed --timeout 3000 --json => items=21 linked_tests=57 passed=20 failed=0 skipped=37. Coverage proof: node scripts/run-tests.mjs coverage reports 100% lines/branches/functions/statements."
    },
    {
      "created_at": "2026-02-22T19:37:48.633Z",
      "author": "cursor-maintainer",
      "text": "Planned changeset: docs-first update PRD.md and README.md to reflect vector-store request execution helper baseline (request payload/response normalization plus deterministic timeout/error handling) while semantic/hybrid query integration remains roadmap; then implement executeVectorQuery/executeVectorUpsert helpers in src/core/search/vector-stores.ts with targeted unit coverage in tests/unit/vector-store-adapter.spec.ts."
    },
    {
      "created_at": "2026-02-22T20:23:59.876Z",
      "author": "cursor-maintainer",
      "text": "Implemented docs-first vector adapter hardening: README.md and PRD.md now describe Qdrant request payload/response normalization and deterministic query/upsert request-execution helper baseline while semantic/hybrid vector integration and LanceDB local execution remain roadmap. Code updates in src/core/search/vector-stores.ts added executeVectorQuery/executeVectorUpsert with deterministic timeout/error normalization and structured Qdrant response parsing; tests/unit/vector-store-adapter.spec.ts now covers success + timeout + transport + parse + shape error branches. Evidence: node dist/cli.js test pm-kj4 --run --timeout 3600 --json passed all 4 linked tests including sandboxed coverage with 100% lines/branches/functions/statements. Sequential regression sweeps passed: node dist/cli.js test-all --status in_progress --timeout 3600 --json totals items=8 linked_tests=28 passed=10 failed=0 skipped=18; node dist/cli.js test-all --status closed --timeout 3600 --json totals items=28 linked_tests=103 passed=46 failed=0 skipped=57."
    },
    {
      "created_at": "2026-02-22T20:24:58.769Z",
      "author": "cursor-maintainer",
      "text": "Handoff note: vector adapter request-execution helper baseline is now implemented and validated; semantic/hybrid vector integration into search/reindex remains roadmap scope for this item. Releasing claim at end of this iteration."
    },
    {
      "created_at": "2026-02-22T20:30:42.271Z",
      "author": "cursor-maintainer",
      "text": "Planned changeset: docs-first update vector adapter baseline to include deterministic query-hit ordering normalization for Qdrant responses, then implement stable score/id sorting in src/core/search/vector-stores.ts and add targeted unit regressions in tests/unit/vector-store-adapter.spec.ts while keeping semantic/hybrid integration roadmap status unchanged."
    },
    {
      "created_at": "2026-02-22T20:52:40.364Z",
      "author": "cursor-maintainer",
      "text": "Planned changeset: docs-first update README.md and PRD.md to declare deterministic Qdrant query-hit ordering normalization (score desc, id asc tie-break), then implement normalization in src/core/search/vector-stores.ts with targeted tests in tests/unit/vector-store-adapter.spec.ts while keeping semantic/hybrid execution roadmap status unchanged."
    },
    {
      "created_at": "2026-02-22T20:55:28.310Z",
      "author": "cursor-maintainer",
      "text": "Implemented docs-first + code changeset: updated README.md and PRD.md to document deterministic Qdrant query-hit ordering normalization (score desc, id asc tie-break), then updated src/core/search/vector-stores.ts normalizeQdrantQueryResponse to enforce that ordering and adjusted tests/unit/vector-store-adapter.spec.ts to assert sorted output from unsorted/tied query hits."
    },
    {
      "created_at": "2026-02-22T21:11:36.887Z",
      "author": "cursor-maintainer",
      "text": "Evidence: ran node dist/cli.js test pm-kj4 --run --timeout 3600 --json (passed 4/4 linked tests: coverage + reindex/search/vector adapter suites); node dist/cli.js test-all --status in_progress --timeout 3600 --json (totals items=8 linked_tests=29 passed=11 failed=0 skipped=18); node dist/cli.js test-all --status closed --timeout 3600 --json (totals items=28 linked_tests=103 passed=46 failed=0 skipped=57). Coverage statement: sandboxed coverage run remains 100% lines/branches/functions/statements, including src/core/search/vector-stores.ts at 100%. Follow-up items created: none (work continues on existing pm-kj4 scope)."
    },
    {
      "created_at": "2026-02-22T21:11:58.599Z",
      "author": "cursor-maintainer",
      "text": "Minor follow-up cleanup: adjusted tests/unit/vector-store-adapter.spec.ts to throw directly from async fetcher stub (lint compliance) with no behavior change; rerunning mandatory pm test + pm test-all sweeps for fresh evidence."
    },
    {
      "created_at": "2026-02-22T21:25:14.332Z",
      "author": "cursor-maintainer",
      "text": "Rerun evidence after lint-cleanup change: node dist/cli.js test pm-kj4 --run --timeout 3600 --json passed 4/4 linked tests; node dist/cli.js test-all --status in_progress --timeout 3600 --json totals items=8 linked_tests=29 passed=11 failed=0 skipped=18; node dist/cli.js test-all --status closed --timeout 3600 --json totals items=28 linked_tests=103 passed=46 failed=0 skipped=57. Coverage remains 100% lines/branches/functions/statements in sandboxed coverage runs, including src/core/search/vector-stores.ts at 100%."
    },
    {
      "created_at": "2026-02-22T21:25:35.515Z",
      "author": "cursor-maintainer",
      "text": "Second lint compliance follow-up: changed async stub throw to Error object in tests/unit/vector-store-adapter.spec.ts (throw new Error(\"404\")); rerunning mandatory pm test + pm test-all sweeps for final evidence."
    },
    {
      "created_at": "2026-02-22T21:27:39.462Z",
      "author": "cursor-maintainer",
      "text": "Adjusted non-Error rejection test stub to asynchronous Promise rejection via setTimeout in tests/unit/vector-store-adapter.spec.ts to satisfy linter while preserving coverage of non-Error transport-failure normalization branch."
    },
    {
      "created_at": "2026-02-22T21:41:06.845Z",
      "author": "cursor-maintainer",
      "text": "Final verification after coverage/lint adjustments: node dist/cli.js test pm-kj4 --run --timeout 3600 --json passed 4/4 linked tests with coverage gate green; node dist/cli.js test-all --status in_progress --timeout 3600 --json totals items=8 linked_tests=29 passed=11 failed=0 skipped=18; node dist/cli.js test-all --status closed --timeout 3600 --json totals items=28 linked_tests=103 passed=46 failed=0 skipped=57. Coverage proof remains 100% lines/branches/functions/statements overall, including src/core/search/vector-stores.ts at 100%."
    },
    {
      "created_at": "2026-02-23T00:08:58.063Z",
      "author": "steve",
      "text": "Planned changeset: docs-first update README.md and PRD.md to move LanceDB local execution from roadmap-only to implemented vector-adapter baseline (deterministic local query/upsert helper behavior), then replace LanceDB not-implemented stubs in src/core/search/vector-stores.ts with deterministic local execution and add/adjust unit coverage in tests/unit/vector-store-adapter.spec.ts while keeping semantic/hybrid command-mode integration roadmap status unchanged."
    },
    {
      "created_at": "2026-02-23T00:34:31.376Z",
      "author": "steve",
      "text": "Implemented docs-first LanceDB local execution baseline. Docs: README.md + PRD.md now state vector-store abstraction includes deterministic LanceDB local query/upsert helper behavior while semantic/hybrid vector integration remains roadmap. Code: src/core/search/vector-stores.ts now executes LOCAL plans via deterministic in-memory LanceDB table state (upsert merge by id, local query scoring plus score/id ordering, empty-table handling, dimension mismatch validation) and only resolves fetch/timeout for remote plans. Tests: tests/unit/vector-store-adapter.spec.ts adds local upsert/query coverage for empty-table path, tie-score id ordering, and dimension-mismatch errors. Evidence: node dist/cli.js test pm-kj4 --run --timeout 3600 --json passed all 4 linked tests (including node scripts/run-tests.mjs coverage at 100% lines/branches/functions/statements); node dist/cli.js test-all --status in_progress --timeout 3600 --json totals items=8 linked_tests=29 passed=11 failed=0 skipped=18; node dist/cli.js test-all --status closed --timeout 3600 --json totals items=30 linked_tests=107 passed=47 failed=0 skipped=60. Follow-up items created: none."
    },
    {
      "created_at": "2026-02-23T00:34:50.241Z",
      "author": "steve",
      "text": "Handoff note: LanceDB local query/upsert helper baseline is now implemented and verified with docs/tests; remaining pm-kj4 scope is semantic/hybrid vector integration wiring in command paths."
    },
    {
      "created_at": "2026-02-23T10:51:10.676Z",
      "author": "cursor-maintainer",
      "text": "Planned changeset: docs-first advance semantic/hybrid integration baseline by implementing command-path execution wiring in reindex/search (provider embeddings + vector upsert/query with deterministic scoring output) while preserving keyword behavior; then add unit coverage updates for semantic and hybrid success paths plus validation branches."
    },
    {
      "created_at": "2026-02-23T11:04:43.500Z",
      "author": "cursor-maintainer",
      "text": "Implemented docs-first semantic/hybrid command-path wiring: README.md and PRD.md now state baseline execution behavior; src/cli/commands/reindex.ts now performs provider embedding generation + vector upsert for semantic/hybrid modes; src/cli/commands/search.ts now executes semantic vector query ranking and deterministic hybrid lexical+semantic blending; src/cli/main.ts mode help text no longer advertises keyword-only implementation; tests updated in tests/unit/search-command.spec.ts and tests/unit/reindex-command.spec.ts for semantic/hybrid success paths."
    },
    {
      "created_at": "2026-02-23T11:30:44.971Z",
      "author": "cursor-maintainer",
      "text": "author=cursor-maintainer,created_at=now,text=Follow-up fixes for semantic/hybrid search command-path coverage + wrapper parity: tests/unit/search-command.spec.ts now explicitly covers resolveSearchMaxResults fallback branches (non-integer positive floor, non-positive numeric fallback) and executes hybrid mode with includeLinked=true to cover linked-corpus gating in hybrid flows; src/commands/search.ts now re-exports resolveSearchMaxResults to keep legacy command wrapper runtime surface in sync with src/cli/commands/search.ts; tests/unit/command-wrapper-exports.spec.ts contract now passes for search wrapper exports. Evidence: node scripts/run-tests.mjs coverage => 46 files, 321 tests passed, global coverage 100/100/100/100 (statements/branches/functions/lines). Mandatory item verification: node dist/cli.js test pm-kj4 --run --timeout 3600 --json => passed 4, failed 0, skipped 0. Mandatory regression sweeps: node dist/cli.js test-all --status in_progress --timeout 3600 --json => totals items=9 linked_tests=32 passed=12 failed=0 skipped=20; node dist/cli.js test-all --status closed --timeout 3600 --json => totals items=30 linked_tests=107 passed=47 failed=0 skipped=60."
    },
    {
      "created_at": "2026-02-23T11:30:52.584Z",
      "author": "cursor-maintainer",
      "text": "Follow-up verification note (corrected entry): completed semantic/hybrid coverage + wrapper parity cleanup. Code/tests touched: src/commands/search.ts, tests/unit/search-command.spec.ts, tests/unit/command-wrapper-exports.spec.ts. Verification evidence: node scripts/run-tests.mjs coverage => 46 test files, 321 tests passed, global coverage statements/branches/functions/lines all 100%. Item run: node dist/cli.js test pm-kj4 --run --timeout 3600 --json => passed=4 failed=0 skipped=0. Regression sweeps: node dist/cli.js test-all --status in_progress --timeout 3600 --json => items=9 linked_tests=32 passed=12 failed=0 skipped=20; node dist/cli.js test-all --status closed --timeout 3600 --json => items=30 linked_tests=107 passed=47 failed=0 skipped=60."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "docs-first milestone status update"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "docs-first status/contract update"
    },
    {
      "path": "src/cli/commands/reindex.ts",
      "scope": "project",
      "note": "reindex semantic/hybrid validation wiring"
    },
    {
      "path": "src/cli/commands/search.ts",
      "scope": "project",
      "note": "semantic/hybrid validation wiring"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "semantic-hybrid help text parity"
    },
    {
      "path": "src/commands/search.ts",
      "scope": "project",
      "note": "legacy wrapper export parity"
    },
    {
      "path": "src/core/search/providers.ts",
      "scope": "project",
      "note": "existing provider abstraction reference"
    },
    {
      "path": "src/core/search/vector-stores.ts",
      "scope": "project",
      "note": "new vector adapter abstraction module"
    },
    {
      "path": "tests/unit/command-wrapper-exports.spec.ts",
      "scope": "project",
      "note": "wrapper export surface contract coverage"
    },
    {
      "path": "tests/unit/reindex-command.spec.ts",
      "scope": "project",
      "note": "vector validation diagnostics coverage"
    },
    {
      "path": "tests/unit/search-command.spec.ts",
      "scope": "project",
      "note": "vector validation diagnostics coverage"
    },
    {
      "path": "tests/unit/vector-store-adapter.spec.ts",
      "scope": "project",
      "note": "unit coverage for vector adapter helpers"
    },
    {
      "path": "vitest.config.ts",
      "scope": "project",
      "note": "enforce coverage on vector adapter module"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 2400,
      "note": "coverage gate regression"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/reindex-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 900,
      "note": "reindex semantic-hybrid diagnostics"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/search-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 900,
      "note": "search semantic-hybrid diagnostics"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/vector-store-adapter.spec.ts",
      "scope": "project",
      "timeout_seconds": 900,
      "note": "vector adapter unit coverage"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "dogfood workflow contract"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "governing spec"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "user-facing command contract"
    }
  ]
}

Add pluggable vector store adapters for supported stores.
