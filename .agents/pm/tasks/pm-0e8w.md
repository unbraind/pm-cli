{
  "id": "pm-0e8w",
  "title": "M5: Harden extension command handler context sandbox",
  "description": "Prevent extension command handlers from mutating caller global options by passing isolated context snapshots.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:extensions",
    "code",
    "docs",
    "milestone:5",
    "pm-cli",
    "priority:1",
    "tests"
  ],
  "created_at": "2026-03-04T19:41:50.932Z",
  "updated_at": "2026-03-04T19:52:55.000Z",
  "deadline": "2026-03-06T19:41:50.000Z",
  "author": "steve",
  "estimated_minutes": 90,
  "acceptance_criteria": "runCommandHandler provides isolated context snapshots (args/options/global), docs reflect the sandbox boundary behavior, and unit plus regression tests remain 100% coverage compliant.",
  "dependencies": [
    {
      "id": "pm-b1w",
      "kind": "parent",
      "created_at": "2026-03-04T19:41:50.932Z",
      "author": "steve"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-04T19:41:50.932Z",
      "author": "steve",
      "text": "Why this exists: close a remaining Milestone 5 sandbox boundary gap where extension handlers can mutate caller runtime option state."
    },
    {
      "created_at": "2026-03-04T19:42:14.718Z",
      "author": "steve",
      "text": "Planned change-set: docs-first contract update for command-handler context isolation, then clone global options in runCommandHandler and add mutation-isolation unit coverage."
    },
    {
      "created_at": "2026-03-04T19:43:21.518Z",
      "author": "steve",
      "text": "Docs-first update completed: PRD and README now explicitly require command-handler execution to receive cloned args/options/global snapshots so extension mutation cannot alter caller runtime command state."
    },
    {
      "created_at": "2026-03-04T19:44:00.179Z",
      "author": "steve",
      "text": "Implemented code change: runCommandHandler now passes a cloned global options snapshot to extension handlers, matching existing args/options cloning and preventing handler mutation from leaking into caller command state."
    },
    {
      "created_at": "2026-03-04T19:52:45.110Z",
      "author": "steve",
      "text": "Evidence: pm test pm-0e8w --run --timeout 1800 --json passed 3/3 linked checks (coverage, targeted extension-loader test, build). pm test-all --status in_progress --timeout 1800 --json passed totals items=1 linked_tests=3 passed=3 failed=0 skipped=0. pm test-all --status closed --timeout 1800 --json passed totals items=55 linked_tests=181 passed=56 failed=0 skipped=125. Coverage output remains 100% lines/branches/functions/statements."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-04T19:41:50.932Z",
      "author": "steve",
      "text": "Validation plan: docs first updates then loader runtime unit coverage then pm test and test-all sweeps."
    }
  ],
  "learnings": [
    {
      "created_at": "2026-03-04T19:41:50.932Z",
      "author": "steve",
      "text": "Initial hypothesis: cloning global options in runCommandHandler is sufficient because global options are flat primitives."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "document command-handler context snapshot isolation baseline"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "document extension handler mutation isolation contract"
    },
    {
      "path": "src/core/extensions/loader.ts",
      "scope": "project",
      "note": "command-handler context snapshot hardening"
    },
    {
      "path": "tests/unit/extension-loader.spec.ts",
      "scope": "project",
      "note": "unit coverage for context isolation"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "coverage gate in sandbox"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/extension-loader.spec.ts",
      "scope": "project",
      "timeout_seconds": 900,
      "note": "targeted extension loader regression"
    },
    {
      "command": "pnpm build",
      "scope": "project",
      "timeout_seconds": 600,
      "note": "compile verification"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "workflow and dogfood policy"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "governing extension sandbox boundary contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "user-facing extension behavior notes"
    }
  ]
}

Milestone 5 hardening follow-up: extension command handlers currently receive mutable runtime context references. Harden the command-handler boundary so handler mutations do not leak back into caller command execution state.
