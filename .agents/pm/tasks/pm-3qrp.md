{
  "id": "pm-3qrp",
  "title": "Add --ac alias parity for pm update acceptance criteria",
  "description": "Support --ac as an alias for --acceptance-criteria on pm update and keep docs/contracts aligned.",
  "type": "Task",
  "status": "closed",
  "priority": 0,
  "tags": [
    "area:cli",
    "area:docs",
    "code",
    "doc",
    "milestone:1",
    "pm-cli",
    "priority:0",
    "tests"
  ],
  "created_at": "2026-03-07T11:19:34.615Z",
  "updated_at": "2026-03-07T11:35:24.602Z",
  "deadline": "2026-03-09T23:59:00.000Z",
  "author": "maintainer-agent",
  "estimated_minutes": 90,
  "acceptance_criteria": "pm update accepts --ac as alias for --acceptance-criteria; help/docs mention alias; regression and release-readiness contract tests pass with 100% coverage unchanged.",
  "dependencies": [
    {
      "id": "pm-cujj",
      "kind": "related",
      "created_at": "2026-03-07T11:19:34.615Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-07T11:19:34.615Z",
      "author": "maintainer-agent",
      "text": "Gap discovered during release-readiness audit update accepts only --acceptance-criteria while create already supports --ac alias."
    },
    {
      "created_at": "2026-03-07T11:19:40.777Z",
      "author": "maintainer-agent",
      "text": "Intended change-set: update PRD and README update-option contracts to include --ac alias, then wire Commander option/normalizeUpdateOptions alias handling and add integration assertions for help and alias behavior."
    },
    {
      "created_at": "2026-03-07T11:35:24.445Z",
      "author": "maintainer-agent",
      "text": "Evidence: tests passed, coverage remains 100%."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-07T11:19:34.615Z",
      "author": "maintainer-agent",
      "text": "Implement docs-first then CLI normalizeUpdateOptions alias wiring and integration test assertions."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "update command contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public update command contract"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "update alias option wiring"
    },
    {
      "path": "tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "note": "update alias behavior regression"
    },
    {
      "path": "tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "note": "update help contract regression"
    },
    {
      "path": "tests/integration/run-tests-script.integration.spec.ts",
      "scope": "project",
      "note": "fixed vitest output check"
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
      "note": "update alias integration"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "contract parity regression"
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
      "note": "public command contract"
    }
  ],
  "close_reason": "pm update --ac alias parity works with tests passing"
}

Docs-first parity hardening: add --ac alias support to pm update, align command help and authoritative docs, and extend regression coverage.
