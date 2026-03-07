{
  "id": "pm-9lc",
  "title": "M2: Restore by timestamp or version with replay and hash validation",
  "description": "Implement restore replay engine with integrity checks and restore event append.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:restore",
    "core",
    "milestone:2",
    "pm-cli"
  ],
  "created_at": "2026-02-17T23:02:09.056Z",
  "updated_at": "2026-02-18T02:27:36.418Z",
  "deadline": "2026-02-27T23:02:09.056Z",
  "author": "steve",
  "estimated_minutes": 180,
  "acceptance_criteria": "Restore reproduces target state and appends restore history event.",
  "dependencies": [
    {
      "id": "pm-c0r",
      "kind": "parent",
      "created_at": "2026-02-17T23:02:09.056Z",
      "author": "steve"
    },
    {
      "id": "pm-u9r",
      "kind": "blocks",
      "created_at": "2026-02-17T23:02:09.056Z",
      "author": "steve"
    }
  ],
  "comments": [
    {
      "created_at": "2026-02-18T02:07:53.911Z",
      "author": "steve",
      "text": "Planned change-set: add pm restore command with timestamp/version target resolution, deterministic history replay with hash verification, atomic item rewrite, and appended restore history event. Update PRD/README command matrix before wiring implementation and add unit+integration coverage in sandbox tests."
    },
    {
      "created_at": "2026-02-18T02:24:17.663Z",
      "author": "steve",
      "text": "Implemented pm restore end-to-end: added src/commands/restore.ts with timestamp/version target resolution, RFC6902 replay with before/after hash verification, assignment/lock enforcement, atomic restore write, rollback-on-history-append-failure, and restore history event append. Wired CLI surface via src/cli/main.ts + src/cli/commands/index.ts and updated README/PRD command contracts before implementation. Verification: pm test pm-9lc --run --timeout 900 --json passed all 3 linked sandbox commands; coverage command reports 100% lines/branches/functions/statements for list.ts, restore.ts, test-all.ts. Regression: pm test-all --status in_progress --timeout 900 --json => totals items=6 linked_tests=12 passed=12 failed=0 skipped=0."
    },
    {
      "created_at": "2026-02-18T02:27:36.418Z",
      "author": "steve",
      "text": "Post-close verification after final PRD checklist update: pm test pm-9lc --run --timeout 900 --json reran all linked sandbox commands and all passed (coverage + integration + restore-unit); pm test-all --status in_progress --timeout 900 --json reran with totals items=6 linked_tests=12 passed=12 failed=0 skipped=0. Coverage remains 100% lines/branches/functions/statements."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "update milestone and command matrix"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "document restore command availability"
    },
    {
      "path": "src/cli/commands/index.ts",
      "scope": "project",
      "note": "export runRestore for CLI wiring"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "wire restore command"
    },
    {
      "path": "src/commands/restore.ts",
      "scope": "project",
      "note": "restore command implementation"
    },
    {
      "path": "tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "note": "restore end-to-end validation"
    },
    {
      "path": "tests/unit/restore-command.spec.ts",
      "scope": "project",
      "note": "restore command unit coverage"
    },
    {
      "path": "vitest.config.ts",
      "scope": "project",
      "note": "include restore command in enforced 100 percent coverage set"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 600,
      "note": "full coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "timeout_seconds": 360,
      "note": "restore integration coverage"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/restore-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 240,
      "note": "restore unit coverage"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "dogfood tracking rules"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "governing spec"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public command surface"
    }
  ]
}

Build replay restore command with verification and atomic writes.
