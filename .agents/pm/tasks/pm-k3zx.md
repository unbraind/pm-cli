{
  "id": "pm-k3zx",
  "title": "Harden recursive test-all detection for global-flag invocation forms",
  "description": "Prevent pm test linked-command recursion bypass when test-all is invoked with global flags before the subcommand and keep runtime skip parity.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:test-command",
    "code",
    "milestone:root",
    "pm-cli",
    "priority:1",
    "tests"
  ],
  "created_at": "2026-03-04T18:43:55.776Z",
  "updated_at": "2026-03-04T19:08:10.823Z",
  "deadline": "2026-03-06T23:59:00.000Z",
  "author": "cursor-maintainer",
  "estimated_minutes": 75,
  "acceptance_criteria": "Met: linked test commands invoking test-all via pm, npx pm-cli/pm, node dist/cli.js, and global-flag variants are rejected or runtime-skipped deterministically; regression tests and coverage gate pass at 100 percent.",
  "dependencies": [
    {
      "id": "pm-j7a",
      "kind": "parent",
      "created_at": "2026-03-04T18:43:55.776Z",
      "author": "cursor-maintainer"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-04T18:43:55.776Z",
      "author": "cursor-maintainer",
      "text": "This task hardens recursive test-all guard coverage for flag-before-subcommand invocation forms."
    },
    {
      "created_at": "2026-03-04T18:44:09.466Z",
      "author": "cursor-maintainer",
      "text": "Planned changeset: replace substring recursion checks with token-aware invocation parsing so pm/npx/node forms still detect test-all when global flags precede the subcommand; add unit regressions for add-time rejection and runtime skip parity."
    },
    {
      "created_at": "2026-03-04T18:45:09.446Z",
      "author": "cursor-maintainer",
      "text": "Docs-first alignment completed before implementation: clarified PRD README and AGENTS that recursive pm test-all detection and runtime skip rules include global-flag invocation forms such as pm --json test-all."
    },
    {
      "created_at": "2026-03-04T19:08:10.303Z",
      "author": "cursor-maintainer",
      "text": "Implemented token-aware recursive test-all detection in src/cli/commands/test.ts for pm, node dist/cli.js, direct dist/cli.js, and npx pm-cli/pm forms with global-flag and env-prefix handling; added regression scenarios in tests/unit/test-command.spec.ts for add-time rejection and runtime skip parity."
    },
    {
      "created_at": "2026-03-04T19:08:10.479Z",
      "author": "cursor-maintainer",
      "text": "Evidence: pm test pm-k3zx --run --timeout 1800 --json passed (linked_tests=2 passed=2 failed=0) including node scripts/run-tests.mjs coverage at 100 percent lines/branches/functions/statements; pm test-all --status in_progress --timeout 1800 --json passed (items=1 linked_tests=2 passed=2 failed=0); pm test-all --status closed --timeout 1800 --json passed (items=53 linked_tests=177 passed=56 failed=0 skipped=121)."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-04T18:43:55.776Z",
      "author": "cursor-maintainer",
      "text": "Implement parser-safe detection then add unit tests for add-time rejection and runtime skip parity."
    }
  ],
  "learnings": [
    {
      "created_at": "2026-03-04T18:43:55.776Z",
      "author": "cursor-maintainer",
      "text": "Safety guards should parse invocation tokens rather than rely on substring matching for CLI command detection."
    }
  ],
  "files": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "docs-first recursion guard clarification"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "docs-first recursion guard clarification"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "docs-first recursion guard clarification"
    },
    {
      "path": "src/cli/commands/test.ts",
      "scope": "project",
      "note": "recursive invocation detection logic"
    },
    {
      "path": "tests/unit/test-command.spec.ts",
      "scope": "project",
      "note": "regression coverage for recursion variants"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "full coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/test-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 240,
      "note": "targeted regression coverage"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "dogfood and test safety requirements"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative test safety contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public command safety contract"
    }
  ]
}

Context: runTest currently blocks obvious recursive test-all forms but misses global-flag-before-subcommand variants. Approach: strengthen command token parsing for pm, npx pm-cli, and node dist/cli.js forms, and add regression tests for add-time rejection plus runtime skip behavior.
