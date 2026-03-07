{
  "id": "pm-wjdr",
  "title": "Release-readiness maintenance loop 2026-03-07 run 7",
  "description": "Add release-readiness contract coverage for pm append help output to keep append mutation help parity deterministic.",
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
  "created_at": "2026-03-07T09:48:11.508Z",
  "updated_at": "2026-03-07T10:01:41.917Z",
  "deadline": "2026-03-08T23:59:00.000Z",
  "author": "maintainer-agent",
  "estimated_minutes": 90,
  "acceptance_criteria": "1) release-readiness contract suite asserts pm append --help required flag and usage semantics. 2) pm test <item> --run plus pm test-all sweeps for in_progress and closed pass. 3) coverage remains 100%.",
  "dependencies": [
    {
      "id": "pm-mn6w",
      "kind": "related",
      "created_at": "2026-03-07T09:48:11.508Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-07T09:48:11.508Z",
      "author": "maintainer-agent",
      "text": "This run exists to extend help-contract hardening to pm append."
    },
    {
      "created_at": "2026-03-07T09:48:19.900Z",
      "author": "maintainer-agent",
      "text": "Intended change-set: extend release-readiness contract tests with pm append --help assertions for required flags and usage/description text semantics."
    },
    {
      "created_at": "2026-03-07T09:50:31.157Z",
      "author": "maintainer-agent",
      "text": "Implemented release-readiness contract hardening in tests/integration/release-readiness-contract.spec.ts: added REQUIRED_APPEND_FLAGS and a new pm append --help assertion block validating usage text, description text, required flags, and PRD command-contract row parity."
    },
    {
      "created_at": "2026-03-07T10:01:36.543Z",
      "author": "maintainer-agent",
      "text": "Evidence: pnpm build passed. pm test pm-wjdr --run --timeout 7200 --json passed all linked tests (3/3). pm test-all --status in_progress --timeout 7200 --json passed (items=1 linked_tests=3 passed=3 failed=0 skipped=0). pm test-all --status closed --timeout 7200 --json passed (items=120 linked_tests=324 passed=62 failed=0 skipped=262). Coverage remains 100% lines/branches/functions/statements in sandbox coverage runs."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-07T09:48:11.508Z",
      "author": "maintainer-agent",
      "text": "Plan docs parity check then targeted release-readiness test update and mandatory verification sweeps."
    }
  ],
  "files": [
    {
      "path": "tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "note": "append help contract assertion"
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
      "note": "authoritative command/help determinism contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public command contract"
    }
  ],
  "close_reason": "Added append-help contract coverage; pm test and test-all sweeps passed; coverage remains 100%."
}

Audit docs/help parity for append mutation metadata contract, then harden release-readiness assertions and verify through mandatory pm test sweeps.
