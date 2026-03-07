{
  "id": "pm-7pp6",
  "title": "Record explicit acceptance_criteria unset in create history metadata",
  "description": "Fix create command so --acceptance-criteria none emits explicit_unset metadata and changed_fields entry.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:core",
    "area:tests",
    "code",
    "milestone:next",
    "pm-cli",
    "priority:1",
    "tests"
  ],
  "created_at": "2026-03-05T10:25:48.247Z",
  "updated_at": "2026-03-05T10:46:26.545Z",
  "deadline": "2026-03-06T23:59:00.000Z",
  "author": "cursor-maintainer",
  "estimated_minutes": 45,
  "acceptance_criteria": "When create receives --acceptance-criteria none, changed_fields includes unset:acceptance_criteria and history message includes explicit_unset=acceptance_criteria; focused and regression tests pass with 100% coverage.",
  "dependencies": [
    {
      "id": "pm-06t",
      "kind": "related",
      "created_at": "2026-03-05T10:25:48.247Z",
      "author": "cursor-maintainer"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-05T10:25:48.247Z",
      "author": "cursor-maintainer",
      "text": "Why this exists: create currently misses explicit unset metadata for acceptance criteria when none is passed."
    },
    {
      "created_at": "2026-03-05T10:26:11.042Z",
      "author": "cursor-maintainer",
      "text": "Planned changeset: update runCreate explicitUnsets to include acceptance_criteria when --acceptance-criteria is none, then extend create-command unit coverage to assert changed_fields and history message explicit_unset metadata."
    },
    {
      "created_at": "2026-03-05T10:26:43.128Z",
      "author": "cursor-maintainer",
      "text": "Implemented code change: runCreate now records acceptance_criteria in explicitUnsets when --acceptance-criteria is none, and unit test none-semantics coverage now asserts unset:acceptance_criteria plus explicit_unset history metadata contains acceptance_criteria."
    },
    {
      "created_at": "2026-03-05T10:36:57.777Z",
      "author": "cursor-maintainer",
      "text": "Follow-up refactor to keep lint clean: replaced repeated scalar none checks with a single candidate loop and replaced JSON deep clone with structuredClone in runCreate output shaping; behavior remains unchanged besides acceptance_criteria explicit-unset parity."
    },
    {
      "created_at": "2026-03-05T10:46:26.231Z",
      "author": "cursor-maintainer",
      "text": "Evidence: pm test pm-7pp6 --run --timeout 7200 --json passed all 3 linked tests (coverage, full sandbox test suite, targeted create unit test). Coverage output remained 100% for statements/branches/functions/lines with 49/49 test files and 371/371 tests passing. Regression sweeps passed: pm test-all --status in_progress --timeout 7200 --json => items=1 linked_tests=3 passed=3 failed=0 skipped=0; pm test-all --status closed --timeout 7200 --json => items=67 linked_tests=209 passed=59 failed=0 skipped=150."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-05T10:25:48.247Z",
      "author": "cursor-maintainer",
      "text": "Plan patch runCreate explicitUnsets then add focused tests and run full regression."
    }
  ],
  "files": [
    {
      "path": "src/cli/commands/create.ts",
      "scope": "project",
      "note": "explicit unset tracking fix"
    },
    {
      "path": "tests/unit/create-command.spec.ts",
      "scope": "project",
      "note": "coverage for explicit unset metadata"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 7200,
      "note": "full sandbox coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test",
      "scope": "project",
      "timeout_seconds": 3600,
      "note": "full sandbox regression suite"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/create-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "targeted create command regression"
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
      "note": "explicit unset contract reference"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "authoritative behavior reference"
    }
  ]
}

Context: docs require explicit unset intents to be reflected in changed_fields and mutation history metadata; create currently omits acceptance_criteria when unset via none.
