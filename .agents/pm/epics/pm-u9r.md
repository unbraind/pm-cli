{
  "id": "pm-u9r",
  "title": "Milestone 1 - Core Item CRUD + Locking",
  "description": "Milestone epic for schema item IO ID strategy lock safety and base CRUD commands.",
  "type": "Epic",
  "status": "closed",
  "priority": 0,
  "tags": [
    "area:core-crud",
    "core",
    "milestone:1",
    "pm-cli"
  ],
  "created_at": "2026-02-17T23:01:10.609Z",
  "updated_at": "2026-03-04T14:14:42.360Z",
  "deadline": "2026-02-23T23:01:10.609Z",
  "author": "steve",
  "estimated_minutes": 540,
  "acceptance_criteria": "Milestone 1 checklist items are implemented and deterministic.",
  "dependencies": [
    {
      "id": "pm-2xl",
      "kind": "blocks",
      "created_at": "2026-02-17T23:01:10.609Z",
      "author": "steve"
    },
    {
      "id": "pm-j7a",
      "kind": "child",
      "created_at": "2026-02-17T23:01:10.609Z",
      "author": "steve"
    }
  ],
  "comments": [
    {
      "created_at": "2026-02-17T23:01:10.609Z",
      "author": "steve",
      "text": "Milestone 1 builds on milestone 0 foundations for core mutation workflows."
    },
    {
      "created_at": "2026-03-04T13:54:51.333Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: verify Milestone 1 completion against PRD core CRUD+locking checklist and current CLI command surface, then run mandatory pm test + pm test-all sweeps and close with evidence if all checks pass."
    },
    {
      "created_at": "2026-03-04T14:04:24.700Z",
      "author": "maintainer-agent",
      "text": "Evidence: verified Milestone 1 PRD checklist against current CLI command surface (pm --help includes create/get/update/append/claim/release/close/delete + lock-safe mutation workflow). Mandatory item run passed: pm test pm-u9r --run --timeout 7200 --json => linked tests passed=3 failed=0 skipped=0. Regression sweeps passed: pm test-all --status in_progress --timeout 7200 --json => totals items=2 linked_tests=9 passed=7 failed=0 skipped=2; pm test-all --status closed --timeout 7200 --json => totals items=44 linked_tests=157 passed=54 failed=0 skipped=103. Coverage proof: sandboxed coverage outputs report 100% lines/branches/functions/statements (All files 100/100/100/100). Follow-up items created: none."
    },
    {
      "created_at": "2026-03-04T14:14:42.360Z",
      "author": "maintainer-agent",
      "text": "Post-close compliance rerun after closure metadata updates: pm test pm-u9r --run --timeout 7200 --json passed (linked tests passed=3 failed=0 skipped=0). pm test-all --status in_progress --timeout 7200 --json passed totals items=1 linked_tests=6 passed=5 failed=0 skipped=1. pm test-all --status closed --timeout 7200 --json passed totals items=45 linked_tests=160 passed=54 failed=0 skipped=106. Coverage proof remains 100% lines/branches/functions/statements (All files 100/100/100/100)."
    }
  ],
  "notes": [
    {
      "created_at": "2026-02-17T23:01:10.609Z",
      "author": "steve",
      "text": "Success means atomic CRUD with lock conflict handling and deterministic output."
    }
  ],
  "files": [
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "CRUD command wiring in CLI surface"
    },
    {
      "path": "src/core/item/id.ts",
      "scope": "project",
      "note": "id normalization and generation"
    },
    {
      "path": "src/core/lock/lock.ts",
      "scope": "project",
      "note": "lock semantics and stale lock handling"
    },
    {
      "path": "src/core/store/item-store.ts",
      "scope": "project",
      "note": "core CRUD persistence and atomic writes"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 3600,
      "note": "full sandboxed coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "CRUD lock lifecycle integration matrix"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/core-item-lock-coverage.spec.ts",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "core lock branch coverage"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "agent workflow contract"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "governing spec for milestone 1"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "user-facing command surface contract"
    }
  ]
}

Implement core CRUD and locking semantics on item files.
