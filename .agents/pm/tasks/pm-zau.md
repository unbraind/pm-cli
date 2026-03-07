{
  "id": "pm-zau",
  "title": "M3: stats health and gc commands",
  "description": "Implement operational diagnostics command surfaces incrementally, starting with deterministic stats output for current tracker state.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:operations",
    "core",
    "milestone:3",
    "pm-cli"
  ],
  "created_at": "2026-02-17T23:02:09.876Z",
  "updated_at": "2026-02-18T14:34:05.944Z",
  "deadline": "2026-03-03T23:02:09.876Z",
  "author": "steve",
  "estimated_minutes": 140,
  "acceptance_criteria": "stats, health, and gc commands provide deterministic diagnostics outputs with unit/integration coverage and 100% gate preserved",
  "dependencies": [
    {
      "id": "pm-54d",
      "kind": "parent",
      "created_at": "2026-02-17T23:02:09.876Z",
      "author": "steve"
    },
    {
      "id": "pm-c0r",
      "kind": "blocks",
      "created_at": "2026-02-17T23:02:09.876Z",
      "author": "steve"
    }
  ],
  "comments": [
    {
      "created_at": "2026-02-18T03:53:00.847Z",
      "author": "maintainer-agent",
      "text": "author=maintainer-agent,created_at=now,text=Planned changeset: update PRD/README command matrix first, then add deterministic pm stats command with unit/integration coverage and preserve 100% thresholds."
    },
    {
      "created_at": "2026-02-18T03:58:25.902Z",
      "author": "maintainer-agent",
      "text": "Implemented pm stats command with deterministic totals/by_type/by_status output; updated README/PRD command matrix first per contract, then wired CLI + tests. Evidence: pm test pm-zau --run --timeout 600 passed (linked commands node scripts/run-tests.mjs coverage/test + pnpm build), pm test-all --status in_progress --timeout 600 passed (11/11 linked tests), coverage remains 100% lines/branches/functions/statements including src/commands/stats.ts."
    },
    {
      "created_at": "2026-02-18T03:58:56.700Z",
      "author": "maintainer-agent",
      "text": "Stats sub-scope is complete and validated; remaining task scope is to implement health and gc commands with deterministic output contracts and tests."
    },
    {
      "created_at": "2026-02-18T03:59:18.545Z",
      "author": "maintainer-agent",
      "text": "Verification spot-check: node dist/cli.js --help now lists stats in implemented command surface."
    },
    {
      "created_at": "2026-02-18T04:14:17.956Z",
      "author": "maintainer-agent",
      "text": "author=maintainer-agent,created_at=now,text=Planned changeset: update PRD/README command matrix to include health baseline, then implement pm health command with deterministic checks (settings, required directories, storage summary) plus unit/integration coverage while keeping gc pending."
    },
    {
      "created_at": "2026-02-18T04:19:09.246Z",
      "author": "maintainer-agent",
      "text": "Health sub-scope implemented: added pm health command with deterministic checks for settings, required directories, settings-value sanity, and storage summary. Evidence: pnpm build passed; pm test pm-zau --run --timeout 900 passed; pm test-all --status in_progress --timeout 900 passed (totals items=5 linked_tests=12 passed=11 failed=0 skipped=1). Coverage remains 100% lines/branches/functions/statements including src/commands/health.ts."
    },
    {
      "created_at": "2026-02-18T04:19:09.405Z",
      "author": "maintainer-agent",
      "text": "Remaining scope note: gc command is still pending under pm-zau; health is now included in CLI help and documented in PRD/README implemented command surface."
    },
    {
      "created_at": "2026-02-18T14:28:53.451Z",
      "author": "maintainer-agent",
      "text": "author=maintainer-agent,created_at=now,text=Planned changeset: update PRD and README first to include deterministic gc command contract, then implement pm gc wiring + command logic with unit/integration coverage and run pm test + pm test-all for evidence."
    },
    {
      "created_at": "2026-02-18T14:29:26.051Z",
      "author": "maintainer-agent",
      "text": "Docs-first update applied: PRD.md and README.md now list pm gc in implemented command surface and define gc output contract before code implementation."
    },
    {
      "created_at": "2026-02-18T14:34:05.623Z",
      "author": "maintainer-agent",
      "text": "Implemented pm gc command with deterministic cache cleanup summary and CLI wiring after docs-first PRD/README updates. Evidence: pm test pm-zau --run --timeout 1200 passed (linked coverage/test/build commands), pm test-all --status in_progress --timeout 1200 passed (totals items=5 linked_tests=14 passed=11 failed=0 skipped=3), and coverage remains 100% lines/branches/functions/statements including src/commands/gc.ts."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "update milestone checklist and command matrix"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "document implemented command surface"
    },
    {
      "path": "src/cli/commands/index.ts",
      "scope": "project",
      "note": "export stats command"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "register stats command"
    },
    {
      "path": "src/commands/gc.ts",
      "scope": "project",
      "note": "gc command implementation"
    },
    {
      "path": "src/commands/health.ts",
      "scope": "project",
      "note": "health command implementation"
    },
    {
      "path": "src/commands/stats.ts",
      "scope": "project",
      "note": "stats command implementation"
    },
    {
      "path": "tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "note": "cli stats integration coverage"
    },
    {
      "path": "tests/unit/gc-command.spec.ts",
      "scope": "project",
      "note": "unit coverage for gc command"
    },
    {
      "path": "tests/unit/health-command.spec.ts",
      "scope": "project",
      "note": "unit coverage for health command"
    },
    {
      "path": "tests/unit/stats-command.spec.ts",
      "scope": "project",
      "note": "unit coverage for stats logic"
    },
    {
      "path": "vitest.config.ts",
      "scope": "project",
      "note": "coverage include for new command file"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 600,
      "note": "sandboxed coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test",
      "scope": "project",
      "timeout_seconds": 600,
      "note": "sandboxed regression"
    },
    {
      "command": "pnpm build",
      "scope": "project",
      "timeout_seconds": 180,
      "note": "build verification"
    },
    {
      "path": "tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "note": "integration health command coverage"
    },
    {
      "path": "tests/unit/gc-command.spec.ts",
      "scope": "project",
      "note": "unit gc command assertions"
    },
    {
      "path": "tests/unit/health-command.spec.ts",
      "scope": "project",
      "note": "health command unit assertions"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "dogfood workflow contract"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "governing spec"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public command contract"
    }
  ]
}

Implement stats health and garbage-collection command surfaces.
