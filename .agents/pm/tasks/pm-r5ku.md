{
  "id": "pm-r5ku",
  "title": "M4: Strict keyword search filter validation parity",
  "description": "Harden keyword search filter parsing to reject invalid type and non-integer priority values for deterministic CLI behavior.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:search-keyword",
    "code",
    "milestone:4",
    "pm-cli",
    "priority:1",
    "tests"
  ],
  "created_at": "2026-02-22T14:11:09.924Z",
  "updated_at": "2026-02-22T14:31:39.973Z",
  "deadline": "2026-02-25T23:59:00.000Z",
  "author": "maintainer-agent",
  "estimated_minutes": 90,
  "acceptance_criteria": "runSearch rejects invalid type and non-integer priority inputs with EXIT_CODE.USAGE and regression tests keep coverage at 100%.",
  "dependencies": [
    {
      "id": "pm-f45",
      "kind": "parent",
      "created_at": "2026-02-22T14:11:09.924Z",
      "author": "maintainer-agent"
    },
    {
      "id": "pm-pmd",
      "kind": "related",
      "created_at": "2026-02-22T14:11:09.924Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-02-22T14:11:09.924Z",
      "author": "maintainer-agent",
      "text": "Gap found in search filter validation branch coverage and strictness."
    },
    {
      "created_at": "2026-02-22T14:11:30.945Z",
      "author": "maintainer-agent",
      "text": "Planned change-set: enforce strict search filter parsing parity with list (validate type enum and integer priority), then add focused unit coverage and run full pm-linked regression commands."
    },
    {
      "created_at": "2026-02-22T14:12:23.730Z",
      "author": "maintainer-agent",
      "text": "Docs-first sync complete: README and PRD now explicitly state search shared filter validation for type enum and integer priority parity with canonical item semantics."
    },
    {
      "created_at": "2026-02-22T14:13:15.507Z",
      "author": "maintainer-agent",
      "text": "Implemented code change: runSearch now validates --type via canonical enum parsing and enforces integer-only --priority 0..4, with unit tests updated for invalid type, fractional priority rejection, and lowercase type normalization."
    },
    {
      "created_at": "2026-02-22T14:30:32.654Z",
      "author": "maintainer-agent",
      "text": "Evidence: node dist/cli.js test pm-r5ku --run --timeout 3600 --json passed all linked tests (coverage plus targeted search unit suite). Regression sweeps passed: node dist/cli.js test-all --status in_progress --timeout 3600 --json => items=11 linked_tests=37 passed=15 failed=0 skipped=22; node dist/cli.js test-all --status closed --timeout 3600 --json => items=22 linked_tests=86 passed=42 failed=0 skipped=44. Coverage proof remained 100% lines branches functions and statements."
    },
    {
      "created_at": "2026-02-22T14:31:39.973Z",
      "author": "maintainer-agent",
      "text": "Post-regression verification: pnpm build passed after merged search filter validation updates."
    }
  ],
  "notes": [
    {
      "created_at": "2026-02-22T14:11:09.924Z",
      "author": "maintainer-agent",
      "text": "Implement parser parity with list and add targeted tests."
    }
  ],
  "learnings": [
    {
      "created_at": "2026-02-22T14:11:09.924Z",
      "author": "maintainer-agent",
      "text": "Keyword filter semantics should remain deterministic across commands."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative search filter validation note"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "docs-first search filter contract"
    },
    {
      "path": "src/cli/commands/search.ts",
      "scope": "project",
      "note": "search filter parsing update"
    },
    {
      "path": "tests/unit/search-command.spec.ts",
      "scope": "project",
      "note": "strict filter parsing regressions"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 900,
      "note": "coverage gate regression"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/search-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 300,
      "note": "search regression suite"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "dogfood and testing protocol"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "governing command contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "search command public contract"
    }
  ]
}

Align runSearch filter parsing with list command validation semantics so invalid filter inputs fail fast with usage errors.
