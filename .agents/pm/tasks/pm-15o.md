{
  "id": "pm-15o",
  "title": "M6: Command help and README examples validated in tests",
  "description": "Validate docs examples and help text through automated tests.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:docs-validation",
    "core",
    "milestone:6",
    "pm-cli"
  ],
  "created_at": "2026-02-17T23:02:12.823Z",
  "updated_at": "2026-02-18T01:49:59.774Z",
  "deadline": "2026-03-19T23:02:12.823Z",
  "author": "steve",
  "estimated_minutes": 90,
  "acceptance_criteria": "README and help examples are exercised and passing in tests.",
  "dependencies": [
    {
      "id": "pm-b1w",
      "kind": "blocks",
      "created_at": "2026-02-17T23:02:12.823Z",
      "author": "steve"
    },
    {
      "id": "pm-jiw",
      "kind": "parent",
      "created_at": "2026-02-17T23:02:12.823Z",
      "author": "steve"
    }
  ],
  "comments": [
    {
      "created_at": "2026-02-18T01:45:31.886Z",
      "author": "agent",
      "text": "Planned change-set: add integration tests that validate pm --help contract against README command list and execute sandboxed quickstart command flow examples to keep docs and behavior aligned."
    },
    {
      "created_at": "2026-02-18T01:46:42.920Z",
      "author": "agent",
      "text": "Implemented tests/integration/help-readme-contract.spec.ts with two coverage paths: README core/roadmap/flags contract validation against pm --help, and sandboxed README quickstart lifecycle execution (init/create/list-open/claim/update/files/test/comments/update/release)."
    },
    {
      "created_at": "2026-02-18T01:49:59.427Z",
      "author": "agent",
      "text": "Evidence: pm test pm-15o --run --timeout 900 --json passed both linked commands (targeted integration + full coverage). pm test-all --status in_progress --timeout 900 --json passed with totals items=6 linked_tests=11 passed=11 failed=0 skipped=0. Coverage remains 100% lines/branches/functions/statements."
    }
  ],
  "files": [
    {
      "path": "tests/integration/help-readme-contract.spec.ts",
      "scope": "project",
      "note": "validate help and README quickstart flows"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 420,
      "note": "full regression coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/integration/help-readme-contract.spec.ts",
      "scope": "project",
      "timeout_seconds": 240,
      "note": "help and README contract integration"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "dogfood workflow compliance"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "governing spec"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "validate examples and documented command surface"
    }
  ]
}

Automate validation for command help and README examples.
