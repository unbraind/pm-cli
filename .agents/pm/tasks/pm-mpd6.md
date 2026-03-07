{
  "id": "pm-mpd6",
  "title": "Release-readiness drift audit and sync",
  "description": "Audit PRD/README/AGENTS alignment, verify baseline quality gates, and apply the next highest-value fix.",
  "type": "Task",
  "status": "closed",
  "priority": 0,
  "tags": [
    "docs-sync",
    "maintenance",
    "pm-cli",
    "release-readiness"
  ],
  "created_at": "2026-03-06T15:05:41.451Z",
  "updated_at": "2026-03-06T15:12:03.472Z",
  "deadline": "2026-03-07T15:05:41.451Z",
  "author": "maintainer-agent",
  "estimated_minutes": 90,
  "acceptance_criteria": "Contract drift identified or ruled out, linked tests executed via sandbox-safe commands, and evidence logged with coverage status.",
  "comments": [
    {
      "created_at": "2026-03-06T15:05:41.451Z",
      "author": "maintainer-agent",
      "text": "Seed long-running maintainer loop and capture baseline discovery before edits."
    },
    {
      "created_at": "2026-03-06T15:06:05.407Z",
      "author": "maintainer-agent",
      "text": "Starting drift audit: verify PRD/README/AGENTS alignment and run sandbox-safe regression to identify the next highest-value fix."
    },
    {
      "created_at": "2026-03-06T15:08:57.667Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: update AGENTS.md validation steps to explicitly include sandbox-safe coverage verification and coverage evidence logging."
    },
    {
      "created_at": "2026-03-06T15:11:40.338Z",
      "author": "maintainer-agent",
      "text": "Implemented AGENTS.md workflow sync to require sandbox-safe coverage verification before close. Evidence: pm test pm-mpd6 --run passed (linked test + coverage), pm test-all --status in_progress passed (2 passed, 0 failed), and coverage remains 100% across lines/branches/functions/statements."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-06T15:05:41.451Z",
      "author": "maintainer-agent",
      "text": "Start with docs-contract audit then choose the smallest high-value change and verify with coverage."
    }
  ],
  "files": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "sync validation workflow with PRD coverage contract"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 300,
      "note": "sandbox-safe coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test",
      "scope": "project",
      "timeout_seconds": 240,
      "note": "sandbox-safe regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "workflow contract"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public contract"
    }
  ],
  "close_reason": "Synced AGENTS validation workflow with PRD coverage policy; sandbox-safe tests and coverage passed."
}

Run maintainer bootstrap, detect contract drift, and implement one scoped improvement with full evidence.
