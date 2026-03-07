{
  "id": "pm-iziy",
  "title": "Release-readiness maintenance loop 2026-03-07 run 4",
  "description": "Remove synthetic default-array help text from files/docs repeatable flags and enforce contract tests.",
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
  "created_at": "2026-03-07T08:03:43.005Z",
  "updated_at": "2026-03-07T08:16:32.225Z",
  "deadline": "2026-03-08T23:59:00.000Z",
  "author": "maintainer-agent",
  "estimated_minutes": 120,
  "acceptance_criteria": "1) files/docs help no longer shows synthetic default-array text for --add/--remove. 2) release-readiness contract test covers this expectation. 3) pm test, pm test-all sweeps, and coverage remain green.",
  "dependencies": [
    {
      "id": "pm-204c",
      "kind": "related",
      "created_at": "2026-03-07T08:03:43.005Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-07T08:03:43.005Z",
      "author": "maintainer-agent",
      "text": "This run continues release-readiness hardening with one targeted help-contract fix for files/docs."
    },
    {
      "created_at": "2026-03-07T08:04:03.806Z",
      "author": "maintainer-agent",
      "text": "Intended change-set: remove misleading default-array help rendering from pm files/pm docs --add and --remove options, and add release-readiness contract assertions so this text cannot regress."
    },
    {
      "created_at": "2026-03-07T08:04:43.181Z",
      "author": "maintainer-agent",
      "text": "Implemented help-contract hardening in src/cli/main.ts by removing default [] registrations for files/docs --add and --remove options so command help no longer emits synthetic default-array text while runtime add/remove fallback remains unchanged."
    },
    {
      "created_at": "2026-03-07T08:04:43.216Z",
      "author": "maintainer-agent",
      "text": "Added regression coverage in tests/integration/release-readiness-contract.spec.ts: new assertion block verifies pm files --help and pm docs --help include required flags and omit '(default: [])' text for repeatable options."
    },
    {
      "created_at": "2026-03-07T08:16:20.165Z",
      "author": "maintainer-agent",
      "text": "Evidence: pm test pm-iziy --run --timeout 7200 --json passed all linked tests (3/3). pm test-all --status in_progress --timeout 7200 --json passed (items=1 linked_tests=3 passed=3 failed=0 skipped=0). pm test-all --status closed --timeout 7200 --json passed (items=117 linked_tests=315 passed=62 failed=0 skipped=253). Coverage remains 100% lines/branches/functions/statements in sandbox coverage runs."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-07T08:03:43.005Z",
      "author": "maintainer-agent",
      "text": "Plan docs/help parity patch then regression tests and mandatory pm test sweeps"
    }
  ],
  "files": [
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "help option wiring parity target"
    },
    {
      "path": "tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "note": "help contract regression coverage"
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
      "note": "sandbox-safe regression runner"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "targeted release-readiness contract"
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
      "note": "authoritative requirements baseline"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public command contract"
    }
  ],
  "close_reason": "files/docs help output no longer shows synthetic default-array text and contract coverage is enforced"
}

Execute one idempotent release-hardening change-set with full dogfood tracking.
