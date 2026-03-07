{
  "id": "pm-42oa",
  "title": "M5 follow-up: report pending extension migrations in health",
  "description": "Surface extension migration registration status in pm health so pending/failed migration visibility is explicit.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:extensions",
    "area:health",
    "code",
    "docs",
    "milestone:5",
    "pm-cli",
    "priority:1",
    "tests"
  ],
  "created_at": "2026-03-06T07:18:07.309Z",
  "updated_at": "2026-03-06T07:40:43.536Z",
  "deadline": "2026-03-08T07:18:07.309Z",
  "author": "cursor-maintainer",
  "estimated_minutes": 90,
  "acceptance_criteria": "pm health reports deterministic migration status summary with pending/failed visibility from extension migration registrations; docs are updated first; targeted and regression sweeps pass with coverage at 100%.",
  "comments": [
    {
      "created_at": "2026-03-06T07:18:07.309Z",
      "author": "cursor-maintainer",
      "text": "Need explicit migration status visibility in health output to close extension registration runtime gap."
    },
    {
      "created_at": "2026-03-06T07:18:45.598Z",
      "author": "cursor-maintainer",
      "text": "Planned changeset: docs-first update PRD/README migration diagnostics contract, then implement health migration pending/failed summary from extension registration + activation data with targeted unit coverage and full pm verification sweeps."
    },
    {
      "created_at": "2026-03-06T07:20:39.763Z",
      "author": "cursor-maintainer",
      "text": "Docs-first update completed: PRD section 14.4/14.6 and README extension baseline now define deterministic migration status summaries in health diagnostics (failed when status=failed, otherwise pending) and clarify core-write migration blocking remains roadmap."
    },
    {
      "created_at": "2026-03-06T07:21:47.859Z",
      "author": "cursor-maintainer",
      "text": "Implemented health migration diagnostics: runHealth now summarizes registered extension migrations into activation.migration_status (pending/failed with counts), emits deterministic warning codes extension_migration_pending and extension_migration_failed, and unit coverage now includes a migration-ext scenario asserting warning/output shape parity."
    },
    {
      "created_at": "2026-03-06T07:24:41.739Z",
      "author": "cursor-maintainer",
      "text": "Follow-up after initial pm test run: coverage dropped below 100% in health.ts migration helpers. Added deterministic migration ordering/fallback-id/error-reason coverage by expanding health unit test with global+project migration registrations and mixed pending/failed definitions."
    },
    {
      "created_at": "2026-03-06T07:40:35.441Z",
      "author": "cursor-maintainer",
      "text": "Verification evidence: (1) pm test pm-42oa --run --timeout 7200 --json => 4/4 linked tests passed (coverage, full suite, targeted health spec, build), with coverage report at 100% statements/branches/functions/lines. (2) pm test-all --status in_progress --timeout 7200 --json => items=1 linked_tests=4 passed=4 failed=0 skipped=0. (3) pm test-all --status closed --timeout 7200 --json => items=80 linked_tests=241 passed=62 failed=0 skipped=179. Regression and coverage gates are green after migration-status health diagnostics updates."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-06T07:18:07.309Z",
      "author": "cursor-maintainer",
      "text": "Plan docs-first then health command migration summary plus tests and mandatory pm test sweeps."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "docs-first migration status baseline update"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "docs-first migration status contract"
    },
    {
      "path": "src/cli/commands/health.ts",
      "scope": "project",
      "note": "planned migration health diagnostics"
    },
    {
      "path": "tests/unit/health-command.spec.ts",
      "scope": "project",
      "note": "migration status regression coverage"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 240,
      "note": "sandboxed coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test",
      "scope": "project",
      "timeout_seconds": 240,
      "note": "sandboxed full suite"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/health-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 240,
      "note": "targeted health migration tests"
    },
    {
      "command": "pnpm build",
      "scope": "project",
      "timeout_seconds": 240,
      "note": "build verification"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "governing spec"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "migration health contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "governing spec"
    }
  ]
}

Implement docs-first migration visibility for extension registrations. Add deterministic health diagnostics for pending/failed migration status and regression tests.
