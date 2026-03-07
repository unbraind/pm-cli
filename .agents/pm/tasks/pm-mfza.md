{
  "id": "pm-mfza",
  "title": "Add snake_case aliases for create/update acceptance and estimate flags",
  "description": "Support --acceptance_criteria and --estimated_minutes aliases alongside kebab-case flags for automation compatibility.",
  "type": "Task",
  "status": "closed",
  "priority": 0,
  "tags": [
    "area:cli",
    "area:docs",
    "code",
    "compatibility",
    "milestone:6",
    "pm-cli",
    "priority:0",
    "tests"
  ],
  "created_at": "2026-03-07T22:41:27.421Z",
  "updated_at": "2026-03-07T22:57:55.556Z",
  "deadline": "2026-03-09T23:59:00.000Z",
  "author": "maintainer-agent",
  "estimated_minutes": 90,
  "acceptance_criteria": "pm create and pm update accept --acceptance_criteria and --estimated_minutes; authoritative docs and contract tests reflect aliases; pm test plus test-all sweeps pass with 100% coverage.",
  "dependencies": [
    {
      "id": "pm-b1w",
      "kind": "related",
      "created_at": "2026-03-07T22:41:27.421Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-07T22:41:27.421Z",
      "author": "maintainer-agent",
      "text": "Why this exists automation prompts frequently emit snake_case flag names and currently require manual translation."
    },
    {
      "created_at": "2026-03-07T22:41:42.118Z",
      "author": "maintainer-agent",
      "text": "Planned change-set: update PRD and README first to document snake_case aliases for --acceptance_criteria and --estimated_minutes in create/update contracts, then wire commander option aliases and normalization, then add integration/release-contract assertions."
    },
    {
      "created_at": "2026-03-07T22:42:09.312Z",
      "author": "maintainer-agent",
      "text": "Docs-first update complete: PRD.md and README.md now declare snake_case aliases --acceptance_criteria and --estimated_minutes for create/update flag contracts before runtime implementation."
    },
    {
      "created_at": "2026-03-07T22:44:57.400Z",
      "author": "maintainer-agent",
      "text": "Initial pm test run exposed Commander alias limitations when three long flags were declared on one option. Reworked create/update alias registration to separate --estimated_minutes options and retained required create validation in normalizeCreateOptions."
    },
    {
      "created_at": "2026-03-07T22:57:55.046Z",
      "author": "maintainer-agent",
      "text": "Implemented docs-first snake_case alias parity: PRD/README now document --estimated_minutes and --acceptance_criteria for create/update contracts; CLI wiring in src/cli/main.ts now accepts these aliases via dedicated option registration plus normalization fallbacks; integration and release-readiness contract tests now cover alias runtime/help/doc behavior."
    },
    {
      "created_at": "2026-03-07T22:57:55.219Z",
      "author": "maintainer-agent",
      "text": "Evidence: pm test pm-mfza --run --timeout 7200 --json passed (3/3 linked tests including coverage). pm test-all --status in_progress --timeout 7200 --json passed (items=1 linked_tests=3 passed=3 failed=0 skipped=0). pm test-all --status closed --timeout 7200 --json passed (items=138 linked_tests=356 passed=64 failed=0 skipped=292). Coverage remains 100% lines/branches/functions/statements."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-07T22:41:27.421Z",
      "author": "maintainer-agent",
      "text": "Plan docs-first updates then CLI option wiring then integration/release contract tests."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "command contract update"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "docs-first alias contract update"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "create/update option alias wiring"
    },
    {
      "path": "tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "note": "CLI alias integration coverage"
    },
    {
      "path": "tests/integration/help-readme-contract.spec.ts",
      "scope": "project",
      "note": "README/help alignment coverage"
    },
    {
      "path": "tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "note": "help contract coverage"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 3600,
      "note": "coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "alias integration coverage"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "release-readiness contract"
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
      "note": "authoritative command contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public create/update alias documentation"
    }
  ],
  "close_reason": "Snake_case aliases for create/update estimate and acceptance criteria are implemented across docs/runtime/tests; pm test and both regression sweeps pass with 100% coverage."
}

Docs-first hardening: document and implement snake_case aliases for acceptance criteria and estimated minutes in create/update command parsing and help contracts.
