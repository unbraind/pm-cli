{
  "id": "pm-ex1y",
  "title": "Add list-draft command parity for draft status",
  "description": "Add a dedicated list-draft command to make draft lifecycle selection symmetrical with other status list commands.",
  "type": "Task",
  "status": "closed",
  "priority": 0,
  "tags": [
    "area:cli",
    "code",
    "docs",
    "milestone:3",
    "pm-cli",
    "priority:0",
    "tests"
  ],
  "created_at": "2026-03-06T23:44:33.076Z",
  "updated_at": "2026-03-07T00:04:49.101Z",
  "deadline": "2026-03-10T23:59:00.000Z",
  "author": "maintainer-agent",
  "estimated_minutes": 90,
  "acceptance_criteria": "pm list-draft is available in help, returns only draft items with existing list filters, docs are updated first, and regression + coverage remain 100%.",
  "dependencies": [
    {
      "id": "pm-54d",
      "kind": "related",
      "created_at": "2026-03-06T23:44:33.076Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-06T23:44:33.076Z",
      "author": "maintainer-agent",
      "text": "Draft is a canonical status but lacks a dedicated list command; add parity command for agent workflow loops."
    },
    {
      "created_at": "2026-03-06T23:45:01.873Z",
      "author": "maintainer-agent",
      "text": "Planned change-set: update PRD and README command matrices first, then add list-draft command wiring in CLI and extend integration contract tests for draft-status listing and help output."
    },
    {
      "created_at": "2026-03-06T23:51:54.384Z",
      "author": "maintainer-agent",
      "text": "Implemented docs-first + code changes: added list-draft to PRD/README command contracts, registered list-draft command in CLI, added Pi wrapper action mapping for list-draft, and expanded integration/unit tests for draft-status listing behavior."
    },
    {
      "created_at": "2026-03-07T00:04:48.775Z",
      "author": "maintainer-agent",
      "text": "Evidence: pnpm build passed. pm test pm-ex1y --run --timeout 7200 --json passed (3/3 linked tests). pm test-all --status in_progress --timeout 7200 --json passed (items=1 linked_tests=3 passed=3 failed=0 skipped=0). pm test-all --status closed --timeout 7200 --json passed (items=113 linked_tests=307 passed=63 failed=0 skipped=244). Coverage remains 100% lines/branches/functions/statements in sandbox coverage runs."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-06T23:44:33.076Z",
      "author": "maintainer-agent",
      "text": "Docs-first then CLI registration then integration/unit test coverage."
    }
  ],
  "files": [
    {
      "path": ".pi/extensions/pm-cli/index.ts",
      "scope": "project",
      "note": "pi action mapping parity for list-draft"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "command contract includes list-draft"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "document list-draft command"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "add list-draft command registration"
    },
    {
      "path": "tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "note": "integration coverage for list-draft"
    },
    {
      "path": "tests/unit/pi-agent-extension.spec.ts",
      "scope": "project",
      "note": "list-draft wrapper action coverage"
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
      "command": "node scripts/run-tests.mjs test",
      "scope": "project",
      "timeout_seconds": 3600,
      "note": "full sandbox regression"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "cli command surface regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "agent workflow command usage"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "command surface contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public command surface"
    }
  ],
  "close_reason": "Added list-draft command parity across CLI/docs/Pi wrapper with passing regression and 100% coverage."
}

Implement list-draft command wiring, documentation, and tests while preserving deterministic list filtering behavior.
