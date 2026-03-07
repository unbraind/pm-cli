{
  "id": "pm-mn6w",
  "title": "Release-readiness maintenance loop 2026-03-07 run 6",
  "description": "Add release-readiness contract coverage for pm close help output to keep closure-command help parity deterministic.",
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
  "created_at": "2026-03-07T09:31:15.557Z",
  "updated_at": "2026-03-07T09:42:49.794Z",
  "deadline": "2026-03-08T23:59:00.000Z",
  "author": "maintainer-agent",
  "estimated_minutes": 90,
  "acceptance_criteria": "1) release-readiness contract suite asserts pm close --help flag presence and required argument/help text semantics. 2) pm test <item> --run, pm test-all --status in_progress, and pm test-all --status closed pass. 3) coverage remains 100%.",
  "dependencies": [
    {
      "id": "pm-f0e9",
      "kind": "related",
      "created_at": "2026-03-07T09:31:15.557Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-07T09:31:15.557Z",
      "author": "maintainer-agent",
      "text": "This run exists to extend help-contract hardening to pm close."
    },
    {
      "created_at": "2026-03-07T09:31:22.670Z",
      "author": "maintainer-agent",
      "text": "Intended change-set: extend release-readiness contract tests with pm close --help assertions for required options and usage text semantics so close help cannot drift from PRD/README contract."
    },
    {
      "created_at": "2026-03-07T09:42:35.961Z",
      "author": "maintainer-agent",
      "text": "Implemented release-readiness contract hardening in tests/integration/release-readiness-contract.spec.ts: added REQUIRED_CLOSE_FLAGS and a new pm close --help assertion block validating usage text, description text, and required mutation metadata flags (--author/--message/--force)."
    },
    {
      "created_at": "2026-03-07T09:42:36.105Z",
      "author": "maintainer-agent",
      "text": "Evidence: pm test pm-mn6w --run --timeout 7200 --json passed all linked tests (3/3). pm test-all --status in_progress --timeout 7200 --json passed (items=1 linked_tests=3 passed=3 failed=0 skipped=0). pm test-all --status closed --timeout 7200 --json passed (items=119 linked_tests=321 passed=62 failed=0 skipped=259). Coverage remains 100% lines/branches/functions/statements in sandbox coverage runs."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-07T09:31:15.557Z",
      "author": "maintainer-agent",
      "text": "Plan docs parity check then targeted release-readiness test update and mandatory verification sweeps."
    }
  ],
  "files": [
    {
      "path": "tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "note": "add close help contract assertion"
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
  "close_reason": "Added close-help contract coverage; pm test, pm test-all sweeps passed; coverage remains 100%."
}

Context: all backlog items are closed; this run adds one incremental release-hardening guard for close-command help contract parity.
