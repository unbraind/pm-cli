{
  "id": "pm-xyv3",
  "title": "M5 follow-up: activity history directory read hook dispatch",
  "description": "Dispatch extension onRead hooks for history-directory scans in activity command flow.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:extensions-hooks",
    "code",
    "milestone:5",
    "pm-cli",
    "priority:1"
  ],
  "created_at": "2026-03-04T20:23:40.638Z",
  "updated_at": "2026-03-04T20:34:55.660Z",
  "deadline": "2026-03-06T20:23:22.000Z",
  "author": "maintainer-agent",
  "estimated_minutes": 60,
  "acceptance_criteria": "Activity command dispatches onRead for history directory scans; docs stay aligned; sandboxed tests pass with 100% coverage and pm regression sweeps pass.",
  "dependencies": [
    {
      "id": "pm-b1w",
      "kind": "parent",
      "created_at": "2026-03-04T20:23:40.638Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-04T20:23:40.638Z",
      "author": "maintainer-agent",
      "text": "Activity should dispatch onRead for history directory scans before stream reads."
    },
    {
      "created_at": "2026-03-04T20:23:55.497Z",
      "author": "maintainer-agent",
      "text": "Planned change-set: docs-first wording update in PRD/README, then activity command onRead dispatch for history directory enumeration plus integration assertion update for read:history event; finish with mandatory pm test and pm test-all sweeps."
    },
    {
      "created_at": "2026-03-04T20:25:23.721Z",
      "author": "maintainer-agent",
      "text": "Implemented docs-first updates in PRD/README to include history/activity directory-scan read hooks, then added runActiveOnReadHooks dispatch for activity history directory enumeration and unit regression coverage in history-activity-command spec."
    },
    {
      "created_at": "2026-03-04T20:34:55.311Z",
      "author": "maintainer-agent",
      "text": "Evidence: pm test pm-xyv3 --run --timeout 7200 --json passed 3/3 linked tests (coverage + integration + unit); pm test-all --status in_progress --timeout 7200 --json totals items=1 linked_tests=3 passed=3 failed=0 skipped=0; pm test-all --status closed --timeout 7200 --json totals items=57 linked_tests=186 passed=56 failed=0 skipped=130. Coverage remained 100% lines/branches/functions/statements. Changed files: PRD.md, README.md, src/cli/commands/activity.ts, tests/unit/history-activity-command.spec.ts."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-04T20:23:40.638Z",
      "author": "maintainer-agent",
      "text": "Docs-first then code/tests then mandatory pm test and pm test-all sweeps."
    }
  ],
  "learnings": [
    {
      "created_at": "2026-03-04T20:23:40.638Z",
      "author": "maintainer-agent",
      "text": "Track hook call-site parity at directory and file read levels."
    }
  ],
  "files": [
    {
      "path": "src/cli/commands/activity.ts",
      "scope": "project",
      "note": "add history-directory onRead hook dispatch"
    },
    {
      "path": "tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "note": "assert read hook event for history directory scan"
    },
    {
      "path": "tests/unit/history-activity-command.spec.ts",
      "scope": "project",
      "note": "assert activity onRead hook for history directory scans"
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
      "command": "node scripts/run-tests.mjs test -- tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "targeted integration regression for activity onRead directory dispatch"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/history-activity-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 900,
      "note": "targeted unit regression for activity directory hook dispatch"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "governing workflow and closure protocol"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "update hook lifecycle wording for activity directory scan"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "document activity history-directory onRead dispatch"
    }
  ]
}

Expand hook lifecycle call-site coverage so activity emits a deterministic onRead event for history directory enumeration before reading stream files.
