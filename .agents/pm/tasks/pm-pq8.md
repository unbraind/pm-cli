{
  "id": "pm-pq8",
  "title": "Docs contract sync for release readiness",
  "description": "Close release-readiness documentation gaps by adding required community files and syncing README/PRD/AGENTS contracts with implemented behavior.",
  "type": "Task",
  "status": "closed",
  "priority": 0,
  "tags": [
    "contracts",
    "docs",
    "pm-cli",
    "release-readiness"
  ],
  "created_at": "2026-02-17T23:37:21.381Z",
  "updated_at": "2026-02-18T01:15:08.275Z",
  "deadline": "2026-02-19T23:37:21.381Z",
  "author": "cursor-agent",
  "estimated_minutes": 180,
  "acceptance_criteria": "PRD, README, and AGENTS match implementation; LICENSE, CHANGELOG, CONTRIBUTING, SECURITY, and CODE_OF_CONDUCT exist with release-ready baseline content.",
  "dependencies": [
    {
      "id": "pm-ote",
      "kind": "parent",
      "created_at": "2026-02-17T23:37:21.381Z",
      "author": "cursor-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-02-17T23:38:07.132Z",
      "author": "cursor-agent",
      "text": "Phase 0 complete: created epic pm-ote and child items pm-pq8, pm-2c8, pm-912, pm-wo8, pm-cyj, pm-tq1 with explicit dependencies."
    },
    {
      "created_at": "2026-02-17T23:42:24.565Z",
      "author": "cursor-agent",
      "text": "Updated docs-first contracts before code behavior changes: command surface scoped to v0.1, release-ready structure defined, sandbox PM_PATH test safety codified, and release checklist added."
    },
    {
      "created_at": "2026-02-18T00:16:09.388Z",
      "author": "cursor-agent",
      "text": "Updated README installation contract with explicit npm update command and installer idempotent update guidance."
    },
    {
      "created_at": "2026-02-18T00:17:34.704Z",
      "author": "cursor-agent",
      "text": "Added AGENTS guidance to avoid linking pm test-all as an item-level test command to prevent recursive orchestration loops."
    },
    {
      "created_at": "2026-02-18T01:08:09.726Z",
      "author": "steve",
      "text": "Planned change-set: add missing release/community docs (LICENSE, CHANGELOG, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT), then verify command/docs parity and execute sandbox-safe test flow."
    },
    {
      "created_at": "2026-02-18T01:12:13.482Z",
      "author": "steve",
      "text": "Implemented docs-first release baseline: updated PRD/README/AGENTS contracts, added root community docs (LICENSE, CHANGELOG, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT), and added scripts/run-tests.mjs sandbox runner for pm-linked test execution."
    },
    {
      "created_at": "2026-02-18T01:13:45.460Z",
      "author": "steve",
      "text": "Evidence: pm test pm-pq8 --run passed (node scripts/run-tests.mjs coverage). pm test-all --status in_progress --timeout 1800 passed with totals items=7 linked_tests=9 passed=9 failed=0 skipped=0. Coverage remains 100% (lines/branches/functions/statements)."
    },
    {
      "created_at": "2026-02-18T01:14:15.245Z",
      "author": "steve",
      "text": "Follow-up: adjust README FAQ to mark restore/history commands as roadmap-only in current v0.1 surface."
    },
    {
      "created_at": "2026-02-18T01:15:07.896Z",
      "author": "steve",
      "text": "Follow-up implemented: README FAQ now marks restore/history as roadmap-only in current v0.1 surface to match --help command set. Verification rerun passed: pm test pm-pq8 --run and pm test-all --status in_progress (items=7, linked_tests=9, passed=9, failed=0). Coverage remains 100% across all enforced metrics."
    }
  ],
  "files": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "Dogfood workflow and sandbox testing rules"
    },
    {
      "path": "CHANGELOG.md",
      "scope": "project",
      "note": "required community file"
    },
    {
      "path": "CODE_OF_CONDUCT.md",
      "scope": "project",
      "note": "recommended conduct policy"
    },
    {
      "path": "CONTRIBUTING.md",
      "scope": "project",
      "note": "required community file"
    },
    {
      "path": "LICENSE",
      "scope": "project",
      "note": "required community file"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "Authoritative command surface and test policy updates"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "Docs-first release contract alignment"
    },
    {
      "path": "scripts/run-tests.mjs",
      "scope": "project",
      "note": "sandbox-safe pm-linked test runner"
    },
    {
      "path": "SECURITY.md",
      "scope": "project",
      "note": "recommended security policy"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "Sandbox coverage gate for docs and release baseline"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "Contributor workflow contract"
    },
    {
      "path": "CHANGELOG.md",
      "scope": "project",
      "note": "release changelog baseline"
    },
    {
      "path": "CODE_OF_CONDUCT.md",
      "scope": "project",
      "note": "contributor conduct policy"
    },
    {
      "path": "CONTRIBUTING.md",
      "scope": "project",
      "note": "contributor workflow and testing"
    },
    {
      "path": "LICENSE",
      "scope": "project",
      "note": "MIT license baseline"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "Authoritative behavior contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "Public contract sync"
    },
    {
      "path": "SECURITY.md",
      "scope": "project",
      "note": "security reporting policy"
    }
  ]
}

Authoritative contracts must stay ahead of implementation. This task owns docs-first updates and final sync for release readiness.
