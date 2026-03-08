{
  "id": "pm-phob",
  "title": "Promote strategic metadata flags into canonical create/update contract",
  "description": "Add first-class item metadata for planning and business linkage by promoting planned-only flags into supported create/update schema and CLI help.",
  "type": "Task",
  "status": "closed",
  "priority": 0,
  "tags": [
    "area:cli",
    "area:docs",
    "area:schema",
    "code",
    "milestone:7",
    "pm-cli",
    "priority:0",
    "tests"
  ],
  "created_at": "2026-03-08T00:44:03.331Z",
  "updated_at": "2026-03-08T01:03:55.142Z",
  "deadline": "2026-03-10T00:44:03.331Z",
  "author": "maintainer-agent",
  "estimated_minutes": 240,
  "acceptance_criteria": "Create/update accept and persist order/rank, definition-of-ready, goal/objective, and value/impact/outcome/why-now fields with none-unset semantics; PRD/README/AGENTS and release-readiness tests stay aligned; full regression and 100% coverage remain green.",
  "risk": "medium",
  "comments": [
    {
      "created_at": "2026-03-08T00:44:03.331Z",
      "author": "maintainer-agent",
      "text": "Needed to support richer all-fields maintainer workflows and business-context planning metadata."
    },
    {
      "created_at": "2026-03-08T00:44:19.299Z",
      "author": "maintainer-agent",
      "text": "Planned change-set: docs-first promotion of selected planned flags (order/rank, definition-of-ready, goal/objective, value/impact/outcome/why-now), then schema+CLI create/update wiring with none-unset semantics and updated release-contract/unit/integration tests."
    },
    {
      "created_at": "2026-03-08T00:45:10.647Z",
      "author": "maintainer-agent",
      "text": "Docs-first update complete in PRD/README/AGENTS. Next implementing front-matter schema, canonical key ordering, create/update option parsing, and help aliases for order/rank + definition-of-ready + goal/objective + value/impact/outcome/why-now."
    },
    {
      "created_at": "2026-03-08T01:03:29.198Z",
      "author": "maintainer-agent",
      "text": "Implemented docs-first strategic metadata promotion: create/update now support order/rank, definition-of-ready, goal/objective, and value/impact/outcome/why-now with none-unset semantics and deterministic front-matter key ordering. Evidence: pm test pm-phob --run --timeout 7200 passed (2/2 linked commands, including coverage + full test); pm test-all --status in_progress --timeout 7200 passed (items=1 linked_tests=2 passed=2 failed=0 skipped=0); pm test-all --status closed --timeout 7200 passed (items=141 linked_tests=362 passed=64 failed=0 skipped=298 dedup). Coverage remained 100% lines/branches/functions/statements."
    },
    {
      "created_at": "2026-03-08T01:03:55.142Z",
      "author": "maintainer-agent",
      "text": "Post-close validation: pnpm build and pnpm typecheck both pass on updated tree."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-08T00:44:03.331Z",
      "author": "maintainer-agent",
      "text": "Implement docs-first then schema/types then create/update flag wiring then release-contract + unit + integration coverage."
    }
  ],
  "files": [
    {
      "path": "src/cli/commands/create.ts",
      "scope": "project",
      "note": "create command option parsing"
    },
    {
      "path": "src/cli/commands/update.ts",
      "scope": "project",
      "note": "update command option parsing"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "create and update option wiring"
    },
    {
      "path": "src/core/item/item-format.ts",
      "scope": "project",
      "note": "normalization and persistence"
    },
    {
      "path": "src/core/shared/constants.ts",
      "scope": "project",
      "note": "canonical key order"
    },
    {
      "path": "src/types.ts",
      "scope": "project",
      "note": "front matter field types"
    },
    {
      "path": "tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "note": "integration flag coverage"
    },
    {
      "path": "tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "note": "doc/help contract alignment"
    },
    {
      "path": "tests/unit/create-command.spec.ts",
      "scope": "project",
      "note": "unit create coverage"
    },
    {
      "path": "tests/unit/shared-constants-errors.spec.ts",
      "scope": "project",
      "note": "key-order contract coverage"
    },
    {
      "path": "tests/unit/update-command.spec.ts",
      "scope": "project",
      "note": "unit update coverage"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 7200,
      "note": "full coverage safety"
    },
    {
      "command": "node scripts/run-tests.mjs test",
      "scope": "project",
      "timeout_seconds": 7200,
      "note": "sandbox-safe full regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "agent workflow contract"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public contract"
    }
  ],
  "close_reason": "Shipped canonical strategic metadata flags (order/rank, definition_of_ready, goal/objective, value/impact/outcome/why_now) with docs, tests, and 100% coverage evidence."
}

Docs-first change: move selected planned flags into canonical support and wire deterministic serialization + create/update parsing + tests.
