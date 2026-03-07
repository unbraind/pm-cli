{
  "id": "pm-c0r",
  "title": "Milestone 2 - History + Restore",
  "description": "Milestone epic for patch history activity history and replay restore correctness.",
  "type": "Epic",
  "status": "closed",
  "priority": 0,
  "tags": [
    "area:history",
    "core",
    "milestone:2",
    "pm-cli"
  ],
  "created_at": "2026-02-17T23:01:11.006Z",
  "updated_at": "2026-03-04T15:12:34.338Z",
  "deadline": "2026-02-27T23:01:11.006Z",
  "author": "steve",
  "estimated_minutes": 420,
  "acceptance_criteria": "Milestone 2 checklist items are implemented with replay validation.",
  "dependencies": [
    {
      "id": "pm-j7a",
      "kind": "child",
      "created_at": "2026-02-17T23:01:11.006Z",
      "author": "steve"
    },
    {
      "id": "pm-u9r",
      "kind": "blocks",
      "created_at": "2026-02-17T23:01:11.006Z",
      "author": "steve"
    }
  ],
  "comments": [
    {
      "created_at": "2026-02-17T23:01:11.006Z",
      "author": "steve",
      "text": "Milestone 2 ensures every mutation is auditable and restorable."
    },
    {
      "created_at": "2026-03-04T14:55:37.646Z",
      "author": "unknown",
      "text": "Planned closure pass: validate Milestone 2 completion against PRD + linked child tasks, then run linked sandbox coverage and regression sweeps (test-all in_progress + closed) before closing with evidence."
    },
    {
      "created_at": "2026-03-04T15:12:33.962Z",
      "author": "maintainer-agent",
      "text": "Evidence: refreshed global CLI availability from this repo via npm i -g . (pm --version => 0.1.0). Verification run sequence completed in sandbox-safe mode: (1) pm test pm-c0r --run --timeout 3600 --json => passed=1 failed=0 skipped=0; (2) pm test-all --status in_progress --timeout 3600 --json => items=1 linked_tests=1 passed=1 failed=0 skipped=0; (3) pm test-all --status closed --timeout 3600 --json => items=47 linked_tests=168 passed=54 failed=0 skipped=114. Coverage statement: node scripts/run-tests.mjs coverage reports 100% lines/branches/functions/statements in this verification pass."
    }
  ],
  "notes": [
    {
      "created_at": "2026-02-17T23:01:11.006Z",
      "author": "steve",
      "text": "Success means exact state reconstruction and append-only history."
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 3600,
      "note": "milestone closure coverage gate"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "dogfood workflow"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "governing spec"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public contract"
    }
  ]
}

Implement append-only history and replay restore with hash verification.
