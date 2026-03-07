{
  "id": "pm-geq",
  "title": "M5: Renderer and command extension points",
  "description": "Implement deterministic extension command and renderer registration baseline with safe runtime override behavior for core commands and output formatting.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:extensions-renderers",
    "core",
    "milestone:5",
    "pm-cli"
  ],
  "created_at": "2026-02-17T23:02:11.686Z",
  "updated_at": "2026-03-04T13:26:04.822Z",
  "deadline": "2026-03-13T23:02:11.686Z",
  "author": "steve",
  "estimated_minutes": 180,
  "acceptance_criteria": "Extensions can register deterministic renderer overrides used by output formatting and command override handlers for core commands with safe failure containment; tests and sandboxed regressions remain 100% coverage.",
  "dependencies": [
    {
      "id": "pm-b1w",
      "kind": "parent",
      "created_at": "2026-02-17T23:02:11.686Z",
      "author": "steve"
    },
    {
      "id": "pm-f45",
      "kind": "blocks",
      "created_at": "2026-02-17T23:02:11.686Z",
      "author": "steve"
    }
  ],
  "comments": [
    {
      "created_at": "2026-02-19T17:58:50.080Z",
      "author": "maintainer-agent",
      "text": "Planned change-set: docs-first update describing command/renderer extension-point baseline, then implement deterministic extension API registration + runtime dispatch with failure containment and add focused unit/integration coverage before pm test/pm test-all evidence logging."
    },
    {
      "created_at": "2026-02-19T18:23:27.398Z",
      "author": "maintainer-agent",
      "text": "Implemented docs-first command/renderer extension-point baseline: README.md and PRD.md now define deterministic command-result override and renderer override behavior; loader activation now exposes registerCommand/registerRenderer registries with deterministic precedence and failure containment; runtime state in core/extensions now tracks active command context + command/renderer registries; output formatting applies command-result overrides before renderer overrides with fallback to core rendering; CLI preAction wires active command context and registries from activated extensions."
    },
    {
      "created_at": "2026-02-19T18:23:27.586Z",
      "author": "maintainer-agent",
      "text": "Evidence: pm test pm-geq --run --timeout 2400 --json passed all linked tests (3/3). Regression sweeps passed: pm test-all --status in_progress --timeout 2400 --json => items=5 linked_tests=26 passed=25 failed=0 skipped=1; pm test-all --status closed --timeout 2400 --json => items=16 linked_tests=44 passed=41 failed=0 skipped=3. Coverage proof remains 100% statements/branches/functions/lines via linked node scripts/run-tests.mjs coverage execution."
    },
    {
      "created_at": "2026-02-19T18:23:59.720Z",
      "author": "maintainer-agent",
      "text": "Handoff note: this iteration delivers docs-first command-result/renderer override baseline with full passing regression evidence; item remains in_progress for future dynamic command registration and broader extension override surface hardening."
    },
    {
      "created_at": "2026-02-23T13:45:46.840Z",
      "author": "maintainer-agent",
      "text": "Planned change-set: docs-first clarify extension command-handler failure semantics, then implement deterministic generic-failure behavior when declared extension handlers throw (instead of not-found fallback), with integration regression coverage and full pm test + test-all evidence."
    },
    {
      "created_at": "2026-02-23T13:46:37.978Z",
      "author": "maintainer-agent",
      "text": "Docs-first update completed: README.md and PRD.md now define deterministic extension-command handler failure semantics for extension-only command paths (not-found when no handler is registered, generic failure plus extension_command_handler_failed warning code when a matched handler throws)."
    },
    {
      "created_at": "2026-02-23T13:59:37.651Z",
      "author": "maintainer-agent",
      "text": "Implemented docs-first + code hardening for extension command handler failures. Code: src/cli/main.ts now treats matched extension-handler throws as deterministic generic failure (exit code 1) and includes the warning code in the error message, while preserving not-found behavior for extension-only paths with no matched handler. Tests: tests/integration/cli.integration.spec.ts adds regression coverage for a throwing beads import handler and asserts generic-failure output with extension_command_handler_failed warning code context. Evidence: pm test pm-geq --run --timeout 3600 --json passed 3/3 linked tests; pm test-all --status in_progress --timeout 3600 --json totals items=8 linked_tests=30 passed=13 failed=0 skipped=17; pm test-all --status closed --timeout 3600 --json totals items=31 linked_tests=111 passed=48 failed=0 skipped=63. Coverage proof: linked coverage run remained 100% statements/branches/functions/lines (All files 100/100/100/100). Follow-up items created: none."
    },
    {
      "created_at": "2026-03-03T21:44:16.861Z",
      "author": "maintainer-agent",
      "text": "Planned change-set: docs-first add explicit milestone status for dynamic extension command path registration, then implement deterministic dispatch support for extension-declared non-core command paths with focused integration + unit coverage and full pm test/pm test-all evidence logging."
    },
    {
      "created_at": "2026-03-03T21:46:48.728Z",
      "author": "maintainer-agent",
      "text": "Docs-first update completed: PRD.md and README.md now record dynamic extension command-path support for extension-declared non-core command handlers surfaced at runtime, while keeping broader extension-surface hardening as remaining work."
    },
    {
      "created_at": "2026-03-03T22:14:03.160Z",
      "author": "maintainer-agent",
      "text": "Implemented docs-first dynamic extension command-path support for non-core handlers: PRD.md/README.md now document runtime-surfaced extension command paths; src/cli/main.ts now pre-registers extension-declared command paths before parse, captures loose --flag args for handler option context, and dispatches those paths through existing extension handler semantics; tests/integration/cli.integration.spec.ts now verifies a custom 'acme sync' command path with repeated flags and positional args."
    },
    {
      "created_at": "2026-03-03T22:14:12.219Z",
      "author": "maintainer-agent",
      "text": "Evidence: pnpm build passed; targeted integration passed via node scripts/run-tests.mjs test -- tests/integration/cli.integration.spec.ts (19/19). Mandatory item run passed: node dist/cli.js test pm-geq --run --timeout 7200 --json with linked results 3 passed / 0 failed / 0 skipped. Regression sweeps passed: node dist/cli.js test-all --status in_progress --timeout 7200 --json => totals items=7 linked_tests=28 passed=13 failed=0 skipped=15; node dist/cli.js test-all --status closed --timeout 7200 --json => totals items=34 linked_tests=119 passed=49 failed=0 skipped=70. Coverage proof remains 100% statements/branches/functions/lines from linked sandboxed coverage run."
    },
    {
      "created_at": "2026-03-04T13:15:59.338Z",
      "author": "cursor-maintainer",
      "text": "Verification pass for closure: re-run linked sandbox-safe tests and both test-all sweeps, then close/release if acceptance criteria and 100% coverage remain satisfied."
    },
    {
      "created_at": "2026-03-04T13:25:54.711Z",
      "author": "cursor-maintainer",
      "text": "Evidence: pm test pm-geq --run --timeout 7200 --json => passed=3 failed=0 skipped=0 (includes node scripts/run-tests.mjs coverage with 100% statements/branches/functions/lines). Regression sweeps: pm test-all --status in_progress --timeout 7200 --json => items=3 linked_tests=12 passed=8 failed=0 skipped=4; pm test-all --status closed --timeout 7200 --json => items=42 linked_tests=151 passed=54 failed=0 skipped=97. Acceptance criteria status: met; extension command/renderer baseline remains deterministic with safe failure containment."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "milestone and API status update before implementation"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "docs-first update for extension point baseline"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "command override invocation in CLI actions"
    },
    {
      "path": "src/core/extensions/index.ts",
      "scope": "project",
      "note": "runtime registry accessors for active extension points"
    },
    {
      "path": "src/core/extensions/loader.ts",
      "scope": "project",
      "note": "add command and renderer registration APIs"
    },
    {
      "path": "src/core/output/output.ts",
      "scope": "project",
      "note": "renderer override dispatch integration"
    },
    {
      "path": "tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "note": "integration coverage for command and renderer overrides"
    },
    {
      "path": "tests/unit/extension-loader.spec.ts",
      "scope": "project",
      "note": "unit coverage for command and renderer registration"
    },
    {
      "path": "tests/unit/extensions-runtime.spec.ts",
      "scope": "project",
      "note": "runtime wrapper coverage for active command and renderer override registries"
    },
    {
      "path": "tests/unit/output.spec.ts",
      "scope": "project",
      "note": "coverage for renderer and command-result override formatting behavior"
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
      "note": "integration override behavior regression"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/extension-loader.spec.ts",
      "scope": "project",
      "timeout_seconds": 900,
      "note": "targeted extension API regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "dogfood workflow and test safety protocol"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "governing spec for extension API and milestones"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public command and extension contract"
    }
  ]
}

Add extension APIs for command and output augmentation.
