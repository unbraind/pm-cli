{
  "id": "pm-kwl",
  "title": "M3: comments files docs and test commands",
  "description": "Implement linked metadata commands and normalize test seed timeout aliases for doc parity.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:linked-ops",
    "core",
    "milestone:3",
    "pm-cli"
  ],
  "created_at": "2026-02-17T23:02:09.505Z",
  "updated_at": "2026-02-18T02:01:02.528Z",
  "deadline": "2026-03-03T23:02:09.505Z",
  "author": "steve",
  "estimated_minutes": 150,
  "acceptance_criteria": "comments/files/docs/test flows are deterministic and both timeout and timeout_seconds seed keys parse to timeout_seconds metadata.",
  "dependencies": [
    {
      "id": "pm-54d",
      "kind": "parent",
      "created_at": "2026-02-17T23:02:09.505Z",
      "author": "steve"
    },
    {
      "id": "pm-c0r",
      "kind": "blocks",
      "created_at": "2026-02-17T23:02:09.505Z",
      "author": "steve"
    }
  ],
  "comments": [
    {
      "created_at": "2026-02-18T01:57:47.015Z",
      "author": "cursor-maintainer",
      "text": "Planned change-set: align linked test seed parsing with docs by accepting timeout alias and canonical timeout_seconds, update docs examples for deterministic guidance, and add integration coverage for alias behavior."
    },
    {
      "created_at": "2026-02-18T02:01:01.979Z",
      "author": "cursor-maintainer",
      "text": "Implemented timeout alias parity for linked test seeds: create/test command parsers now accept timeout (legacy) and timeout_seconds (canonical), rejecting mismatched dual values for deterministic behavior."
    },
    {
      "created_at": "2026-02-18T02:01:02.140Z",
      "author": "cursor-maintainer",
      "text": "Evidence: pnpm build passed. pm test pm-kwl --run --timeout 600 --json passed linked commands (sandboxed integration + sandboxed coverage) with coverage at 100% lines/branches/functions/statements. pm test-all --status in_progress --timeout 600 --json passed totals items=6 linked_tests=11 passed=11 failed=0 skipped=0."
    }
  ],
  "files": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "align command recipe timeout key wording"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "align linked test seed examples"
    },
    {
      "path": "src/commands/create.ts",
      "scope": "project",
      "note": "normalize test seed timeout alias on create path"
    },
    {
      "path": "src/commands/test.ts",
      "scope": "project",
      "note": "accept timeout alias in linked test seed parser"
    },
    {
      "path": "tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "note": "assert timeout alias accepted in create test seed"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 600,
      "note": "full coverage regression gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "timeout_seconds": 360,
      "note": "integration coverage for timeout alias"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "dogfood command recipe alignment"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "canonical seed schema and command contracts"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "quickstart linked test examples"
    }
  ]
}

Implement comment and linked artifact command handlers.
