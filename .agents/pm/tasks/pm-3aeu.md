{
  "id": "pm-3aeu",
  "title": "M5 follow-up: dispatch onIndex hooks in gc command",
  "description": "Close a hook-lifecycle gap by emitting deterministic onIndex hook events from pm gc cache cleanup operations.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:extensions-hooks",
    "code",
    "docs",
    "milestone:5",
    "pm-cli",
    "priority:1",
    "tests"
  ],
  "created_at": "2026-03-04T15:33:55.396Z",
  "updated_at": "2026-03-04T15:44:41.448Z",
  "deadline": "2026-03-06T23:59:00.000Z",
  "author": "cursor-maintainer",
  "estimated_minutes": 90,
  "acceptance_criteria": "Met: pm gc dispatches onIndex hooks with deterministic mode gc and cache-target totals; docs are aligned; targeted and regression sweeps passed with 100 percent coverage.",
  "dependencies": [
    {
      "id": "pm-p8p",
      "kind": "discovered_from",
      "created_at": "2026-03-04T15:33:55.396Z",
      "author": "cursor-maintainer"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-04T15:33:55.396Z",
      "author": "cursor-maintainer",
      "text": "Follow-up from hook lifecycle task. gc should emit onIndex events for index cache observability."
    },
    {
      "created_at": "2026-03-04T15:34:05.690Z",
      "author": "cursor-maintainer",
      "text": "Planned changeset: docs-first update for gc onIndex hook behavior then implement onIndex dispatch in gc command and extend gc unit coverage before running pm test and regression sweeps."
    },
    {
      "created_at": "2026-03-04T15:35:09.219Z",
      "author": "cursor-maintainer",
      "text": "Docs-first update complete: PRD and README now explicitly require pm gc to dispatch onIndex hooks with mode gc and deterministic cache-target totals before code changes."
    },
    {
      "created_at": "2026-03-04T15:35:22.263Z",
      "author": "cursor-maintainer",
      "text": "Starting code changes: wire gc command to dispatch onIndex hook context and extend unit tests for event emission plus failing-index warning propagation."
    },
    {
      "created_at": "2026-03-04T15:35:47.758Z",
      "author": "cursor-maintainer",
      "text": "Implemented code changes: gc command now dispatches onIndex hooks with mode gc and total_items equal cache targets scanned; gc unit tests now assert index event emission and deterministic warning propagation for failing onIndex hooks."
    },
    {
      "created_at": "2026-03-04T15:44:41.054Z",
      "author": "cursor-maintainer",
      "text": "Evidence: pm test pm-3aeu --run --timeout 3600 --json passed (2/2 linked commands). pm test-all --status in_progress --timeout 3600 --json passed (items=1 linked_tests=2 passed=2 failed=0 skipped=0). pm test-all --status closed --timeout 3600 --json passed (items=49 linked_tests=171 passed=55 failed=0 skipped=116). Coverage remained 100% for lines branches functions and statements in coverage runs. Follow-up items created: none."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-04T15:33:55.396Z",
      "author": "cursor-maintainer",
      "text": "Plan docs-first update then gc onIndex dispatch then tests and evidence logging."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "docs-first contract clarification for gc onIndex"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "docs-first runtime hook lifecycle clarification"
    },
    {
      "path": "src/cli/commands/gc.ts",
      "scope": "project",
      "note": "gc hook dispatch implementation"
    },
    {
      "path": "tests/unit/gc-command.spec.ts",
      "scope": "project",
      "note": "gc hook lifecycle tests"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 3600,
      "note": "coverage gate remains 100 percent"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/gc-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "targeted gc hook lifecycle regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "agent workflow requirements"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "governing hook lifecycle contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public hook lifecycle behavior"
    }
  ]
}

Context: hook lifecycle docs claim stats/health/gc call-site coverage but gc currently dispatches read/write hooks only. Approach: update docs-first contract language for gc onIndex behavior then implement gc onIndex dispatch with deterministic warning propagation and add unit/integration coverage.
