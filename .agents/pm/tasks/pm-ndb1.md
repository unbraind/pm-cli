{
  "id": "pm-ndb1",
  "title": "M5 follow-up: health history stream read hook dispatch",
  "description": "Expand hook lifecycle baseline so pm health dispatches onRead hooks for each history stream path while counting storage streams.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:extensions",
    "area:health",
    "code",
    "doc",
    "milestone:5",
    "pm-cli",
    "priority:1",
    "tests"
  ],
  "created_at": "2026-03-05T14:51:47.339Z",
  "updated_at": "2026-03-05T15:07:20.203Z",
  "deadline": "2026-03-06T23:59:00.000Z",
  "author": "maintainer-agent",
  "estimated_minutes": 60,
  "acceptance_criteria": "pm health dispatches onRead hooks for history stream files deterministically; docs reflect expanded baseline; unit coverage verifies file-level hook events.",
  "dependencies": [
    {
      "id": "pm-p8p",
      "kind": "related",
      "created_at": "2026-03-05T14:51:47.339Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-05T14:51:47.339Z",
      "author": "maintainer-agent",
      "text": "Why broaden hook call-site coverage in health storage scan without changing output contract"
    },
    {
      "created_at": "2026-03-05T14:52:03.723Z",
      "author": "maintainer-agent",
      "text": "Planned changeset docs-first: update PRD and README hook lifecycle baseline for health history stream onRead coverage; then patch health command and extend health unit tests."
    },
    {
      "created_at": "2026-03-05T15:07:19.854Z",
      "author": "maintainer-agent",
      "text": "Implemented docs-first hook lifecycle expansion for health history stream reads. Docs: updated PRD.md and README.md wording to include health history-directory scans plus per-stream path dispatch. Code: src/cli/commands/health.ts now dispatches onRead hooks for each discovered history .jsonl stream and merges hook warnings into health warnings deterministically. Tests: updated tests/unit/health-command.spec.ts to seed two items and assert sorted .jsonl hook events. Validation: node scripts/run-tests.mjs test -- tests/unit/health-command.spec.ts passed 6/6; node scripts/run-tests.mjs coverage passed with All files 100/100/100/100; pm test pm-ndb1 --run --timeout 7200 --json passed totals linked_tests=2 passed=2 failed=0 skipped=0; pm test-all --status in_progress --timeout 7200 --json passed totals items=1 linked_tests=2 passed=2 failed=0 skipped=0; pm test-all --status closed --timeout 7200 --json passed totals items=72 linked_tests=221 passed=59 failed=0 skipped=162. Follow-up items created: none."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-05T14:51:47.339Z",
      "author": "maintainer-agent",
      "text": "Plan update docs first then patch health command then add unit tests then run pm test and test-all"
    }
  ],
  "learnings": [
    {
      "created_at": "2026-03-05T14:51:47.339Z",
      "author": "maintainer-agent",
      "text": "Initial hypothesis health dispatches read hooks for required dirs but not history stream files"
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "docs-first hook lifecycle wording"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "docs-first extension baseline wording"
    },
    {
      "path": "src/cli/commands/health.ts",
      "scope": "project",
      "note": "planned hook dispatch change"
    },
    {
      "path": "tests/unit/health-command.spec.ts",
      "scope": "project",
      "note": "health hook regression coverage"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 240,
      "note": "coverage gate proof"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/health-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 240,
      "note": "targeted regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "governing dogfood protocol"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "hook lifecycle baseline update"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "governing command contract"
    }
  ]
}

PRD milestone 5 still tracks broader hook call-site expansion. This task extends health storage checks to emit deterministic onRead hook events for history stream paths and validates with unit coverage.
