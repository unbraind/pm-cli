{
  "id": "pm-a5ea",
  "title": "Release-readiness maintenance loop 2026-03-07 run 8",
  "description": "Add release-readiness contract coverage for pm delete help output to keep delete mutation metadata parity deterministic.",
  "type": "Task",
  "status": "closed",
  "priority": 0,
  "tags": [
    "area:cli",
    "area:docs",
    "area:tests",
    "code",
    "doc",
    "milestone:6",
    "pm-cli",
    "priority:0",
    "tests"
  ],
  "created_at": "2026-03-07T10:12:40.909Z",
  "updated_at": "2026-03-07T10:24:11.962Z",
  "deadline": "2026-03-08T23:59:00.000Z",
  "author": "maintainer-agent",
  "estimated_minutes": 90,
  "acceptance_criteria": "1) release-readiness contract suite asserts pm delete --help metadata flags and usage semantics. 2) pm test <item> --run plus pm test-all sweeps for in_progress and closed pass. 3) coverage remains 100%.",
  "dependencies": [
    {
      "id": "pm-wjdr",
      "kind": "related",
      "created_at": "2026-03-07T10:12:40.909Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-07T10:12:40.909Z",
      "author": "maintainer-agent",
      "text": "This run exists to extend help-contract hardening to pm delete."
    },
    {
      "created_at": "2026-03-07T10:12:50.847Z",
      "author": "maintainer-agent",
      "text": "Intended change-set: extend release-readiness contract tests with pm delete --help assertions for required metadata flags and usage/description semantics."
    },
    {
      "created_at": "2026-03-07T10:13:05.917Z",
      "author": "maintainer-agent",
      "text": "Implemented release-readiness contract hardening in tests/integration/release-readiness-contract.spec.ts: added REQUIRED_DELETE_FLAGS and a new pm delete --help assertion block validating PRD row parity, usage text, description text, and required mutation metadata flags."
    },
    {
      "created_at": "2026-03-07T10:24:11.658Z",
      "author": "maintainer-agent",
      "text": "Evidence: pnpm build passed. pm test pm-a5ea --run --timeout 7200 --json passed all linked tests (3/3). pm test-all --status in_progress --timeout 7200 --json passed (items=1 linked_tests=3 passed=3 failed=0 skipped=0). pm test-all --status closed --timeout 7200 --json passed (items=121 linked_tests=327 passed=62 failed=0 skipped=265). Coverage remains 100% lines/branches/functions/statements (All files 100/100/100/100)."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-07T10:12:40.909Z",
      "author": "maintainer-agent",
      "text": "Plan docs parity check then targeted release-readiness test update and mandatory verification sweeps."
    }
  ],
  "files": [
    {
      "path": "tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "note": "delete help contract assertion"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 2400,
      "note": "coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test",
      "scope": "project",
      "timeout_seconds": 240,
      "note": "sandbox-safe regression"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "targeted contract regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "maintainer workflow contract"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative delete command contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public delete command contract"
    }
  ],
  "close_reason": "Added delete-help contract coverage; pm test and test-all sweeps passed; coverage remains 100%."
}

Audit delete command contract parity across PRD/README/help, add focused assertion, then run mandatory pm test sweeps with coverage evidence.
