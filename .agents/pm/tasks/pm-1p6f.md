{
  "id": "pm-1p6f",
  "title": "Promote unblock-note to canonical workflow field",
  "description": "Docs-first promotion and implementation of unblock note metadata across create/update contracts and storage.",
  "type": "Task",
  "status": "closed",
  "priority": 0,
  "tags": [
    "area:workflow",
    "code",
    "docs",
    "milestone:7",
    "pm-cli",
    "priority:0",
    "tests"
  ],
  "created_at": "2026-03-08T13:07:26.852Z",
  "updated_at": "2026-03-08T13:24:14.136Z",
  "deadline": "2026-03-09T13:07:26.852Z",
  "author": "maintainer-agent",
  "estimated_minutes": 120,
  "acceptance_criteria": "CLI create/update support --unblock-note and --unblock_note with deterministic none-unset behavior; docs and tests align; coverage remains 100 percent.",
  "comments": [
    {
      "created_at": "2026-03-08T13:07:26.852Z",
      "author": "maintainer-agent",
      "text": "Why this exists unblock-note is still planned-only but needed for all-fields maintainership workflows."
    },
    {
      "created_at": "2026-03-08T13:07:45.686Z",
      "author": "maintainer-agent",
      "text": "Planned changeset before edits: update PRD README and AGENTS to promote unblock-note into canonical create and update contracts, then implement schema and CLI wiring with deterministic none-unset semantics plus unit and integration coverage."
    },
    {
      "created_at": "2026-03-08T13:08:47.126Z",
      "author": "maintainer-agent",
      "text": "Docs-first update complete: PRD README and AGENTS now promote unblock-note and unblock_note into canonical create and update contracts plus all-fields templates, including front-matter schema and key-order contract updates."
    },
    {
      "created_at": "2026-03-08T13:10:56.887Z",
      "author": "maintainer-agent",
      "text": "Implementation phase complete: added unblock_note to item schema and canonical key order, wired create and update options for unblock-note and unblock_note aliases, and updated unit and integration contracts for create/update behavior plus release-readiness docs-help parity."
    },
    {
      "created_at": "2026-03-08T13:23:54.899Z",
      "author": "maintainer-agent",
      "text": "Evidence: pm test pm-1p6f --run --timeout 7200 --json passed both linked commands (coverage plus targeted unblock-note suites). pm test-all --status in_progress --timeout 7200 --json passed totals items=1 linked_tests=2 passed=2 failed=0 skipped=0. pm test-all --status closed --timeout 7200 --json passed totals items=148 linked_tests=378 passed=67 failed=0 skipped=311. Coverage remains 100 percent statements branches functions and lines."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-08T13:07:26.852Z",
      "author": "maintainer-agent",
      "text": "Plan docs first in PRD README and AGENTS then CLI and schema wiring then unit and integration updates with pm evidence."
    }
  ],
  "files": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "all-fields templates include unblock note"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "promote unblock_note schema and flag contracts"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "document create and update unblock note flags"
    },
    {
      "path": "src/cli/commands/create.ts",
      "scope": "project",
      "note": "create command parsing and explicit unsets"
    },
    {
      "path": "src/cli/commands/update.ts",
      "scope": "project",
      "note": "update command parsing and mutation"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "add create and update option aliases"
    },
    {
      "path": "src/core/item/item-format.ts",
      "scope": "project",
      "note": "normalization and serialization"
    },
    {
      "path": "src/core/shared/constants.ts",
      "scope": "project",
      "note": "canonical key order"
    },
    {
      "path": "src/types.ts",
      "scope": "project",
      "note": "front matter schema"
    },
    {
      "path": "tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "note": "cli flag integration contract"
    },
    {
      "path": "tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "note": "docs help parity contract"
    },
    {
      "path": "tests/unit/create-command.spec.ts",
      "scope": "project",
      "note": "create coverage for unblock note"
    },
    {
      "path": "tests/unit/shared-constants-errors.spec.ts",
      "scope": "project",
      "note": "canonical key order coverage"
    },
    {
      "path": "tests/unit/update-command.spec.ts",
      "scope": "project",
      "note": "update coverage for unblock note"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 7200,
      "note": "sandbox-safe full coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/create-command.spec.ts tests/unit/update-command.spec.ts tests/unit/shared-constants-errors.spec.ts tests/integration/cli.integration.spec.ts tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "timeout_seconds": 7200,
      "note": "targeted unblock-note regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "maintainer workflow template"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative flag contract update"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public flag contract"
    }
  ],
  "close_reason": "unblock-note canonicalized across docs CLI schema and tests with full regression evidence"
}

Promote unblock note metadata into canonical create/update contracts so blocked workflows can capture unblocking rationale with deterministic none-unset semantics.
