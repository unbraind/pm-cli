{
  "id": "pm-2p5x",
  "title": "M5 follow-up: enforce mandatory extension migration write gate",
  "description": "Block core write command paths when mandatory extension migrations are unresolved, with explicit --force bypass where supported.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:extensions",
    "area:migrations",
    "code",
    "docs",
    "milestone:5",
    "pm-cli",
    "priority:1",
    "tests"
  ],
  "created_at": "2026-03-06T07:43:45.497Z",
  "updated_at": "2026-03-06T08:13:17.298Z",
  "deadline": "2026-03-08T07:43:45.497Z",
  "author": "cursor-maintainer",
  "estimated_minutes": 120,
  "acceptance_criteria": "Core write command paths fail deterministically when any registered migration has mandatory=true and unresolved status; commands with --force can bypass where safe; PRD/README updated docs-first; coverage and pm regression sweeps remain 100%.",
  "comments": [
    {
      "created_at": "2026-03-06T07:43:45.497Z",
      "author": "cursor-maintainer",
      "text": "Need to close the roadmap gap by enforcing unresolved mandatory migration gating on write paths with deterministic force bypass behavior."
    },
    {
      "created_at": "2026-03-06T07:43:50.984Z",
      "author": "cursor-maintainer",
      "text": "Planned changeset: docs-first update PRD/README to move mandatory migration write-gate from roadmap to implemented baseline with unresolved semantics and force bypass scope; then implement pre-action runtime enforcement in CLI and add integration coverage for blocked and forced mutation paths."
    },
    {
      "created_at": "2026-03-06T07:44:42.580Z",
      "author": "cursor-maintainer",
      "text": "Docs-first update completed: PRD section 14.4/14.6 and README extension baseline now define mandatory migration write-gate behavior (mandatory=true + status not applied blocks core writes, with explicit --force bypass on force-capable commands)."
    },
    {
      "created_at": "2026-03-06T07:48:54.216Z",
      "author": "cursor-maintainer",
      "text": "Implemented runtime write-gate enforcement in src/cli/main.ts: pre-action extension activation now derives unresolved mandatory migration blockers from registered migration definitions (mandatory=true and status!=applied), blocks mutating command paths with deterministic conflict error codes, and allows explicit --force bypass on force-capable mutation commands. Added integration coverage for blocked create/update flows, force bypass, and case-insensitive applied status resolution."
    },
    {
      "created_at": "2026-03-06T08:13:13.870Z",
      "author": "cursor-maintainer",
      "text": "Verification evidence after final main.ts lint cleanup: (1) pm test pm-2p5x --run --timeout 7200 --json => 3/3 linked tests passed (coverage, targeted CLI integration, health unit regression) with coverage report at 100% statements/branches/functions/lines. (2) pm test-all --status in_progress --timeout 7200 --json => items=1 linked_tests=3 passed=3 failed=0 skipped=0. (3) pm test-all --status closed --timeout 7200 --json => items=81 linked_tests=245 passed=62 failed=0 skipped=183."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-06T07:43:45.497Z",
      "author": "cursor-maintainer",
      "text": "Plan docs first update then CLI runtime gate and integration unit tests for blocked and forced flows."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "governing migration gate contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "user facing migration gate behavior"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "runtime write gate enforcement"
    },
    {
      "path": "tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "note": "write gate command behavior coverage"
    },
    {
      "path": "tests/unit/health-command.spec.ts",
      "scope": "project",
      "note": "migration status baseline compatibility"
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
      "command": "node scripts/run-tests.mjs test -- tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "timeout_seconds": 240,
      "note": "targeted CLI write gate integration"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/health-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 240,
      "note": "health migration diagnostics regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "workflow and dogfood constraints"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "extension migration contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "runtime behavior contract"
    }
  ]
}

Implement deterministic runtime guard for unresolved mandatory extension migrations. Update docs first then wire CLI enforcement and regression coverage.
