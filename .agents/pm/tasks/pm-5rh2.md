{
  "id": "pm-5rh2",
  "title": "Remove session-based ownership model",
  "description": "Replace session-scoped assignment semantics with generic assignee ownership across schema, commands, docs, tests, and Pi wrapper paths.",
  "type": "Task",
  "status": "closed",
  "priority": 0,
  "tags": [
    "area:core",
    "area:docs",
    "area:extensions-pi",
    "code",
    "doc",
    "milestone:next",
    "pm-cli",
    "priority:0",
    "tests"
  ],
  "created_at": "2026-03-05T08:56:51.061Z",
  "updated_at": "2026-03-05T09:34:48.936Z",
  "deadline": "2026-03-06T08:56:51.061Z",
  "author": "maintainer-agent",
  "estimated_minutes": 240,
  "acceptance_criteria": "No source/docs/tests reference legacy ownership session fields; ownership uses assignee semantics consistently; Pi wrapper docs point to .pi/extensions/pm-cli/index.ts; pm regression and coverage runs pass at 100 percent.",
  "dependencies": [
    {
      "id": "pm-06t",
      "kind": "related",
      "created_at": "2026-03-05T08:56:51.061Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-05T08:56:51.061Z",
      "author": "maintainer-agent",
      "text": "Why this exists: remove Pi-specific session semantics and make ownership model generic for all agents."
    },
    {
      "created_at": "2026-03-05T08:57:02.247Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: replace assigned_to_session/session.id/PM_SESSION with assignee semantics and owner-based locking metadata; migrate CLI flags to --assignee; update Pi wrapper parameter names and docs path references; then run targeted plus full regression and remove session attributes from tracker items using pm updates."
    },
    {
      "created_at": "2026-03-05T09:32:43.079Z",
      "author": "maintainer-agent",
      "text": "Evidence: pnpm build passed; node scripts/run-tests.mjs coverage passed (49/49 files, 371/371 tests, coverage report 100% statements/branches/functions/lines); node scripts/run-tests.mjs test -- tests/unit/claim-command.spec.ts tests/unit/update-command.spec.ts tests/unit/create-command.spec.ts tests/unit/pi-agent-extension.spec.ts passed (35/35); node scripts/run-tests.mjs test -- tests/unit/close-command.spec.ts tests/integration/help-readme-contract.spec.ts tests/integration/cli.integration.spec.ts passed (34/34). pm test pm-5rh2 --run --timeout 7200 --json passed all 3 linked tests. pm test-all --status in_progress --timeout 7200 --json passed totals items=1 linked_tests=3 passed=3 failed=0 skipped=0. pm test-all --status closed --timeout 7200 --json passed totals items=66 linked_tests=206 passed=57 failed=0 skipped=149. Tracker cleanup: pm-5rh2 front matter now uses assignee and no longer contains assigned_to_session."
    },
    {
      "created_at": "2026-03-05T09:34:48.936Z",
      "author": "maintainer-agent",
      "text": "Note: some historical comments and body text preserve legacy terminology as part of append-only item history; active front matter and linked file metadata now use assignee ownership and project-scoped Pi wrapper paths."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-05T08:56:51.061Z",
      "author": "maintainer-agent",
      "text": "Plan: migrate schema and commands then docs and tests then pm item cleanup."
    }
  ],
  "files": [
    {
      "path": ".pi/extensions/pm-cli/index.ts",
      "scope": "project",
      "note": "Pi wrapper parameter migration"
    },
    {
      "path": "package.json",
      "scope": "project",
      "note": "publish path updated to project-scoped Pi extension"
    },
    {
      "path": "src/cli/commands/beads.ts",
      "scope": "project",
      "note": "beads assignee mapping"
    },
    {
      "path": "src/cli/commands/claim.ts",
      "scope": "project",
      "note": "claim and release assignee behavior"
    },
    {
      "path": "src/cli/commands/close.ts",
      "scope": "project",
      "note": "clear assignee on close"
    },
    {
      "path": "src/cli/commands/create.ts",
      "scope": "project",
      "note": "create assignee field"
    },
    {
      "path": "src/cli/commands/restore.ts",
      "scope": "project",
      "note": "owner conflict checks and locking"
    },
    {
      "path": "src/cli/commands/update.ts",
      "scope": "project",
      "note": "update assignee field"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "flag and help migration"
    },
    {
      "path": "src/core/item/item-format.ts",
      "scope": "project",
      "note": "front-matter assignee normalization"
    },
    {
      "path": "src/core/lock/lock.ts",
      "scope": "project",
      "note": "lock owner field migration"
    },
    {
      "path": "src/core/shared/constants.ts",
      "scope": "project",
      "note": "front-matter key order and settings defaults"
    },
    {
      "path": "src/core/store/item-store.ts",
      "scope": "project",
      "note": "assignee ownership checks"
    },
    {
      "path": "src/core/store/settings.ts",
      "scope": "project",
      "note": "remove session settings model"
    },
    {
      "path": "src/extensions/builtins/todos/import-export.ts",
      "scope": "project",
      "note": "todos import-export assignee migration"
    },
    {
      "path": "src/types.ts",
      "scope": "project",
      "note": "ownership schema migration"
    },
    {
      "path": "tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "note": "integration lifecycle assignee flow"
    },
    {
      "path": "tests/integration/help-readme-contract.spec.ts",
      "scope": "project",
      "note": "readme quickstart assignee flow"
    },
    {
      "path": "tests/unit/claim-command.spec.ts",
      "scope": "project",
      "note": "author-assignee behavior coverage"
    },
    {
      "path": "tests/unit/close-command.spec.ts",
      "scope": "project",
      "note": "close clears assignee coverage"
    },
    {
      "path": "tests/unit/update-command.spec.ts",
      "scope": "project",
      "note": "assignee update semantics coverage"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 2400,
      "note": "sandboxed full coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/claim-command.spec.ts tests/unit/update-command.spec.ts tests/unit/create-command.spec.ts tests/unit/pi-agent-extension.spec.ts",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "targeted ownership and wrapper tests"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/close-command.spec.ts tests/integration/help-readme-contract.spec.ts tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "timeout_seconds": 2400,
      "note": "post-migration conflict-regression verification"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "agent workflow updates"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative contract update"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public contract updates"
    }
  ]
}

Context: session ownership came from Pi todos heritage and is no longer appropriate for multi-agent usage. Approach: migrate assigned_to_session to assignee and remove PM_SESSION and settings.session.id references while preserving deterministic behavior and lock safety.
