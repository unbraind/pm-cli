{
  "id": "pm-54d",
  "title": "Milestone 3 - Query + Operations",
  "description": "Milestone epic for list query operations and linked artifact commands.",
  "type": "Epic",
  "status": "closed",
  "priority": 0,
  "tags": [
    "area:operations",
    "core",
    "milestone:3",
    "pm-cli"
  ],
  "created_at": "2026-02-17T23:01:11.350Z",
  "updated_at": "2026-03-04T14:52:10.543Z",
  "deadline": "2026-03-03T23:01:11.350Z",
  "author": "steve",
  "estimated_minutes": 420,
  "acceptance_criteria": "Milestone 3 checklist items are implemented and tested.",
  "dependencies": [
    {
      "id": "pm-c0r",
      "kind": "blocks",
      "created_at": "2026-02-17T23:01:11.350Z",
      "author": "steve"
    },
    {
      "id": "pm-j7a",
      "kind": "child",
      "created_at": "2026-02-17T23:01:11.350Z",
      "author": "steve"
    }
  ],
  "comments": [
    {
      "created_at": "2026-02-17T23:01:11.350Z",
      "author": "steve",
      "text": "Milestone 3 turns core data into usable project operations."
    },
    {
      "created_at": "2026-03-04T14:41:02.957Z",
      "author": "unknown",
      "text": "Planned change-set: add explicit integration assertions for list-open/list-in-progress/list-blocked/list-closed/list-canceled command filtering, then update PRD Milestone 3 list checklist from [~] to [x] once verified by sandboxed coverage + regression runs."
    },
    {
      "created_at": "2026-03-04T14:42:10.797Z",
      "author": "cursor-maintainer",
      "text": "Implemented change-set: added integration coverage that seeds all lifecycle statuses and asserts list-open/list-in-progress/list-blocked/list-closed/list-canceled filtering plus list-all terminal ordering, and updated PRD Milestone 3 checklist entry for list/list-* from partial to complete."
    },
    {
      "created_at": "2026-03-04T14:42:21.685Z",
      "author": "cursor-maintainer",
      "text": "Bootstrap evidence: ensured latest project build is globally available via npm install -g /home/steve/GITHUB_RELEASE/pm-cli and verified pm --version => 0.1.0."
    },
    {
      "created_at": "2026-03-04T14:52:06.921Z",
      "author": "cursor-maintainer",
      "text": "Evidence: pm test pm-54d --run --timeout 1800 passed (2/2 linked commands). pm test-all --status in_progress --timeout 1800 passed (items=1, linked_tests=2, failed=0). pm test-all --status closed --timeout 1800 passed (items=46, linked_tests=166, failed=0, skipped=112 duplicate keys). Coverage remained 100% lines/branches/functions/statements, and new integration test case now validates list-open/list-in-progress/list-blocked/list-closed/list-canceled filtering plus list-all terminal ordering."
    }
  ],
  "notes": [
    {
      "created_at": "2026-02-17T23:01:11.350Z",
      "author": "steve",
      "text": "Success means deterministic list filter and linked command workflows."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "milestone checklist alignment"
    },
    {
      "path": "tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "note": "list status command matrix coverage"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "sandboxed 100 percent coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "sandboxed regression suite"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "dogfood workflow requirements"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative milestone checklist"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public command contract"
    }
  ]
}

Implement query commands and operational helpers.
