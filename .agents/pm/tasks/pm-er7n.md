{
  "id": "pm-er7n",
  "title": "M3 follow-up: harden activity when history directory is missing",
  "description": "Return deterministic empty activity when history directory is missing instead of generic filesystem failure.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:history",
    "code",
    "milestone:3",
    "pm-cli",
    "priority:1",
    "tests"
  ],
  "created_at": "2026-03-06T04:58:36.054Z",
  "updated_at": "2026-03-06T05:13:31.738Z",
  "deadline": "2026-03-07T23:59:00.000Z",
  "author": "cursor-maintainer",
  "estimated_minutes": 75,
  "acceptance_criteria": "pm activity returns {activity:[],count:0} when history directory is absent; targeted and full regression tests pass with 100% coverage unchanged.",
  "dependencies": [
    {
      "id": "pm-54d",
      "kind": "related",
      "created_at": "2026-03-06T04:58:36.054Z",
      "author": "cursor-maintainer"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-06T04:58:36.054Z",
      "author": "cursor-maintainer",
      "text": "Why this exists: activity should not crash when history directory is absent; command should remain deterministic and resilient."
    },
    {
      "created_at": "2026-03-06T04:58:48.695Z",
      "author": "cursor-maintainer",
      "text": "Planned changeset: make activity command tolerate absent history directory by returning empty activity; add unit regression case and run linked tests plus test-all sweeps before closure."
    },
    {
      "created_at": "2026-03-06T04:59:27.874Z",
      "author": "cursor-maintainer",
      "text": "Implemented changeset: activity command now treats missing history directory (ENOENT) as an empty history stream set, and added a unit regression asserting deterministic empty activity output when history directory is removed."
    },
    {
      "created_at": "2026-03-06T05:03:01.624Z",
      "author": "cursor-maintainer",
      "text": "Coverage gate initially failed after first patch (activity missing-history fallback), so I added a non-ENOENT propagation regression case and simplified ENOENT detection to keep deterministic behavior while restoring full branch coverage."
    },
    {
      "created_at": "2026-03-06T05:13:25.849Z",
      "author": "cursor-maintainer",
      "text": "Evidence: pm test pm-er7n --run --timeout 7200 --json => linked_tests=2 passed=2 failed=0 skipped=0; pm test-all --status in_progress --timeout 7200 --json => items=1 linked_tests=2 passed=2 failed=0 skipped=0; pm test-all --status closed --timeout 7200 --json => items=77 linked_tests=233 passed=61 failed=0 skipped=172. Coverage proof from linked coverage run: All files | 100 | 100 | 100 | 100. Follow-up: no additional tracking items required for this hardening slice."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-06T04:58:36.054Z",
      "author": "cursor-maintainer",
      "text": "Plan: update activity command missing-directory path handling and add regression coverage before full sweeps."
    }
  ],
  "learnings": [
    {
      "created_at": "2026-03-06T04:58:36.054Z",
      "author": "cursor-maintainer",
      "text": "Missing optional tracker subdirectories should degrade to deterministic empty results where safe."
    }
  ],
  "files": [
    {
      "path": "src/cli/commands/activity.ts",
      "scope": "project",
      "note": "missing-history fallback"
    },
    {
      "path": "tests/unit/history-activity-command.spec.ts",
      "scope": "project",
      "note": "regression for missing history directory"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 7200,
      "note": "coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/history-activity-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "targeted activity regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "governing workflow"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public command contract"
    }
  ]
}

Harden activity command by treating a missing history directory as zero history streams, preserving deterministic output and avoiding ENOENT failures in partially initialized/corrupted stores.
