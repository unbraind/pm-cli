{
  "id": "pm-imob",
  "title": "M5 roadmap: Beads import extension parity polish",
  "description": "Polish parity and harden beads import extension.",
  "type": "Task",
  "status": "closed",
  "priority": 2,
  "tags": [
    "area:extensions",
    "milestone:5",
    "pm-cli",
    "roadmap"
  ],
  "created_at": "2026-03-07T14:01:19.318Z",
  "updated_at": "2026-03-07T20:26:38.913Z",
  "author": "maintainer-agent",
  "estimated_minutes": 60,
  "acceptance_criteria": "Beads import is fully polished.",
  "comments": [
    {
      "created_at": "2026-03-07T20:00:20.675Z",
      "author": "maintainer-agent",
      "text": "Extended Beads import field mapping parity (labels/created_by/closed_at/design/external_ref plus linked files/tests/docs) and validated deterministic import behavior with expanded fixture coverage."
    },
    {
      "created_at": "2026-03-07T20:00:20.847Z",
      "author": "maintainer-agent",
      "text": "Fixed a deterministic test expectation to assert dependency created_at fallback from imported item timestamp when source created_at is absent."
    },
    {
      "created_at": "2026-03-07T20:11:43.504Z",
      "author": "maintainer-agent",
      "text": "Addressing coverage gate failure from pm test-all --status closed: add deterministic fixture/assertion that exercises design/external_ref append branches when body is already non-empty."
    },
    {
      "created_at": "2026-03-07T20:26:32.189Z",
      "author": "maintainer-agent",
      "text": "Added Beads fixture branches for design/external_ref body composition, restoring 100% branch coverage for beads import paths."
    },
    {
      "created_at": "2026-03-07T20:26:32.424Z",
      "author": "maintainer-agent",
      "text": "Evidence: pm test pm-imob --run passed; pm test-all --status in_progress passed (failed=0); pm test-all --status closed passed (failed=0, passed=62, skipped=284); node scripts/run-tests.mjs coverage reports 100% statements/branches/functions/lines."
    }
  ],
  "files": [
    {
      "path": ".gitignore",
      "scope": "project",
      "note": "track beads default-path fixtures in repo"
    },
    {
      "path": "src/cli/commands/beads.ts",
      "scope": "project"
    },
    {
      "path": "tests/fixtures/beads/import-records.jsonl",
      "scope": "project"
    },
    {
      "path": "tests/unit/beads-command.spec.ts",
      "scope": "project"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs test",
      "scope": "project",
      "timeout_seconds": 240
    }
  ],
  "docs": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "beads import parity contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "beads import behavior contract"
    }
  ],
  "close_reason": "Completed Beads import parity polish with expanded mapping coverage and restored 100% coverage gate; pm test and regression sweeps passed."
}

Implement remaining parity polish and hardening for built-in beads import extension.
