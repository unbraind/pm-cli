{
  "id": "pm-2xl",
  "title": "Milestone 0 - Foundations",
  "description": "Milestone epic for scaffolding determinism and exit model.",
  "type": "Epic",
  "status": "closed",
  "priority": 0,
  "tags": [
    "area:foundations",
    "core",
    "milestone:0",
    "pm-cli"
  ],
  "created_at": "2026-02-17T23:01:10.322Z",
  "updated_at": "2026-02-22T18:34:23.791Z",
  "deadline": "2026-02-20T23:01:10.322Z",
  "author": "steve",
  "estimated_minutes": 360,
  "acceptance_criteria": "Milestone 0 checklist items are implemented and verifiable.",
  "dependencies": [
    {
      "id": "pm-j7a",
      "kind": "child",
      "created_at": "2026-02-17T23:01:10.322Z",
      "author": "steve"
    }
  ],
  "comments": [
    {
      "created_at": "2026-02-17T23:01:10.322Z",
      "author": "steve",
      "text": "Milestone 0 establishes the base architecture for later work."
    },
    {
      "created_at": "2026-02-22T18:18:40.639Z",
      "author": "maintainer-agent",
      "text": "Planned change-set: verify Milestone 0 completion against PRD checklist and current command surface, link governing docs and sandbox-safe tests, run pm test + pm test-all regressions, then close this epic with evidence if all checks pass."
    },
    {
      "created_at": "2026-02-22T18:34:23.058Z",
      "author": "maintainer-agent",
      "text": "Evidence: verified Milestone 0 PRD checklist alignment with current CLI help/README/AGENTS contracts. Validation commands: node dist/cli.js test pm-2xl --run --timeout 3600 --json => passed 2/2 linked tests (coverage + release-readiness contract). node dist/cli.js test-all --status in_progress --timeout 3600 --json => totals items=9 linked_tests=30 passed=11 failed=0 skipped=19. node dist/cli.js test-all --status closed --timeout 3600 --json => totals items=26 linked_tests=99 passed=46 failed=0 skipped=53. Coverage statement: node scripts/run-tests.mjs coverage in this run remained 100% lines/branches/functions/statements (All files 100/100/100/100). Follow-up items: none created; remaining open work continues under milestone 4/5 in-progress tasks."
    }
  ],
  "notes": [
    {
      "created_at": "2026-02-17T23:01:10.322Z",
      "author": "steve",
      "text": "Success is measured by help output config precedence and deterministic helpers."
    }
  ],
  "files": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "dogfood workflow compliance"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "milestone 0 completion source"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "command surface parity check"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 2400,
      "note": "full sandboxed coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "release-readiness integration contract"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "agent workflow and evidence protocol"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative milestone checklist"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public command/docs contract"
    }
  ]
}

Deliver baseline CLI scaffolding and deterministic primitives.
