{
  "id": "pm-p8p",
  "title": "M5: Hook lifecycle",
  "description": "Implement extension hook registration APIs with deterministic ordering, command lifecycle execution for before/after hooks, and failure containment for load/activation and hook runtime errors.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:extensions-hooks",
    "core",
    "milestone:5",
    "pm-cli"
  ],
  "created_at": "2026-02-17T23:02:11.494Z",
  "updated_at": "2026-03-04T12:45:59.569Z",
  "deadline": "2026-03-13T23:02:11.494Z",
  "author": "steve",
  "estimated_minutes": 150,
  "acceptance_criteria": "Extensions can register before/after/read/write/index hooks deterministically; before/after command hooks execute in deterministic order without breaking core commands when hooks fail; coverage and regression sweeps remain green at 100%.",
  "dependencies": [
    {
      "id": "pm-b1w",
      "kind": "parent",
      "created_at": "2026-02-17T23:02:11.494Z",
      "author": "steve"
    },
    {
      "id": "pm-f45",
      "kind": "blocks",
      "created_at": "2026-02-17T23:02:11.494Z",
      "author": "steve"
    }
  ],
  "comments": [
    {
      "created_at": "2026-02-19T12:31:50.527Z",
      "author": "cursor-maintainer",
      "text": "Plan: docs-first update for hook lifecycle baseline, then implement extension activation API with before/after/read/write/index hook registration; wire deterministic before/after command hook execution in CLI pre/post action path with failure containment and branch-complete unit coverage."
    },
    {
      "created_at": "2026-02-19T12:37:21.076Z",
      "author": "cursor-maintainer",
      "text": "Implemented docs-first hook lifecycle baseline: updated PRD/README contract, added extension activation and hook registry/runtime execution helpers in core loader, wired CLI preAction/postAction to run before/after command hooks with failure containment, and added unit + integration tests for deterministic registration order and hook-failure isolation."
    },
    {
      "created_at": "2026-02-19T13:14:20.780Z",
      "author": "cursor-maintainer",
      "text": "Evidence: docs-first hook lifecycle baseline validated. Commands run: node scripts/run-tests.mjs coverage (pass, 100% statements/branches/functions/lines), pm test pm-p8p --run --timeout 1800 --json (pass, 3/3 linked tests), pm test-all --status in_progress --timeout 1800 --json (pass totals: items=4 linked_tests=20 passed=19 failed=0 skipped=1), pm test-all --status closed --timeout 1800 --json (pass totals: items=16 linked_tests=44 passed=41 failed=0 skipped=3). Integration confirms before/after command hooks execute with failure containment and deterministic warning emission under --profile."
    },
    {
      "created_at": "2026-02-19T14:18:29.175Z",
      "author": "cursor-maintainer",
      "text": "Planned changeset: docs-first update for extension hook call-site status, then wire active onRead/onWrite hooks in core item store and onIndex hooks in reindex execution with deterministic failure containment and targeted regression tests."
    },
    {
      "created_at": "2026-02-19T14:52:02.955Z",
      "author": "cursor-maintainer",
      "text": "Implemented docs-first hook call-site expansion: README.md + PRD.md now document baseline onRead/onWrite/onIndex dispatch for core item-store and reindex flows; code wires active hook registry in src/core/extensions/index.ts + src/cli/main.ts, dispatches read/write hooks from src/core/store/item-store.ts, and dispatches read/write/index hooks plus warning propagation in src/cli/commands/reindex.ts; tests added/updated in tests/unit/reindex-command.spec.ts and tests/integration/cli.integration.spec.ts. Evidence: node dist/cli.js test pm-p8p --run --timeout 2400 --json passed all 4 linked tests; node dist/cli.js test-all --status in_progress --timeout 2400 --json totals items=4 linked_tests=22 passed=21 failed=0 skipped=1; node dist/cli.js test-all --status closed --timeout 2400 --json totals items=16 linked_tests=44 passed=41 failed=0 skipped=3. Coverage proof from linked node scripts/run-tests.mjs coverage remains 100% lines/branches/functions/statements. Follow-up items created: none."
    },
    {
      "created_at": "2026-02-19T16:11:15.044Z",
      "author": "cursor-maintainer",
      "text": "Planned changeset: docs-first note and implementation for afterCommand failure-path execution so hooks receive ok=false with error text when command actions fail; add integration regression coverage."
    },
    {
      "created_at": "2026-02-19T16:27:57.971Z",
      "author": "cursor-maintainer",
      "text": "Implemented docs-first + code change-set: README clarifies that afterCommand hooks run on failed commands with ok=false/error context; src/cli/main.ts now executes afterCommand hooks in both postAction success and catch failure paths via shared runtime cleanup; tests/integration/cli.integration.spec.ts adds regression coverage for failed get command dispatch. Follow-up fix: corrected profileEnabled assignment ordering/type in preAction after first compile failure. Evidence: node dist/cli.js test pm-p8p --run --timeout 2400 --json passed 4/4 linked tests; node dist/cli.js test-all --status in_progress --timeout 2400 --json totals items=4 linked_tests=22 passed=21 failed=0 skipped=1; node dist/cli.js test-all --status closed --timeout 2400 --json totals items=16 linked_tests=44 passed=41 failed=0 skipped=3; coverage remains 100% lines/branches/functions/statements via linked node scripts/run-tests.mjs coverage runs."
    },
    {
      "created_at": "2026-02-22T02:12:06.397Z",
      "author": "maintainer-agent",
      "text": "Planned change-set: extend hook lifecycle call-site coverage by dispatching active onRead hooks during search item and linked-content reads, with deterministic failure containment and targeted unit regression coverage."
    },
    {
      "created_at": "2026-02-22T02:26:35.772Z",
      "author": "maintainer-agent",
      "text": "Implemented hook call-site expansion in search: src/cli/commands/search.ts now dispatches active onRead hooks for item document reads and linked-content reads (project/global scope) with existing best-effort read containment. Added unit regression in tests/unit/search-command.spec.ts to assert onRead hook dispatch for item + linked project/global paths via mocked hook runtime. Evidence: node dist/cli.js test pm-p8p --run --timeout 3000 --json passed 5/5 linked tests (including node scripts/run-tests.mjs coverage at 100% lines/branches/functions/statements and targeted search unit suite). Regression sweeps: node dist/cli.js test-all --status in_progress --timeout 3000 --json => items=11 linked_tests=64 passed=37 failed=0 skipped=27; node dist/cli.js test-all --status closed --timeout 3000 --json => items=21 linked_tests=57 passed=20 failed=0 skipped=37. Follow-up items created: none."
    },
    {
      "created_at": "2026-02-22T02:39:38.936Z",
      "author": "maintainer-agent",
      "text": "Docs alignment update: README.md and PRD.md now explicitly note runtime read/write/index hook dispatch coverage includes search item/linked reads in addition to item-store and reindex flows. Post-doc-change verification rerun completed: node dist/cli.js test pm-p8p --run --timeout 3000 --json passed 5/5 linked tests with coverage still 100% lines/branches/functions/statements; node dist/cli.js test-all --status in_progress --timeout 3000 --json => items=11 linked_tests=64 passed=37 failed=0 skipped=27; node dist/cli.js test-all --status closed --timeout 3000 --json => items=21 linked_tests=57 passed=20 failed=0 skipped=37."
    },
    {
      "created_at": "2026-02-22T12:40:06.555Z",
      "author": "cursor-maintainer",
      "text": "Planned change-set: docs-first expand hook lifecycle read call-site coverage to include history/activity command reads, then wire onRead hook dispatch in those command paths and extend integration assertions for deterministic regression coverage."
    },
    {
      "created_at": "2026-02-22T12:42:10.374Z",
      "author": "cursor-maintainer",
      "text": "Implemented docs-first + code change-set: README.md and PRD.md now include history/activity history-stream reads in hook lifecycle baseline; src/cli/commands/history.ts now dispatches active onRead hooks when reading existing history stream files; tests/integration/cli.integration.spec.ts now exercises history and activity commands in the hook call-site integration flow and asserts read-hook events for item history JSONL streams."
    },
    {
      "created_at": "2026-02-22T12:56:22.353Z",
      "author": "cursor-maintainer",
      "text": "Evidence: node dist/cli.js test pm-p8p --run --timeout 3600 --json passed 5/5 linked tests (coverage + integration + unit suites). Regression sweeps passed: node dist/cli.js test-all --status in_progress --timeout 3600 --json => items=10 linked_tests=35 passed=15 failed=0 skipped=20; node dist/cli.js test-all --status closed --timeout 3600 --json => items=22 linked_tests=86 passed=42 failed=0 skipped=44. Coverage statement: coverage runs in these sweeps remained 100% lines/branches/functions/statements. Follow-up items created: none."
    },
    {
      "created_at": "2026-02-22T20:30:51.120Z",
      "author": "cursor-maintainer",
      "text": "Planned changeset: docs-first expand hook lifecycle baseline to include settings read/write call sites, then wire onRead/onWrite dispatch in src/core/store/settings.ts (including session-id persistence writes) and add focused regression coverage in tests/unit/settings-store.spec.ts plus integration hook-log assertions."
    },
    {
      "created_at": "2026-02-22T20:32:06.543Z",
      "author": "cursor-maintainer",
      "text": "Docs-first update complete: PRD.md Milestone 5 hook-lifecycle checklist and README planned-search/extensions baseline now explicitly include settings read/write operations in the implemented runtime hook call-site coverage before code changes."
    },
    {
      "created_at": "2026-02-22T20:46:32.844Z",
      "author": "cursor-maintainer",
      "text": "Implemented docs-first + code change-set for settings hook call-site expansion. Docs: PRD.md and README.md now include settings read/write operations in the implemented hook lifecycle baseline. Code: src/core/store/settings.ts now dispatches active onRead hooks for settings reads and onWrite hooks for settings writes, with deterministic op labels settings:write and settings:session for generated session persistence. Tests: tests/unit/settings-store.spec.ts adds hook-dispatch regressions for read/write and settings:session writes; tests/integration/cli.integration.spec.ts now rewrites init prefix under an active hook extension and asserts read:settings.json plus write:settings:write:settings.json events. Evidence: node dist/cli.js test pm-p8p --run --timeout 3600 --json passed all 6 linked tests (including sandboxed coverage); node dist/cli.js test-all --status in_progress --timeout 3600 --json totals items=8 linked_tests=29 passed=11 failed=0 skipped=18; node dist/cli.js test-all --status closed --timeout 3600 --json totals items=28 linked_tests=103 passed=46 failed=0 skipped=57. Coverage statement: run-tests coverage remains 100% lines/branches/functions/statements (All files 100/100/100/100). Follow-up items created: none."
    },
    {
      "created_at": "2026-03-04T01:15:59.839Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: expand hook lifecycle call-site coverage by wiring stats/health/gc command file operations through extension onRead/onWrite dispatch with deterministic warning propagation and regression tests."
    },
    {
      "created_at": "2026-03-04T01:19:54.259Z",
      "author": "maintainer-agent",
      "text": "Implemented docs-first + code changes to expand hook lifecycle call-site coverage for stats/health/gc command file-system paths, preserving deterministic output contracts while propagating hook warnings where command schemas already include warnings."
    },
    {
      "created_at": "2026-03-04T01:38:38.430Z",
      "author": "maintainer-agent",
      "text": "Evidence: ran node scripts/run-tests.mjs test -- tests/unit/stats-command.spec.ts tests/unit/health-command.spec.ts tests/unit/gc-command.spec.ts (pass 15/15). Mandatory item run: node dist/cli.js test pm-p8p --run --timeout 3600 --json (linked results passed=7 failed=0 skipped=0). Regression sweeps: node dist/cli.js test-all --status in_progress --timeout 3600 --json => items=7 linked_tests=31 passed=15 failed=0 skipped=16; node dist/cli.js test-all --status closed --timeout 3600 --json => items=37 linked_tests=128 passed=51 failed=0 skipped=77. Coverage statement: pm item run includes node scripts/run-tests.mjs coverage with All files at 100% lines/branches/functions/statements. Follow-up items created: none."
    },
    {
      "created_at": "2026-03-04T02:09:22.949Z",
      "author": "cursor-maintainer",
      "text": "Planned changeset: docs-first expand hook lifecycle call-site coverage to built-in beads/todos import-export file operations, then wire onRead/onWrite dispatch with deterministic warning propagation and targeted unit regressions."
    },
    {
      "created_at": "2026-03-04T02:42:42.192Z",
      "author": "cursor-maintainer",
      "text": "Implemented docs-first hook call-site expansion for built-in import/export paths. Docs: updated PRD.md milestone hook-lifecycle checklist and README planned-search/extensions baseline to include built-in beads/todos import-export source/item/history file operations. Code: src/cli/commands/beads.ts now dispatches onRead for source JSONL and onWrite for imported item/history writes (import + import:history); src/extensions/builtins/todos/import-export.ts now dispatches onRead for source folder/markdown reads and onWrite for imported item/history writes and exported markdown writes (todos:export), with deterministic warning propagation. Tests: added hook-dispatch regressions in tests/unit/beads-command.spec.ts and tests/unit/todos-extension.spec.ts. Evidence: pnpm build passed; node scripts/run-tests.mjs test -- tests/unit/beads-command.spec.ts tests/unit/todos-extension.spec.ts passed (24/24). Mandatory item run passed: pm test pm-p8p --run --timeout 7200 --json with 8 passed, 0 failed, 0 skipped linked tests. Regression sweeps passed: pm test-all --status in_progress --timeout 7200 --json totals items=7 linked_tests=32 passed=16 failed=0 skipped=16; pm test-all --status closed --timeout 7200 --json totals items=37 linked_tests=128 passed=51 failed=0 skipped=77. Coverage proof: node scripts/run-tests.mjs coverage reports All files 100% statements/branches/functions/lines. Follow-up items created: none."
    },
    {
      "created_at": "2026-03-04T12:20:40.317Z",
      "author": "cursor-maintainer",
      "text": "Planned closure pass: run mandatory pm test pm-p8p --run, then pm test-all sweeps (in_progress + closed), log evidence, and close if all checks remain green with 100% coverage."
    },
    {
      "created_at": "2026-03-04T12:45:58.910Z",
      "author": "cursor-maintainer",
      "text": "Evidence: pm test pm-p8p --run --timeout 7200 --json passed all linked tests (8 passed, 0 failed, 0 skipped), including node scripts/run-tests.mjs coverage reporting All files 100% statements/branches/functions/lines. Regression sweeps passed: pm test-all --status in_progress --timeout 7200 --json totals items=5 linked_tests=25 passed=14 failed=0 skipped=11; pm test-all --status closed --timeout 7200 --json totals items=40 linked_tests=138 passed=52 failed=0 skipped=86. Acceptance criteria met: deterministic before/after/read/write/index hook lifecycle behavior validated with sandbox-safe regression coverage and no failures."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "align hook lifecycle milestone wording with search onRead call-site expansion"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "docs-first afterCommand failure-path contract clarification"
    },
    {
      "path": "src/cli/commands/activity.ts",
      "scope": "project",
      "note": "activity command onRead hook dispatch"
    },
    {
      "path": "src/cli/commands/beads.ts",
      "scope": "project",
      "note": "dispatch onRead/onWrite hooks for beads import source/item/history files"
    },
    {
      "path": "src/cli/commands/gc.ts",
      "scope": "project",
      "note": "dispatch onRead/onWrite hooks for cache gc paths"
    },
    {
      "path": "src/cli/commands/health.ts",
      "scope": "project",
      "note": "dispatch onRead hooks for required directory checks"
    },
    {
      "path": "src/cli/commands/history.ts",
      "scope": "project",
      "note": "history command onRead hook dispatch"
    },
    {
      "path": "src/cli/commands/reindex.ts",
      "scope": "project",
      "note": "invoke onIndex hook call site"
    },
    {
      "path": "src/cli/commands/search.ts",
      "scope": "project",
      "note": "dispatch onRead hooks for search corpus reads"
    },
    {
      "path": "src/cli/commands/stats.ts",
      "scope": "project",
      "note": "dispatch onRead hooks for history scans"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "command lifecycle hook invocation"
    },
    {
      "path": "src/core/extensions/index.ts",
      "scope": "project",
      "note": "extension runtime exports"
    },
    {
      "path": "src/core/extensions/loader.ts",
      "scope": "project",
      "note": "extension runtime and activation pipeline"
    },
    {
      "path": "src/core/store/item-store.ts",
      "scope": "project",
      "note": "invoke onRead/onWrite hook call sites"
    },
    {
      "path": "src/core/store/settings.ts",
      "scope": "project",
      "note": "settings read-write hook dispatch"
    },
    {
      "path": "src/extensions/builtins/todos/import-export.ts",
      "scope": "project",
      "note": "dispatch onRead/onWrite hooks for todos import/export file operations"
    },
    {
      "path": "tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "note": "integration coverage for command hook lifecycle execution"
    },
    {
      "path": "tests/unit/beads-command.spec.ts",
      "scope": "project",
      "note": "regression coverage for beads hook call-site dispatch"
    },
    {
      "path": "tests/unit/extension-loader.spec.ts",
      "scope": "project",
      "note": "hook registration and activation failure tests"
    },
    {
      "path": "tests/unit/gc-command.spec.ts",
      "scope": "project",
      "note": "gc read/write hook dispatch regression coverage"
    },
    {
      "path": "tests/unit/health-command.spec.ts",
      "scope": "project",
      "note": "health hook warning propagation regression coverage"
    },
    {
      "path": "tests/unit/reindex-command.spec.ts",
      "scope": "project",
      "note": "unit coverage for onIndex runtime hook dispatch"
    },
    {
      "path": "tests/unit/search-command.spec.ts",
      "scope": "project",
      "note": "verify search read-hook call-site dispatch"
    },
    {
      "path": "tests/unit/settings-store.spec.ts",
      "scope": "project",
      "note": "unit coverage for settings hook dispatch"
    },
    {
      "path": "tests/unit/stats-command.spec.ts",
      "scope": "project",
      "note": "stats hook dispatch regression coverage"
    },
    {
      "path": "tests/unit/todos-extension.spec.ts",
      "scope": "project",
      "note": "regression coverage for todos hook call-site dispatch"
    },
    {
      "path": "vitest.config.ts",
      "scope": "project",
      "note": "coverage include updates if needed"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "full sandboxed coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "integration verification for extension before/after hook lifecycle"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/beads-command.spec.ts tests/unit/todos-extension.spec.ts",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "targeted built-in extension hook call-site regression"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/extension-loader.spec.ts",
      "scope": "project",
      "timeout_seconds": 900,
      "note": "targeted extension hook lifecycle regression"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/reindex-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 900,
      "note": "targeted reindex hook call-site regression"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/search-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 900,
      "note": "targeted search hook lifecycle regression"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/settings-store.spec.ts",
      "scope": "project",
      "timeout_seconds": 900,
      "note": "targeted settings hook regression"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/stats-command.spec.ts tests/unit/health-command.spec.ts tests/unit/gc-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "targeted hook call-site regression for stats health gc"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "agent dogfood protocol"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "governing spec"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public behavior contract"
    }
  ]
}

Add lifecycle hook APIs and invocation ordering.
