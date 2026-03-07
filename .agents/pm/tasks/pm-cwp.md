{
  "id": "pm-cwp",
  "title": "M4: Hybrid ranking and include-linked option",
  "description": "Implement phased search ranking improvements starting with keyword include-linked support.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:search-ranking",
    "core",
    "milestone:4",
    "pm-cli"
  ],
  "created_at": "2026-02-17T23:02:10.662Z",
  "updated_at": "2026-03-04T13:04:33.498Z",
  "deadline": "2026-03-07T23:02:10.662Z",
  "author": "steve",
  "estimated_minutes": 120,
  "acceptance_criteria": "Hybrid ranking baseline includes deterministic lexical+semantic blending with --include-linked lexical enrichment in keyword and hybrid modes, plus settings-backed hybrid semantic weighting, docs/help parity, and 100% coverage-gate compliance.",
  "dependencies": [
    {
      "id": "pm-54d",
      "kind": "blocks",
      "created_at": "2026-02-17T23:02:10.662Z",
      "author": "steve"
    },
    {
      "id": "pm-f45",
      "kind": "parent",
      "created_at": "2026-02-17T23:02:10.662Z",
      "author": "steve"
    }
  ],
  "comments": [
    {
      "created_at": "2026-02-20T18:55:32.272Z",
      "author": "codex-maintainer",
      "text": "Implement keyword-mode --include-linked support with deterministic linked-content scoring and unit coverage updates before full regression run."
    },
    {
      "created_at": "2026-02-20T18:59:27.307Z",
      "author": "codex-maintainer",
      "text": "Updated PRD/README first to codify keyword --include-linked baseline, then implemented include-linked corpus scoring in search command and added unit tests for project/global linked content resolution and missing-path tolerance."
    },
    {
      "created_at": "2026-02-20T19:35:58.329Z",
      "author": "codex-maintainer",
      "text": "Evidence: (1) node dist/cli.js test pm-cwp --run --timeout 1200 --json -> passed after branch-coverage fix; coverage gate reports 100 lines/branches/functions/statements. (2) node dist/cli.js test-all --status in_progress --timeout 1200 --json -> totals items=9, linked_tests=50, passed=49, failed=0, skipped=1. (3) node dist/cli.js test-all --status closed --timeout 1200 --json -> totals items=19, linked_tests=53, passed=50, failed=0, skipped=3."
    },
    {
      "created_at": "2026-02-20T19:36:33.233Z",
      "author": "codex-maintainer",
      "text": "Remaining scope for pm-cwp: implement hybrid score blending once semantic provider/vector adapters land; include-linked keyword baseline is now implemented and verified."
    },
    {
      "created_at": "2026-03-03T20:42:04.134Z",
      "author": "steve",
      "text": "Planned changeset: docs-first align include-linked semantics so PRD/help match implemented behavior (keyword + hybrid lexical scoring), then update search help text and add regression contract coverage."
    },
    {
      "created_at": "2026-03-03T20:51:42.727Z",
      "author": "steve",
      "text": "Implemented docs/help parity hardening for include-linked semantics: PRD.md now states include-linked contributes to keyword and hybrid lexical scoring, src/cli/main.ts search --help text now matches runtime behavior, and tests/integration/help-readme-contract.spec.ts adds a regression contract for the include-linked help line (whitespace-normalized for wrapped help output). Evidence: node dist/cli.js test pm-cwp --run --timeout 3600 --json passed 3/3 linked tests (coverage + integration + unit). Regression sweeps: node dist/cli.js test-all --status in_progress --timeout 3600 --json totals items=8 linked_tests=31 passed=13 failed=0 skipped=18; node dist/cli.js test-all --status closed --timeout 3600 --json totals items=33 linked_tests=115 passed=48 failed=0 skipped=67. Coverage statement: coverage output remains 100% statements/branches/functions/lines in the linked coverage runs."
    },
    {
      "created_at": "2026-03-03T22:18:37.234Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: docs-first add configurable hybrid semantic-weight baseline for search blending, then implement settings-backed weighting in search ranking and add targeted unit coverage for defaults/validation while preserving deterministic ordering and 100% coverage gate."
    },
    {
      "created_at": "2026-03-03T22:23:26.822Z",
      "author": "maintainer-agent",
      "text": "Follow-up fix: linked coverage run failed in tests/unit/command-wrapper-exports.spec.ts because src/commands/search.ts did not re-export newly added resolveHybridSemanticWeight; applying wrapper export parity fix and rerunning mandatory pm test + test-all sweeps."
    },
    {
      "created_at": "2026-03-03T22:23:37.842Z",
      "author": "maintainer-agent",
      "text": "Implemented follow-up wrapper parity fix: src/commands/search.ts now re-exports resolveHybridSemanticWeight so legacy command wrappers match canonical CLI module export surface required by coverage contracts."
    },
    {
      "created_at": "2026-03-03T22:33:17.226Z",
      "author": "maintainer-agent",
      "text": "Implemented docs-first hybrid weighting increment and verification. Changes: PRD/README now document settings.search.hybrid_semantic_weight (0..1, default 0.7); search runtime now resolves settings-backed hybrid semantic weight and applies it to normalized hybrid blending; settings defaults/schema/serialization/type contracts include hybrid_semantic_weight; unit tests updated for resolver fallback/weight effect/settings ordering/default contracts; legacy src/commands/search.ts wrapper now re-exports resolveHybridSemanticWeight for command-wrapper parity. Commands run: pnpm build (pass); node dist/cli.js test pm-cwp --run --timeout 7200 --json initially failed due wrapper export parity in tests/unit/command-wrapper-exports.spec.ts, then passed after fix; node dist/cli.js test-all --status in_progress --timeout 7200 --json passed totals items=7 linked_tests=30 passed=14 failed=0 skipped=16; node dist/cli.js test-all --status closed --timeout 7200 --json passed totals items=34 linked_tests=119 passed=49 failed=0 skipped=70. Coverage statement: linked coverage runs remained 100% lines/branches/functions/statements (All files 100/100/100/100). Follow-up items created: none."
    },
    {
      "created_at": "2026-03-04T12:50:20.807Z",
      "author": "cursor-maintainer",
      "text": "Planned changeset: run full docs/implementation parity verification for include-linked + hybrid weighting baseline, execute mandatory pm test and regression sweeps, then close if acceptance criteria and 100% coverage evidence are satisfied."
    },
    {
      "created_at": "2026-03-04T13:04:33.097Z",
      "author": "cursor-maintainer",
      "text": "Evidence: (1) node dist/cli.js test pm-cwp --run --timeout 7200 --json passed with run_results passed=5 failed=0 skipped=0. (2) node dist/cli.js test-all --status in_progress --timeout 7200 --json passed totals items=4 linked_tests=17 passed=11 failed=0 skipped=6. (3) node dist/cli.js test-all --status closed --timeout 7200 --json passed totals items=41 linked_tests=146 passed=54 failed=0 skipped=92. Coverage statement: sandboxed coverage outputs in these runs remained 100% lines/branches/functions/statements (All files 100/100/100/100). Follow-up items created: none."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "milestone status update"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "command docs update"
    },
    {
      "path": "src/cli/commands/search.ts",
      "scope": "project",
      "note": "include-linked search scoring"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "search option wiring"
    },
    {
      "path": "src/commands/search.ts",
      "scope": "project",
      "note": "legacy command wrapper export parity for new search resolver"
    },
    {
      "path": "src/core/shared/constants.ts",
      "scope": "project",
      "note": "add hybrid search weight default"
    },
    {
      "path": "src/core/store/settings.ts",
      "scope": "project",
      "note": "settings schema and ordering for hybrid weight"
    },
    {
      "path": "src/types.ts",
      "scope": "project",
      "note": "typed settings contract for hybrid weight"
    },
    {
      "path": "tests/integration/help-readme-contract.spec.ts",
      "scope": "project",
      "note": "contract test for include-linked help text"
    },
    {
      "path": "tests/unit/search-command.spec.ts",
      "scope": "project",
      "note": "search command unit coverage"
    },
    {
      "path": "tests/unit/settings-store.spec.ts",
      "scope": "project",
      "note": "settings serialization and merge coverage"
    },
    {
      "path": "tests/unit/shared-constants-errors.spec.ts",
      "scope": "project",
      "note": "default settings contract coverage"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "coverage gate regression"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/integration/help-readme-contract.spec.ts",
      "scope": "project",
      "timeout_seconds": 900,
      "note": "search include-linked help contract"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/search-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 240,
      "note": "targeted include-linked tests"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/settings-store.spec.ts",
      "scope": "project",
      "timeout_seconds": 900,
      "note": "settings hybrid-weight regression"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/shared-constants-errors.spec.ts",
      "scope": "project",
      "timeout_seconds": 900,
      "note": "shared defaults hybrid-weight regression"
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
      "note": "user contract"
    }
  ]
}

Implement hybrid ranking and optional linked document inclusion.
