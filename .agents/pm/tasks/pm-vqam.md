{
  "id": "pm-vqam",
  "title": "M5 follow-up: surface registerFlags on dynamic command help",
  "description": "Use extension registerFlags metadata to render deterministic help text for dynamically surfaced extension command paths while preserving loose option parsing behavior.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:extensions",
    "code",
    "doc",
    "milestone:5",
    "pm-cli",
    "priority:1",
    "tests"
  ],
  "created_at": "2026-03-06T10:06:02.590Z",
  "updated_at": "2026-03-06T10:32:24.287Z",
  "deadline": "2026-03-07T23:30:00.000Z",
  "author": "maintainer-agent",
  "estimated_minutes": 150,
  "acceptance_criteria": "Dynamic extension command paths include deterministic extension-provided flag help derived from registerFlags metadata. Existing dynamic command option parsing behavior remains backward-compatible. README and PRD contracts updated first. Tests cover help rendering and coverage remains 100 percent.",
  "dependencies": [
    {
      "id": "pm-iuzs",
      "kind": "related",
      "created_at": "2026-03-06T10:06:02.590Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-06T10:06:02.590Z",
      "author": "maintainer-agent",
      "text": "Why this exists move registerFlags from metadata only to visible runtime help for extension commands."
    },
    {
      "created_at": "2026-03-06T10:06:17.841Z",
      "author": "maintainer-agent",
      "text": "Planned changeset docs first update PRD and README then wire registerFlags metadata into dynamic extension command help text and add regression tests."
    },
    {
      "created_at": "2026-03-06T10:07:49.475Z",
      "author": "maintainer-agent",
      "text": "Docs-first update complete PRD and README now specify deterministic dynamic extension command help sections derived from registerFlags metadata while preserving loose option parsing behavior."
    },
    {
      "created_at": "2026-03-06T10:09:43.313Z",
      "author": "maintainer-agent",
      "text": "Implemented main.ts runtime wiring to collect registerFlags metadata per dynamic extension command and append deterministic Extension-provided flags help text while keeping allowUnknownOption loose parsing unchanged. Added integration coverage for dynamic help rendering and behavior parity in tests/integration/cli.integration.spec.ts."
    },
    {
      "created_at": "2026-03-06T10:32:14.944Z",
      "author": "maintainer-agent",
      "text": "Evidence: pm test pm-vqam --run --timeout 7200 --json passed linked tests 3 of 3 with zero failures. Regression sweeps passed: pm test-all --status in_progress --timeout 7200 --json => items 1 linked_tests 3 passed 3 failed 0 skipped 0; pm test-all --status closed --timeout 7200 --json => items 86 linked_tests 257 passed 62 failed 0 skipped 195. Coverage proof from linked sandbox coverage run remains 100 percent lines branches functions and statements."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-06T10:06:02.590Z",
      "author": "maintainer-agent",
      "text": "Plan update PRD and README first then main.ts wiring then integration and unit tests then pm verification sweeps."
    }
  ],
  "learnings": [
    {
      "created_at": "2026-03-06T10:06:02.590Z",
      "author": "maintainer-agent",
      "text": "none"
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "docs first requirement update"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "docs first requirement update"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "dynamic extension command registration wiring"
    },
    {
      "path": "tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "note": "dynamic extension help integration coverage"
    },
    {
      "path": "tests/unit/extension-loader.spec.ts",
      "scope": "project",
      "note": "flag normalization and formatting coverage"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 3600,
      "note": "sandboxed full coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "timeout_seconds": 2400,
      "note": "dynamic command integration coverage"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/extension-loader.spec.ts",
      "scope": "project",
      "timeout_seconds": 2400,
      "note": "extension registration unit regression"
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
      "note": "authoritative extension runtime contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public contract update"
    }
  ]
}

Implement docs-first runtime wiring for registerFlags metadata by surfacing extension-provided flag definitions in dynamic command help output. Keep existing loose option parser semantics unchanged to avoid command-behavior regressions.
