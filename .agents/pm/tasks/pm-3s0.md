{
  "id": "pm-3s0",
  "title": "M5: Built-in todos import export extension",
  "description": "Implement todos markdown import and export extension.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:extensions-todos",
    "core",
    "milestone:5",
    "pm-cli"
  ],
  "created_at": "2026-02-17T23:02:12.078Z",
  "updated_at": "2026-03-04T13:40:47.644Z",
  "deadline": "2026-03-13T23:02:12.078Z",
  "author": "steve",
  "estimated_minutes": 120,
  "acceptance_criteria": "Todos import and export preserve mapped fields deterministically.",
  "dependencies": [
    {
      "id": "pm-b1w",
      "kind": "parent",
      "created_at": "2026-02-17T23:02:12.078Z",
      "author": "steve"
    },
    {
      "id": "pm-f45",
      "kind": "blocks",
      "created_at": "2026-02-17T23:02:12.078Z",
      "author": "steve"
    }
  ],
  "comments": [
    {
      "created_at": "2026-02-19T20:12:36.006Z",
      "author": "cursor-agent",
      "text": "Planned change-set: docs-first update to mark todos import and export as built-in extension command handlers, then implement built-in todos extension modules and command-path dispatch through extension registry, keeping beads as import-only extension command without core fallback."
    },
    {
      "created_at": "2026-02-19T20:16:43.603Z",
      "author": "cursor-agent",
      "text": "Docs-first update completed: README now lists pm todos import/export as built-in extension commands and clarifies beads is extension import-only; PRD command contracts now include todos import/export outputs, marks todos built-in extension as implemented baseline, and tightens beads to extension-only (no core fallback)."
    },
    {
      "created_at": "2026-02-19T21:25:47.916Z",
      "author": "cursor-agent",
      "text": "Implemented built-in todos import/export extension module with command handlers for todos import and todos export, todos markdown mapping logic, and CLI command-path wiring through required extension dispatch. Added integration and unit coverage for todos import/export behavior and extension-only command handling."
    },
    {
      "created_at": "2026-02-19T21:25:48.115Z",
      "author": "cursor-agent",
      "text": "Evidence: pnpm build passed. node dist/cli.js test pm-3s0 --run --timeout 2400 --json passed all linked tests including node scripts/run-tests.mjs coverage with 100% lines/branches/functions/statements. Final regression sweeps on this code state passed: node dist/cli.js test-all --status in_progress --timeout 2400 --json totals items=7 linked_tests=33 passed=32 failed=0 skipped=1; node dist/cli.js test-all --status closed --timeout 2400 --json totals items=16 linked_tests=44 passed=41 failed=0 skipped=3."
    },
    {
      "created_at": "2026-03-04T13:30:07.637Z",
      "author": "steve",
      "text": "Planned closure pass: re-run linked sandbox-safe tests with pm test --run and regression sweeps via pm test-all (in_progress + closed). If green and coverage remains 100%, close this item with evidence."
    },
    {
      "created_at": "2026-03-04T13:40:47.327Z",
      "author": "steve",
      "text": "Evidence: pm test pm-3s0 --run --timeout 7200 --json passed all linked tests (3/3, failed=0). Regression sweeps passed: pm test-all --status in_progress --timeout 7200 --json totals items=2 linked_tests=9 passed=7 failed=0 skipped=2; pm test-all --status closed --timeout 7200 --json totals items=43 linked_tests=154 passed=54 failed=0 skipped=100. Coverage statement: sandboxed coverage run remained 100% lines/branches/functions/statements."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "docs-first built-in extensions status update"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "docs-first command surface update"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "declare todos command paths and extension-only dispatch"
    },
    {
      "path": "src/extensions/builtins/todos/import-export.ts",
      "scope": "project",
      "note": "todos import export mapping logic"
    },
    {
      "path": "src/extensions/builtins/todos/index.ts",
      "scope": "project",
      "note": "built-in todos extension activate hook"
    },
    {
      "path": "tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "note": "integration coverage for todos extension commands"
    },
    {
      "path": "tests/unit/todos-extension.spec.ts",
      "scope": "project",
      "note": "unit coverage for todos extension mappings"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 2400,
      "note": "full sandboxed coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "integration extension command coverage"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/todos-extension.spec.ts",
      "scope": "project",
      "timeout_seconds": 900,
      "note": "todos extension unit coverage"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "dogfood and workflow constraints"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "governing extension behavior and command contracts"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "documented command surface"
    }
  ]
}

Ship built-in todos adapter extension.
