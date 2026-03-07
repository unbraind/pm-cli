{
  "id": "pm-yv2",
  "title": "M4: Embedding provider abstraction",
  "description": "Implement provider interface and request orchestration for embeddings.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:search-semantic",
    "core",
    "milestone:4",
    "pm-cli"
  ],
  "created_at": "2026-02-17T23:02:10.253Z",
  "updated_at": "2026-03-03T21:05:55.154Z",
  "deadline": "2026-03-07T23:02:10.253Z",
  "author": "steve",
  "estimated_minutes": 120,
  "acceptance_criteria": "Embedding providers can be swapped with deterministic configuration, request-target and payload/response normalization, execution-time cardinality validation, dynamic keyword/hybrid default mode selection, and mode-aware search.score_threshold filtering across keyword/semantic/hybrid scoring.",
  "dependencies": [
    {
      "id": "pm-54d",
      "kind": "blocks",
      "created_at": "2026-02-17T23:02:10.253Z",
      "author": "steve"
    },
    {
      "id": "pm-f45",
      "kind": "parent",
      "created_at": "2026-02-17T23:02:10.253Z",
      "author": "steve"
    }
  ],
  "comments": [
    {
      "created_at": "2026-02-20T22:40:16.459Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: docs-first milestone update plus core embedding provider abstraction (deterministic provider resolution from settings/env), then wire semantic-mode gating in search/reindex and add unit regressions while preserving keyword-mode behavior."
    },
    {
      "created_at": "2026-02-20T22:42:48.928Z",
      "author": "maintainer-agent",
      "text": "Docs-first update completed: PRD.md now marks embedding provider abstraction as partial ([~]) with deterministic provider-resolution baseline, and README.md reflects semantic/hybrid provider-validation baseline while semantic/vector execution remains roadmap."
    },
    {
      "created_at": "2026-02-20T23:20:06.341Z",
      "author": "maintainer-agent",
      "text": "Implemented changeset: added src/core/search/providers.ts deterministic embedding-provider resolution (OpenAI/Ollama) and wired semantic/hybrid gating in src/cli/commands/search.ts + src/cli/commands/reindex.ts to validate provider configuration before returning roadmap-not-implemented usage errors; added/updated tests in tests/unit/embedding-provider.spec.ts, tests/unit/search-command.spec.ts, and tests/unit/reindex-command.spec.ts; updated docs-first status in PRD.md + README.md and coverage include in vitest.config.ts. Evidence: node dist/cli.js test pm-yv2 --run --timeout 2400 --json passed all 4 linked tests; node dist/cli.js test-all --status in_progress --timeout 2400 --json passed totals items=10 linked_tests=55 passed=34 failed=0 skipped=21; node dist/cli.js test-all --status closed --timeout 2400 --json passed totals items=20 linked_tests=54 passed=19 failed=0 skipped=35. Coverage statement: linked node scripts/run-tests.mjs coverage run remains 100% lines/branches/functions/statements, including src/core/search/providers.ts at 100%."
    },
    {
      "created_at": "2026-02-20T23:20:24.193Z",
      "author": "maintainer-agent",
      "text": "Handoff note: provider configuration abstraction + semantic/hybrid mode validation baseline is complete; remaining scope for this item is embedding request orchestration and integration into semantic/hybrid search/reindex execution paths."
    },
    {
      "created_at": "2026-02-21T00:50:06.684Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: docs-first update for embedding request-shaping baseline, then implement provider request payload/response normalization helpers and wire deterministic semantic/hybrid gating messages to include provider request target details with unit coverage."
    },
    {
      "created_at": "2026-02-21T01:22:43.033Z",
      "author": "maintainer-agent",
      "text": "Implemented docs-first provider abstraction increment: PRD.md and README.md now record provider-specific request payload/response normalization as part of the semantic/hybrid validation baseline. Code changes: src/core/search/providers.ts adds resolveEmbeddingRequestTarget/buildEmbeddingRequestPlan/normalizeEmbeddingResponse helpers; src/cli/commands/search.ts and src/cli/commands/reindex.ts now include resolved endpoint/model details in roadmap-not-implemented semantic/hybrid errors; tests updated in tests/unit/embedding-provider.spec.ts, tests/unit/search-command.spec.ts, and tests/unit/reindex-command.spec.ts. Evidence: node dist/cli.js test pm-yv2 --run --timeout 2400 --json passed all linked tests including node scripts/run-tests.mjs coverage with 100% lines/branches/functions/statements; node dist/cli.js test-all --status in_progress --timeout 2400 --json passed totals items=10 linked_tests=55 passed=34 failed=0 skipped=21; node dist/cli.js test-all --status closed --timeout 2400 --json passed totals items=20 linked_tests=54 passed=19 failed=0 skipped=35."
    },
    {
      "created_at": "2026-02-22T03:20:24.401Z",
      "author": "cursor-maintainer",
      "text": "Planned changeset: docs-first update provider abstraction baseline to include deterministic request execution helper, then implement execution helper in src/core/search/providers.ts with unit coverage while semantic/vector command execution remains roadmap."
    },
    {
      "created_at": "2026-02-22T03:23:13.977Z",
      "author": "cursor-maintainer",
      "text": "Docs-first update complete: README.md and PRD.md now document provider abstraction baseline as including deterministic request-execution helper behavior in addition to config/target/payload/response normalization, while networked semantic/vector execution remains roadmap."
    },
    {
      "created_at": "2026-02-22T03:38:01.465Z",
      "author": "cursor-maintainer",
      "text": "Regression fix plan: raise the README quickstart integration test timeout to avoid transient 30s timeout failures under heavy coverage/test-all load observed in this run's pm test-all --status in_progress sweep."
    },
    {
      "created_at": "2026-02-22T03:55:01.055Z",
      "author": "cursor-maintainer",
      "text": "Implemented provider-orchestration increment: added deterministic executeEmbeddingRequest helper in src/core/search/providers.ts (timeout handling, fetch fallback/injection, request-plan execution, normalized non-OK/abort errors) with expanded unit coverage in tests/unit/embedding-provider.spec.ts. Regression stabilization during mandatory sweep: tests/integration/help-readme-contract.spec.ts quickstart test now uses 90s timeout to avoid transient 30s timeout under full coverage load. Evidence: pm test pm-yv2 --run --timeout 3600 --json passed 4/4 linked checks; pm test-all --status in_progress --timeout 3600 --json passed totals items=10 linked_tests=35 passed=15 failed=0 skipped=20; pm test-all --status closed --timeout 3600 --json passed totals items=22 linked_tests=86 passed=42 failed=0 skipped=44. Coverage remained 100% lines/branches/functions/statements in coverage runs."
    },
    {
      "created_at": "2026-02-22T03:55:17.718Z",
      "author": "cursor-maintainer",
      "text": "Handoff note: this iteration adds deterministic request-execution helper coverage and stabilizes README quickstart timeout for regression reliability; semantic/hybrid network execution and vector-query integration remain pending roadmap scope for pm-yv2."
    },
    {
      "created_at": "2026-02-22T11:35:14.489Z",
      "author": "cursor-maintainer",
      "text": "Planned changeset: harden executeEmbeddingRequest deterministic error handling by normalizing response body read failures, response JSON parse failures, and thrown fetch errors; add unit regressions in tests/unit/embedding-provider.spec.ts while keeping semantic/vector command execution roadmap behavior unchanged."
    },
    {
      "created_at": "2026-02-22T12:03:42.481Z",
      "author": "cursor-maintainer",
      "text": "Implemented executeEmbeddingRequest hardening: src/core/search/providers.ts now normalizes transport failures, response-body read failures, and response JSON parse failures into deterministic error strings; tests/unit/embedding-provider.spec.ts adds regressions for non-OK body-read failure, empty-message Error name fallback, non-Error rejection handling, and JSON parse failure behavior. Verification: node scripts/run-tests.mjs test -- tests/unit/embedding-provider.spec.ts passed 17/17; node dist/cli.js test pm-yv2 --run --timeout 3600 --json passed 4/4 linked tests; node dist/cli.js test-all --status in_progress --timeout 3600 --json totals items=10 linked_tests=35 passed=15 failed=0 skipped=20; node dist/cli.js test-all --status closed --timeout 3600 --json totals items=22 linked_tests=86 passed=42 failed=0 skipped=44. Coverage statement: 100% lines/branches/functions/statements in coverage runs."
    },
    {
      "created_at": "2026-02-22T18:41:43.354Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: docs-first update for OpenAI request-target normalization so provider base_url can be root, /v1, or /embeddings without ambiguous endpoint construction; then implement target resolver adjustments in src/core/search/providers.ts with targeted unit regressions while preserving existing semantic/hybrid roadmap gating behavior."
    },
    {
      "created_at": "2026-02-22T18:42:50.297Z",
      "author": "maintainer-agent",
      "text": "Docs-first update complete: README.md and PRD.md now specify OpenAI-compatible request-target normalization behavior for provider base_url root, /v1, and explicit /embeddings forms, while semantic/vector execution remains roadmap."
    },
    {
      "created_at": "2026-02-22T18:43:18.936Z",
      "author": "maintainer-agent",
      "text": "Implemented resolver increment: src/core/search/providers.ts now normalizes OpenAI request targets so base_url values that are root, /v1, or explicit /embeddings produce deterministic embeddings endpoints; updated tests/unit/embedding-provider.spec.ts with regression coverage for these URL forms."
    },
    {
      "created_at": "2026-02-22T18:54:38.655Z",
      "author": "maintainer-agent",
      "text": "Evidence: ran node dist/cli.js test pm-yv2 --run --timeout 3600 --json (passed 4/4 linked tests); node dist/cli.js test-all --status in_progress --timeout 3600 --json (totals items=8 linked_tests=28 passed=10 failed=0 skipped=18); node dist/cli.js test-all --status closed --timeout 3600 --json (totals items=27 linked_tests=101 passed=46 failed=0 skipped=55). Coverage proof remains 100% lines/branches/functions/statements in sandboxed coverage runs (All files 100/100/100/100). Follow-up items created: none."
    },
    {
      "created_at": "2026-02-22T20:30:34.632Z",
      "author": "cursor-maintainer",
      "text": "Planned changeset: docs-first update provider abstraction contract to include deterministic embedding cardinality validation (response vector count must match normalized input count), then implement execution-time checks in src/core/search/providers.ts with targeted unit regressions in tests/unit/embedding-provider.spec.ts while preserving semantic/hybrid roadmap gating."
    },
    {
      "created_at": "2026-02-22T21:49:57.586Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: docs-first update README.md and PRD.md to state deterministic embedding cardinality validation (normalized input count must equal returned vector count), then implement execution-time checks in src/core/search/providers.ts with unit regressions in tests/unit/embedding-provider.spec.ts while keeping semantic/hybrid execution roadmap status unchanged."
    },
    {
      "created_at": "2026-02-22T21:51:46.111Z",
      "author": "maintainer-agent",
      "text": "Docs-first update complete: README.md and PRD.md now explicitly include deterministic embedding cardinality validation in provider abstraction baseline (normalized input count must match returned vector count) while semantic/hybrid execution remains roadmap."
    },
    {
      "created_at": "2026-02-22T22:09:17.259Z",
      "author": "maintainer-agent",
      "text": "Implemented docs-first cardinality validation change-set. Docs: README.md and PRD.md now state provider abstraction includes deterministic embedding cardinality validation where normalized input count must match returned vector count. Code: src/core/search/providers.ts executeEmbeddingRequest now validates vectors.length against normalized input count and throws deterministic mismatch errors. Tests: tests/unit/embedding-provider.spec.ts now covers matching multi-input cardinality and mismatch failure branch (18/18 passing). Verification evidence: (1) node dist/cli.js test pm-yv2 --run --timeout 3600 --json => passed 4/4 linked tests; coverage command in run reports 100% lines/branches/functions/statements, including src/core/search/providers.ts 100/100/100/100. (2) node dist/cli.js test-all --status in_progress --timeout 3600 --json => totals items=8 linked_tests=29 passed=11 failed=0 skipped=18. (3) node dist/cli.js test-all --status closed --timeout 3600 --json => totals items=28 linked_tests=103 passed=46 failed=0 skipped=57. Follow-up items created: none."
    },
    {
      "created_at": "2026-02-22T22:09:51.998Z",
      "author": "maintainer-agent",
      "text": "Handoff note: embedding cardinality validation baseline is now implemented and verified with docs + tests; remaining pm-yv2 scope is still roadmap-level networked semantic/hybrid execution and vector integration."
    },
    {
      "created_at": "2026-02-22T22:43:29.154Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: docs-first update to PRD.md and README.md for deterministic OpenAI response-order normalization (index-ordered embedding entries), then implement index-aware normalization in src/core/search/providers.ts with targeted regressions in tests/unit/embedding-provider.spec.ts while preserving existing semantic/hybrid roadmap gating behavior."
    },
    {
      "created_at": "2026-02-22T23:32:28.880Z",
      "author": "maintainer-agent",
      "text": "Implemented docs-first OpenAI response-order normalization increment for provider abstraction.\n\nDocs updates:\n- PRD.md now states provider response normalization includes deterministic OpenAI data-entry index ordering.\n- README.md mirrors that contract in the planned-search/provider abstraction baseline.\n\nCode + tests:\n- src/core/search/providers.ts now normalizes OpenAI embedding entries with deterministic index ordering when index fields are present, and preserves original response position as deterministic tie-break for duplicate indexes.\n- src/core/search/providers.ts validates explicit index fields using TypeError and extracts ordering logic into a helper for lint compliance.\n- tests/unit/embedding-provider.spec.ts adds regressions for index-ordered normalization, duplicate-index tie-break behavior, and malformed mixed index payload rejection.\n\nVerification evidence:\n1) node dist/cli.js test pm-yv2 --run --timeout 3600 --json\n   - final rerun passed all 4 linked tests.\n   - node scripts/run-tests.mjs coverage passed with 100% lines/branches/functions/statements (including src/core/search/providers.ts at 100%).\n2) node dist/cli.js test-all --status in_progress --timeout 3600 --json\n   - totals: items=8, linked_tests=29, passed=11, failed=0, skipped=18.\n3) node dist/cli.js test-all --status closed --timeout 3600 --json\n   - totals: items=29, linked_tests=104, passed=46, failed=0, skipped=58.\n\nNote: an earlier pm test coverage run in this iteration had transient unrelated timeout failures under heavy load; immediate rerun succeeded and the final recorded evidence above is green."
    },
    {
      "created_at": "2026-02-23T11:43:19.085Z",
      "author": "codex-maintainer",
      "text": "Planned changeset: align PRD search-default contract by making mode selection dynamic (hybrid when semantic provider+vector store are configured, keyword otherwise), update CLI option text accordingly, and add deterministic unit regressions for default-mode selection while preserving explicit --mode behavior."
    },
    {
      "created_at": "2026-02-23T11:57:19.617Z",
      "author": "codex-maintainer",
      "text": "Implemented PRD parity for search default mode: src/cli/commands/search.ts now auto-selects mode=hybrid when both embedding provider and vector store are configured, otherwise defaults to keyword; explicit --mode keyword|semantic|hybrid remains unchanged. Updated src/cli/main.ts search help text to describe dynamic default and added regression coverage in tests/unit/search-command.spec.ts for implicit default (keyword without semantic config, hybrid with semantic config) plus explicit keyword behavior. Verification commands: node scripts/run-tests.mjs test -- tests/unit/search-command.spec.ts => passed 9/9; node dist/cli.js test pm-yv2 --run --timeout 3600 --json => passed 4/4 linked tests; node dist/cli.js test-all --status in_progress --timeout 3600 --json => totals items=8 linked_tests=28 passed=11 failed=0 skipped=17; node dist/cli.js test-all --status closed --timeout 3600 --json => totals items=31 linked_tests=111 passed=48 failed=0 skipped=63. Coverage statement: sandboxed coverage runs in pm test/pm test-all remained 100% lines/branches/functions/statements. Follow-up items created: none."
    },
    {
      "created_at": "2026-03-03T14:11:30.719Z",
      "author": "cursor-maintainer",
      "text": "Planned changeset: docs-first define deterministic search score_threshold behavior (keyword/semantic/hybrid), then implement threshold filtering in runSearch and add unit regressions in tests/unit/search-command.spec.ts while preserving default-mode and provider/vector gating semantics."
    },
    {
      "created_at": "2026-03-03T14:25:21.086Z",
      "author": "cursor-maintainer",
      "text": "Implemented docs-first score-threshold increment: updated PRD.md and README.md to define deterministic settings.search.score_threshold semantics, implemented mode-aware score_threshold filtering in src/cli/commands/search.ts (keyword raw lexical score, semantic vector score, hybrid normalized blended score), surfaced score_threshold in search filters output, added unit regressions in tests/unit/search-command.spec.ts, and fixed wrapper parity by exporting resolveSearchScoreThreshold from src/commands/search.ts."
    },
    {
      "created_at": "2026-03-03T14:25:21.256Z",
      "author": "cursor-maintainer",
      "text": "Evidence: 1) node dist/cli.js test pm-yv2 --run --timeout 3600 --json passed all 4 linked tests (coverage, embedding-provider, reindex-command, search-command). Coverage report shows All files 100% statements/branches/functions/lines. 2) node dist/cli.js test-all --status in_progress --timeout 3600 --json passed with totals items=8 linked_tests=30 passed=13 failed=0 skipped=17. 3) node dist/cli.js test-all --status closed --timeout 3600 --json passed with totals items=32 linked_tests=113 passed=48 failed=0 skipped=65. Note: an initial run failed due wrapper export parity; fixed by exporting resolveSearchScoreThreshold in src/commands/search.ts, then reran full mandatory sequence green."
    },
    {
      "created_at": "2026-03-03T20:56:59.937Z",
      "author": "maintainer-agent",
      "text": "Planned closure validation: re-run linked pm tests and full in_progress/closed regression sweeps to confirm acceptance criteria and 100% coverage gate remain green before closing this item."
    },
    {
      "created_at": "2026-03-03T21:05:45.128Z",
      "author": "maintainer-agent",
      "text": "Evidence (closure validation): 1) node dist/cli.js test pm-yv2 --run --timeout 3600 --json => linked tests=4, passed=4, failed=0, skipped=0. 2) node dist/cli.js test-all --status in_progress --timeout 3600 --json => items=8, linked_tests=31, passed=13, failed=0, skipped=18. 3) node dist/cli.js test-all --status closed --timeout 3600 --json => items=33, linked_tests=115, passed=48, failed=0, skipped=67. Coverage proof from linked coverage runs remains 100% lines/branches/functions/statements (All files 100/100/100/100). Acceptance criteria satisfied; no follow-up item required for this baseline scope."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "docs-first provider abstraction milestone status update"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "docs-first search roadmap status update"
    },
    {
      "path": "src/cli/commands/reindex.ts",
      "scope": "project",
      "note": "hook semantic provider resolution"
    },
    {
      "path": "src/cli/commands/search.ts",
      "scope": "project",
      "note": "hook semantic provider resolution"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "search option default/help wording"
    },
    {
      "path": "src/commands/search.ts",
      "scope": "project",
      "note": "legacy wrapper export parity for search helper"
    },
    {
      "path": "src/core/search/providers.ts",
      "scope": "project",
      "note": "provider abstraction and resolver"
    },
    {
      "path": "src/types.ts",
      "scope": "project",
      "note": "provider interface types"
    },
    {
      "path": "tests/integration/help-readme-contract.spec.ts",
      "scope": "project",
      "note": "stabilize quickstart contract runtime under coverage load"
    },
    {
      "path": "tests/unit/embedding-provider.spec.ts",
      "scope": "project",
      "note": "unit tests for provider resolver"
    },
    {
      "path": "tests/unit/reindex-command.spec.ts",
      "scope": "project",
      "note": "reindex provider gating tests"
    },
    {
      "path": "tests/unit/search-command.spec.ts",
      "scope": "project",
      "note": "semantic provider gating tests"
    },
    {
      "path": "vitest.config.ts",
      "scope": "project",
      "note": "include provider abstraction module in enforced coverage set"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 2400,
      "note": "coverage gate remains 100 percent"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/embedding-provider.spec.ts",
      "scope": "project",
      "timeout_seconds": 900,
      "note": "provider abstraction unit tests"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/reindex-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 900,
      "note": "reindex mode provider gating"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/search-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 900,
      "note": "search mode provider gating"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "agent workflow contract"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "governing spec"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "user-facing search contract"
    }
  ]
}

Create abstraction layer for semantic embedding providers.
