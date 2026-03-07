{
  "id": "pm-4yl0",
  "title": "Implement pm delete command",
  "description": "Add a deterministic core delete command with history tombstone ownership checks docs parity and full coverage.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:commands",
    "code",
    "docs",
    "milestone:1",
    "pm-cli",
    "priority:1",
    "tests"
  ],
  "created_at": "2026-03-04T00:26:07.113Z",
  "updated_at": "2026-03-05T09:33:50.591Z",
  "deadline": "2026-03-08T23:59:00.000Z",
  "author": "cursor-maintainer",
  "estimated_minutes": 180,
  "acceptance_criteria": "pm delete <ID> is available in CLI help and docs, deletes item files safely with lock and ownership enforcement, appends deterministic delete history entries, preserves 100% coverage, and passes pm test plus pm test-all sweeps.",
  "dependencies": [
    {
      "id": "pm-u9r",
      "kind": "parent",
      "created_at": "2026-03-04T00:26:07.113Z",
      "author": "cursor-maintainer"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-04T00:26:07.113Z",
      "author": "cursor-maintainer",
      "text": "Delete is roadmap only and this item implements it with deterministic behavior."
    },
    {
      "created_at": "2026-03-04T00:26:24.527Z",
      "author": "cursor-maintainer",
      "text": "Planned changeset: update PRD and README first to move pm delete from roadmap to implemented command surface, then implement delete command/store flow and add unit plus integration plus docs contract coverage before running pm test and test-all."
    },
    {
      "created_at": "2026-03-04T00:33:19.925Z",
      "author": "cursor-maintainer",
      "text": "Docs-first updates applied: PRD and README now classify pm delete as implemented core command, roadmap command section no longer lists delete, and Pi-wrapper command coverage docs include delete action parity."
    },
    {
      "created_at": "2026-03-04T00:34:44.353Z",
      "author": "cursor-maintainer",
      "text": "Follow-up implementation: runHistory now resolves normalized IDs and serves history streams even when the item file no longer exists, which makes delete events auditable through pm history after deletion."
    },
    {
      "created_at": "2026-03-04T00:47:38.587Z",
      "author": "cursor-maintainer",
      "text": "Implemented delete command changeset end-to-end. Code: added src/cli/commands/delete.ts and src/commands/delete.ts; wired delete command in src/cli/main.ts and src/cli/commands/index.ts; added core delete mutation flow with lock ownership checks history tombstone append and rollback in src/core/store/item-store.ts; updated src/cli/commands/history.ts to allow history retrieval for deleted item IDs. Docs: PRD.md and README.md now list pm delete as implemented core command and keep roadmap command list empty; Pi wrapper docs/action list include delete. Tests: added tests/unit/delete-command.spec.ts plus integration and contract updates in tests/integration/cli.integration.spec.ts tests/integration/release-readiness-contract.spec.ts tests/integration/help-readme-contract.spec.ts tests/unit/pi-agent-extension.spec.ts tests/unit/structure-exports.spec.ts and vitest.config.ts coverage include update. Evidence: node dist/cli.js test pm-4yl0 --run --timeout 7200 --json passed all linked tests (coverage + targeted + build). Regression sweeps passed: node dist/cli.js test-all --status in_progress --timeout 7200 --json totals items=8 linked_tests=33 passed=16 failed=0 skipped=17; node dist/cli.js test-all --status closed --timeout 7200 --json totals items=36 linked_tests=125 passed=50 failed=0 skipped=75. Coverage statement: sandboxed coverage gate remains 100% lines branches functions and statements after delete command updates. Follow-up items created: none."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-04T00:26:07.113Z",
      "author": "cursor-maintainer",
      "text": "Validate unit integration docs parity and sandboxed coverage sweep."
    }
  ],
  "files": [
    {
      "path": ".pi/extensions/pm-cli/index.ts",
      "scope": "project",
      "note": "Pi wrapper project-scoped module path"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "docs-first command contract update"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "promote delete command docs"
    },
    {
      "path": "src/cli/commands/delete.ts",
      "scope": "project",
      "note": "delete command runner"
    },
    {
      "path": "src/cli/commands/history.ts",
      "scope": "project",
      "note": "allow history lookup for deleted items"
    },
    {
      "path": "src/cli/commands/index.ts",
      "scope": "project",
      "note": "export delete runner"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "register delete CLI command"
    },
    {
      "path": "src/commands/delete.ts",
      "scope": "project",
      "note": "root compatibility wrapper"
    },
    {
      "path": "src/core/store/item-store.ts",
      "scope": "project",
      "note": "delete mutation pipeline"
    },
    {
      "path": "tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "note": "delete lifecycle integration coverage"
    },
    {
      "path": "tests/integration/help-readme-contract.spec.ts",
      "scope": "project",
      "note": "allow empty roadmap command list"
    },
    {
      "path": "tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "note": "docs help contract update"
    },
    {
      "path": "tests/unit/delete-command.spec.ts",
      "scope": "project",
      "note": "delete command unit coverage"
    },
    {
      "path": "tests/unit/pi-agent-extension.spec.ts",
      "scope": "project",
      "note": "delete action mapping coverage"
    },
    {
      "path": "tests/unit/structure-exports.spec.ts",
      "scope": "project",
      "note": "assert delete export"
    },
    {
      "path": "vitest.config.ts",
      "scope": "project",
      "note": "coverage include for new modules"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 7200,
      "note": "full sandboxed coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/delete-command.spec.ts tests/integration/cli.integration.spec.ts tests/integration/release-readiness-contract.spec.ts tests/integration/help-readme-contract.spec.ts",
      "scope": "project",
      "timeout_seconds": 5400,
      "note": "targeted delete and contract regression"
    },
    {
      "command": "pnpm build",
      "scope": "project",
      "timeout_seconds": 300,
      "note": "typescript build"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "agent workflow rules"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "governing spec"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "user-facing command surface"
    }
  ]
}

Docs-first: promote pm delete from roadmap to core command contract; implement command wiring and store delete mutation with rollback-safe history append; add unit integration and README PRD help contract coverage.
