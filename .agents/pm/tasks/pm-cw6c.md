{
  "id": "pm-cw6c",
  "title": "M5 follow-up: classify applied extension migrations",
  "description": "Align health migration status summaries with write-gate semantics by reporting applied migrations as resolved instead of pending.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:extensions",
    "area:health",
    "code",
    "doc",
    "milestone:5",
    "pm-cli",
    "priority:1",
    "tests"
  ],
  "created_at": "2026-03-06T08:22:27.153Z",
  "updated_at": "2026-03-06T08:39:37.414Z",
  "deadline": "2026-03-08T23:59:00.000Z",
  "author": "maintainer-agent",
  "estimated_minutes": 90,
  "acceptance_criteria": "pm health activation.migration_status reports applied/pending/failed deterministically; applied migrations are excluded from pending warnings; docs reflect the contract; regression and coverage stay 100%.",
  "dependencies": [
    {
      "id": "pm-42oa",
      "kind": "related",
      "created_at": "2026-03-06T08:22:27.153Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-06T08:22:27.153Z",
      "author": "maintainer-agent",
      "text": "Why this exists to reduce false pending migration warnings by distinguishing applied definitions in health diagnostics."
    },
    {
      "created_at": "2026-03-06T08:22:41.163Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: update PRD and README first to classify migration status into applied/pending/failed, then adjust runHealth migration summary and warnings accordingly with targeted and full regression runs."
    },
    {
      "created_at": "2026-03-06T08:24:25.662Z",
      "author": "maintainer-agent",
      "text": "Docs-first update completed: PRD and README migration diagnostics now classify status as failed/applied/pending to align health reporting with mandatory migration write-gate semantics."
    },
    {
      "created_at": "2026-03-06T08:39:36.887Z",
      "author": "maintainer-agent",
      "text": "Implemented migration summary refinement in runHealth: status parsing now classifies failed/applied/pending (case-insensitive), activation.migration_status now returns applied + applied_count, and warning emission remains limited to pending/failed entries. Added regression coverage in tests/unit/health-command.spec.ts to assert applied migrations are reported without pending warning inflation."
    },
    {
      "created_at": "2026-03-06T08:39:37.065Z",
      "author": "maintainer-agent",
      "text": "Evidence: pm test pm-cw6c --run --timeout 7200 --json passed all 3 linked tests; coverage output remains 100% statements/branches/functions/lines. pm test-all --status in_progress --timeout 7200 --json passed totals items=1 linked_tests=3 passed=3 failed=0 skipped=0 (after rerun sequentially to avoid coverage temp-file contention). pm test-all --status closed --timeout 7200 --json passed totals items=82 linked_tests=248 passed=62 failed=0 skipped=186."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-06T08:22:27.153Z",
      "author": "maintainer-agent",
      "text": "Plan docs first then implement health classification then run targeted and full regression."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "docs-first contract update"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "docs-first contract update"
    },
    {
      "path": "src/cli/commands/health.ts",
      "scope": "project",
      "note": "applied migration status classification"
    },
    {
      "path": "tests/unit/health-command.spec.ts",
      "scope": "project",
      "note": "applied migration coverage"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 7200,
      "note": "sandboxed coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test",
      "scope": "project",
      "timeout_seconds": 7200,
      "note": "sandboxed full regression"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/health-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 7200,
      "note": "targeted migration status regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "governing workflow rules"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative migration diagnostics contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public migration diagnostics contract"
    }
  ]
}

Context: health currently classifies any non-failed migration as pending which obscures already-applied migrations. Approach: docs-first contract update (PRD/README) then implement applied/pending/failed summary in health diagnostics with deterministic ordering and warnings only for pending/failed.
