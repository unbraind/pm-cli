{
  "id": "pm-iuzs",
  "title": "M5 follow-up: Extension API registration surface baseline",
  "description": "Implement deterministic ExtensionApi registration methods for flags schema migrations importers exporters search providers and vector adapters with activation diagnostics.",
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
  "created_at": "2026-03-05T20:15:49.066Z",
  "updated_at": "2026-03-05T20:33:02.205Z",
  "deadline": "2026-03-07T20:15:48.000Z",
  "author": "maintainer-agent",
  "estimated_minutes": 180,
  "acceptance_criteria": "ExtensionApi exposes registration methods for flags schema migrations importers exporters search providers and vector adapters. Activation captures deterministic counts and registries. Docs and tests are updated and sandbox coverage stays 100 percent.",
  "dependencies": [
    {
      "id": "pm-b1w",
      "kind": "related",
      "created_at": "2026-03-05T20:15:49.066Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-05T20:15:49.066Z",
      "author": "maintainer-agent",
      "text": "Why this exists add baseline registration coverage for remaining v1 ExtensionApi methods."
    },
    {
      "created_at": "2026-03-05T20:16:01.010Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: update PRD and README first for extension API registration baseline then implement loader registries and activation diagnostics then add regression tests and run pm test plus pm test-all sweeps."
    },
    {
      "created_at": "2026-03-05T20:17:36.152Z",
      "author": "maintainer-agent",
      "text": "Docs-first step complete: PRD and README now define extension API registration baseline for registerFlags registerItemFields registerMigration registerImporter registerExporter registerSearchProvider and registerVectorStoreAdapter with deterministic activation diagnostics."
    },
    {
      "created_at": "2026-03-05T20:32:55.735Z",
      "author": "maintainer-agent",
      "text": "Implemented docs-first + code changes for extension API registration baseline. Updated PRD.md and README.md contracts, extended src/core/extensions/loader.ts with registerFlags registerItemFields registerMigration registerImporter registerExporter registerSearchProvider registerVectorStoreAdapter registries and activation registration_counts, surfaced activation registrations in src/cli/commands/health.ts, and added coverage in tests/unit/extension-loader.spec.ts. Evidence: pm test pm-iuzs --run --timeout 7200 --json passed linked tests 3/3 including node scripts/run-tests.mjs coverage with 100 percent lines branches functions statements. Regression sweeps passed: pm test-all --status in_progress --timeout 7200 --json totals items=1 linked_tests=3 passed=3 failed=0 skipped=0; pm test-all --status closed --timeout 7200 --json totals items=75 linked_tests=228 passed=61 failed=0 skipped=167."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-05T20:15:49.066Z",
      "author": "maintainer-agent",
      "text": "Plan docs first then loader changes then tests then pm verification loop."
    }
  ],
  "learnings": [
    {
      "created_at": "2026-03-05T20:15:49.066Z",
      "author": "maintainer-agent",
      "text": "none"
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative v1 extension api contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "extension baseline status update"
    },
    {
      "path": "src/cli/commands/health.ts",
      "scope": "project",
      "note": "surface registration diagnostics in health activation details"
    },
    {
      "path": "src/core/extensions/loader.ts",
      "scope": "project",
      "note": "extend extension API registries"
    },
    {
      "path": "tests/unit/extension-loader.spec.ts",
      "scope": "project",
      "note": "extension registry behavior tests"
    },
    {
      "path": "tests/unit/health-command.spec.ts",
      "scope": "project",
      "note": "activation diagnostics coverage"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 2400,
      "note": "sandboxed coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/extension-loader.spec.ts",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "targeted extension loader coverage"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/health-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "health diagnostics regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "agent workflow alignment"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative extension API contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public contract alignment"
    }
  ]
}

Context: PRD v1 draft includes additional ExtensionApi registration methods that are still roadmap. Approach: promote registration-time support now with deterministic validation and activation reporting while keeping runtime wiring staged for follow-up.
