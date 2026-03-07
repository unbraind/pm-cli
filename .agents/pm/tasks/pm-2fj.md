{
  "id": "pm-2fj",
  "title": "M2: History and activity commands",
  "description": "Implement user-visible history and activity inspection commands.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:history",
    "core",
    "milestone:2",
    "pm-cli"
  ],
  "created_at": "2026-02-17T23:02:08.818Z",
  "updated_at": "2026-02-18T01:33:09.884Z",
  "deadline": "2026-02-27T23:02:08.818Z",
  "author": "steve",
  "estimated_minutes": 90,
  "acceptance_criteria": "History and activity command outputs are deterministic and complete.",
  "dependencies": [
    {
      "id": "pm-c0r",
      "kind": "parent",
      "created_at": "2026-02-17T23:02:08.818Z",
      "author": "steve"
    },
    {
      "id": "pm-u9r",
      "kind": "blocks",
      "created_at": "2026-02-17T23:02:08.818Z",
      "author": "steve"
    }
  ],
  "comments": [
    {
      "created_at": "2026-02-18T01:27:26.694Z",
      "author": "agent",
      "text": "Implementing history/activity CLI commands with deterministic output contracts and test coverage; docs will be updated before behavior changes."
    },
    {
      "created_at": "2026-02-18T01:33:09.397Z",
      "author": "agent",
      "text": "Implemented new history/activity command surface: added runHistory and runActivity handlers, wired CLI registration/exports, updated README+PRD command matrices first, and added unit/integration coverage for deterministic history/activity behavior."
    },
    {
      "created_at": "2026-02-18T01:33:09.558Z",
      "author": "agent",
      "text": "Evidence: pnpm build passed; node dist/cli.js test pm-2fj --run --timeout 1200 --json passed (2/2 linked tests). Coverage report remained 100% statements/branches/functions/lines. Regression sweep passed via node dist/cli.js test-all --status in_progress --timeout 1200 --json with totals items=6 linked_tests=9 passed=9 failed=0 skipped=0."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "Update command matrix and milestone state"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "Update implemented-vs-roadmap command lists"
    },
    {
      "path": "src/cli/commands/index.ts",
      "scope": "project",
      "note": "Export new command handlers"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "Register history/activity commands"
    },
    {
      "path": "src/commands/activity.ts",
      "scope": "project",
      "note": "Implement cross-item activity stream"
    },
    {
      "path": "src/commands/history.ts",
      "scope": "project",
      "note": "Implement per-item history retrieval"
    },
    {
      "path": "tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "note": "Add history/activity CLI integration checks"
    },
    {
      "path": "tests/unit/history-activity-command.spec.ts",
      "scope": "project",
      "note": "Unit coverage for history/activity handlers"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 600,
      "note": "Sandboxed coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test",
      "scope": "project",
      "timeout_seconds": 600,
      "note": "Sandboxed regression tests"
    }
  ],
  "docs": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "Authoritative command and output contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "Public command surface reference"
    }
  ]
}

Expose history timelines through command output contracts.
