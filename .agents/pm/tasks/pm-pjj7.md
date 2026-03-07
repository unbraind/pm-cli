{
  "id": "pm-pjj7",
  "title": "M5 follow-up: health extension activation probe",
  "description": "Extend pm health extension diagnostics to include extension activation failures from activate(api) calls.",
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
  "created_at": "2026-03-05T15:13:38.557Z",
  "updated_at": "2026-03-05T15:27:26.358Z",
  "deadline": "2026-03-07T23:59:00.000Z",
  "author": "cursor-maintainer",
  "estimated_minutes": 90,
  "acceptance_criteria": "pm health reports extension activation failures deterministically with warnings and details; docs reflect behavior; sandboxed coverage plus pm regression sweeps remain at 100 percent.",
  "dependencies": [
    {
      "id": "pm-7sd",
      "kind": "related",
      "created_at": "2026-03-05T15:13:38.557Z",
      "author": "cursor-maintainer"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-05T15:13:38.557Z",
      "author": "cursor-maintainer",
      "text": "Why this exists: close remaining M5 health hardening by surfacing extension activation failures in health diagnostics."
    },
    {
      "created_at": "2026-03-05T15:13:56.008Z",
      "author": "cursor-maintainer",
      "text": "Planned changeset: docs-first update PRD and README to require extension activation probe diagnostics in pm health, then wire health command to surface activate(api) failures with deterministic warnings and add unit coverage before full pm test and test-all sweeps."
    },
    {
      "created_at": "2026-03-05T15:16:07.648Z",
      "author": "cursor-maintainer",
      "text": "Implemented docs-first plus code changeset: PRD.md and README.md now require health extension activation diagnostics; src/cli/commands/health.ts now performs extension load and activation probes and surfaces deterministic activation metadata/warnings; tests/unit/health-command.spec.ts adds activation-failure health regression coverage."
    },
    {
      "created_at": "2026-03-05T15:27:17.466Z",
      "author": "cursor-maintainer",
      "text": "Evidence: node scripts/run-tests.mjs test -- tests/unit/health-command.spec.ts passed (7/7). pm test pm-pjj7 --run --timeout 7200 --json passed all linked commands (coverage plus targeted suite plus build). pm test-all --status in_progress --timeout 7200 --json passed totals items=1 linked_tests=3 passed=3 failed=0 skipped=0. pm test-all --status closed --timeout 7200 --json passed totals items=73 linked_tests=223 passed=59 failed=0 skipped=164. Coverage statement: node scripts/run-tests.mjs coverage reports 100 percent statements branches functions and lines."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-05T15:13:38.557Z",
      "author": "cursor-maintainer",
      "text": "Plan update docs first then wire health output then verify with tests."
    }
  ],
  "learnings": [
    {
      "created_at": "2026-03-05T15:13:38.557Z",
      "author": "cursor-maintainer",
      "text": "Initial assumption activation failures are visible at runtime but not in health."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "health activation diagnostic contract update"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "health activation diagnostics documented"
    },
    {
      "path": "src/cli/commands/health.ts",
      "scope": "project",
      "note": "activation diagnostics in health"
    },
    {
      "path": "src/core/extensions/loader.ts",
      "scope": "project",
      "note": "activation diagnostics source"
    },
    {
      "path": "tests/unit/extension-loader.spec.ts",
      "scope": "project",
      "note": "activation warning fixtures"
    },
    {
      "path": "tests/unit/health-command.spec.ts",
      "scope": "project",
      "note": "activation health regression coverage"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 7200,
      "note": "coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/health-command.spec.ts tests/unit/extension-loader.spec.ts",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "targeted extension health tests"
    },
    {
      "command": "pnpm build",
      "scope": "project",
      "timeout_seconds": 600,
      "note": "compile verification"
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
      "note": "governing spec"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public behavior contract"
    }
  ]
}

Context: health currently surfaces extension discovery and load warnings. Activation failures should also be visible in release diagnostics. Approach: docs-first contract update then wire activation warnings and details into health output with deterministic tests and full regression evidence.
