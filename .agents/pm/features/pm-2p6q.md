{
  "id": "pm-2p6q",
  "title": "Extended schema fields v1.1 - parent, reviewer, risk, sprint, release",
  "description": "Add optional front-matter fields parent, reviewer, risk, sprint, release, blocked_by, blocked_reason to make pm-cli production-ready for diverse project workflows.",
  "type": "Feature",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:cli",
    "area:core",
    "area:docs",
    "area:schema",
    "code",
    "milestone:7",
    "pm-cli",
    "priority:1",
    "tests"
  ],
  "created_at": "2026-03-07T23:59:27.285Z",
  "updated_at": "2026-03-08T00:31:15.656Z",
  "deadline": "2026-03-10T23:59:27.285Z",
  "author": "maintainer-agent",
  "estimated_minutes": 180,
  "acceptance_criteria": "PRD updated with new optional fields; create/update help shows new flags; new fields serialize in canonical key order; 100% test coverage maintained; release-readiness contract tests updated.",
  "comments": [
    {
      "created_at": "2026-03-07T23:59:27.285Z",
      "author": "maintainer-agent",
      "text": "These fields are commonly needed for real-world project management across teams and tools. Docs-first approach per R1."
    },
    {
      "created_at": "2026-03-08T00:00:38.074Z",
      "author": "maintainer-agent",
      "text": "Starting docs-first implementation. Adding parent, reviewer, risk, sprint, release, blocked_by, blocked_reason as optional front-matter fields to PRD schema section 7.1, then updating canonical key order in 7.2."
    },
    {
      "created_at": "2026-03-08T00:17:10.436Z",
      "author": "maintainer-agent",
      "text": "Implementing end-to-end support for parent/reviewer/risk/sprint/release/blocked fields: keep docs aligned, persist fields in normalization, and expand unit+integration contracts before full regression."
    },
    {
      "created_at": "2026-03-08T00:31:15.305Z",
      "author": "maintainer-agent",
      "text": "Evidence: pm test pm-2p6q --run passed (linked coverage + test); pm test-all --status in_progress passed (2/2); pm test-all --status closed passed (64 passed, 0 failed, 296 skipped duplicates/no-command); coverage remained 100% lines/branches/functions/statements."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-07T23:59:27.285Z",
      "author": "maintainer-agent",
      "text": "Plan: 1) Update PRD schema section 2) Update README 3) Add types 4) Wire create/update flags 5) Update serialization key order 6) Add tests 7) Verify coverage"
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "schema definition update"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "docs update"
    },
    {
      "path": "src/cli/commands/create.ts",
      "scope": "project",
      "note": "wire create optional scalar flags"
    },
    {
      "path": "src/cli/commands/update.ts",
      "scope": "project",
      "note": "wire update optional scalar flags"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "create/update flag wiring"
    },
    {
      "path": "src/core/item/item-format.ts",
      "scope": "project",
      "note": "preserve optional scalar fields during normalization"
    },
    {
      "path": "src/core/shared/constants.ts",
      "scope": "project",
      "note": "canonical key order update"
    },
    {
      "path": "src/types.ts",
      "scope": "project",
      "note": "type definitions"
    },
    {
      "path": "tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "note": "cli optional flag alias integration coverage"
    },
    {
      "path": "tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "note": "release contract expectations update"
    },
    {
      "path": "tests/unit/create-command.spec.ts",
      "scope": "project",
      "note": "create command coverage for optional scalar fields"
    },
    {
      "path": "tests/unit/shared-constants-errors.spec.ts",
      "scope": "project",
      "note": "key order contract coverage"
    },
    {
      "path": "tests/unit/update-command.spec.ts",
      "scope": "project",
      "note": "update command coverage for optional scalar fields"
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
      "timeout_seconds": 2400,
      "note": "sandbox-safe full regression"
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
      "note": "authoritative schema contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public command contract update"
    }
  ],
  "close_reason": "Extended optional schema fields now persist end-to-end with create/update flag parity and verified 100% regression coverage."
}

Docs-first implementation of extended schema fields that make pm-cli usable across any project type. Adds parent (shorthand dep), reviewer, risk, sprint, release, blocked_by, blocked_reason as optional front-matter fields with create/update CLI flag parity.
