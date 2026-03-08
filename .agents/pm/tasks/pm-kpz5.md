{
  "id": "pm-kpz5",
  "title": "Add confidence metadata flag support for create/update",
  "description": "Docs-first implement optional confidence metadata across schema CLI flags normalization and contracts.",
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
  "created_at": "2026-03-08T02:57:27.489Z",
  "updated_at": "2026-03-08T10:21:28.006Z",
  "deadline": "2026-03-10T02:57:27.489Z",
  "author": "maintainer-agent",
  "estimated_minutes": 150,
  "acceptance_criteria": "Create and update accept --confidence with normalization 0..100 or low/med/high and docs-first parity while coverage stays 100 percent.",
  "comments": [
    {
      "created_at": "2026-03-08T02:57:27.489Z",
      "author": "maintainer-agent",
      "text": "Why this exists confidence metadata is still planned-only and should be promoted into canonical create and update contract."
    },
    {
      "created_at": "2026-03-08T02:57:36.879Z",
      "author": "maintainer-agent",
      "text": "Planned changeset before edits: update PRD README and AGENTS to promote confidence into canonical create update contracts, then implement CLI parsing normalization serialization and tests."
    },
    {
      "created_at": "2026-03-08T02:58:23.582Z",
      "author": "maintainer-agent",
      "text": "Docs-first phase complete: PRD README and AGENTS now define confidence as canonical create and update metadata with med normalization and none-unset semantics."
    },
    {
      "created_at": "2026-03-08T03:01:36.732Z",
      "author": "maintainer-agent",
      "text": "Implementation phase in progress: added confidence to ItemFrontMatter and canonical key order, wired create/update parsing, and updated docs-contract tests to expect confidence in help and templates."
    },
    {
      "created_at": "2026-03-08T03:17:47.819Z",
      "author": "maintainer-agent",
      "text": "Evidence: pm test pm-kpz5 --run passed with coverage 100 and targeted confidence regression passed. Regression sweeps also passed: pm test-all --status in_progress (2 passed 0 failed) and pm test-all --status closed (65 passed 0 failed 301 skipped duplicates)."
    },
    {
      "created_at": "2026-03-08T10:21:28.006Z",
      "author": "maintainer-agent",
      "text": "Revalidation evidence (2026-03-08): pm test pm-kpz5 --run --timeout 7200 --json passed 2/2 linked tests including node scripts/run-tests.mjs coverage with 100% lines/branches/functions/statements and targeted confidence regressions. Regression sweeps: pm test-all --status in_progress --timeout 7200 --json (items=0) and pm test-all --status closed --timeout 7200 --json (items=145 linked_tests=371 passed=66 failed=0 skipped=305)."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-08T02:57:27.489Z",
      "author": "maintainer-agent",
      "text": "Plan update PRD README AGENTS first then implement CLI types and tests and run pm test plus test-all sweeps."
    }
  ],
  "files": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "all-fields template now includes confidence"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "docs-first confidence field contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "docs-first create and update confidence contract"
    },
    {
      "path": "src/cli/commands/create.ts",
      "scope": "project",
      "note": "create confidence parsing and normalization"
    },
    {
      "path": "src/cli/commands/update.ts",
      "scope": "project",
      "note": "update confidence parsing and normalization"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "create update flag wiring"
    },
    {
      "path": "src/core/item/item-format.ts",
      "scope": "project",
      "note": "confidence normalization and validation in document parser"
    },
    {
      "path": "src/core/shared/constants.ts",
      "scope": "project",
      "note": "front matter key order includes confidence"
    },
    {
      "path": "src/types.ts",
      "scope": "project",
      "note": "item schema confidence field"
    },
    {
      "path": "tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "note": "CLI create update confidence behavior coverage"
    },
    {
      "path": "tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "note": "docs and help confidence contract assertions"
    },
    {
      "path": "tests/unit/create-command.spec.ts",
      "scope": "project",
      "note": "create confidence branch tests"
    },
    {
      "path": "tests/unit/item-format-validation.spec.ts",
      "scope": "project",
      "note": "item-format confidence validation coverage"
    },
    {
      "path": "tests/unit/shared-constants-errors.spec.ts",
      "scope": "project",
      "note": "key-order contract includes confidence"
    },
    {
      "path": "tests/unit/update-command.spec.ts",
      "scope": "project",
      "note": "update confidence branch tests"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 3600,
      "note": "full 100 percent coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/create-command.spec.ts tests/unit/update-command.spec.ts tests/integration/cli.integration.spec.ts tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "timeout_seconds": 2400,
      "note": "targeted confidence regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "agent workflow and template parity"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative command and schema contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "user-facing command contract"
    }
  ],
  "close_reason": "Confidence flag support complete with docs and tests passing at 100 coverage."
}

Implement optional confidence metadata support for create and update with deterministic serialization and docs-contract parity.
