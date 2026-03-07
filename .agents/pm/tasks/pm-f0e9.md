{
  "id": "pm-f0e9",
  "title": "Release-readiness maintenance loop 2026-03-07 run 5",
  "description": "Add release-readiness contract coverage for pm comments help output to keep command help parity deterministic.",
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
  "created_at": "2026-03-07T08:20:06.195Z",
  "updated_at": "2026-03-07T08:31:44.192Z",
  "deadline": "2026-03-08T23:59:00.000Z",
  "author": "maintainer-agent",
  "estimated_minutes": 90,
  "acceptance_criteria": "1) release-readiness contract suite asserts pm comments --help flag presence and no synthetic default-array text. 2) pm test <item> --run, pm test-all --status in_progress, and pm test-all --status closed pass. 3) coverage remains 100%.",
  "dependencies": [
    {
      "id": "pm-iziy",
      "kind": "related",
      "created_at": "2026-03-07T08:20:06.195Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-07T08:20:06.195Z",
      "author": "maintainer-agent",
      "text": "This run exists to extend help-contract hardening to pm comments."
    },
    {
      "created_at": "2026-03-07T08:20:16.114Z",
      "author": "maintainer-agent",
      "text": "Intended change-set: extend release-readiness contract tests with pm comments --help assertions for required flags and synthetic default-array absence."
    },
    {
      "created_at": "2026-03-07T08:20:44.913Z",
      "author": "maintainer-agent",
      "text": "Implemented release-readiness contract hardening in tests/integration/release-readiness-contract.spec.ts: added REQUIRED_COMMENTS_FLAGS and a new pm comments --help assertion block checking required flags and absence of synthetic default-array text."
    },
    {
      "created_at": "2026-03-07T08:31:43.888Z",
      "author": "maintainer-agent",
      "text": "Evidence: pm test pm-f0e9 --run --timeout 7200 --json passed all linked tests (3/3). pm test-all --status in_progress --timeout 7200 --json passed (items=1 linked_tests=3 passed=3 failed=0 skipped=0). pm test-all --status closed --timeout 7200 --json passed (items=118 linked_tests=318 passed=62 failed=0 skipped=256). Coverage remains 100% lines/branches/functions/statements in sandbox runs."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-07T08:20:06.195Z",
      "author": "maintainer-agent",
      "text": "Plan docs parity check then targeted release-readiness test update and mandatory verification sweeps."
    }
  ],
  "files": [
    {
      "path": "tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "note": "add comments help contract assertion"
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
  "close_reason": "Added pm comments help contract coverage and all required pm regression sweeps passed with 100% coverage."
}

Context: no active backlog items remain, so this loop adds one incremental release-hardening guard. Approach: assert pm comments --help includes required flags and does not emit synthetic default-array text.
