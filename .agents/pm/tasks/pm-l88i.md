{
  "id": "pm-l88i",
  "title": "M5 follow-up: include built-in extensions in health probe",
  "description": "Align pm health extension diagnostics with runtime by including built-in extension activation/load results.",
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
  "created_at": "2026-03-06T06:55:04.808Z",
  "updated_at": "2026-03-06T07:12:36.645Z",
  "deadline": "2026-03-07T23:59:00.000Z",
  "author": "maintainer-agent",
  "estimated_minutes": 75,
  "acceptance_criteria": "pm health extension check includes built-in extensions in activation/loaded diagnostics with deterministic ordering and warning behavior; docs reflect contract; sandboxed tests remain 100 percent coverage.",
  "dependencies": [
    {
      "id": "pm-pjj7",
      "kind": "related",
      "created_at": "2026-03-06T06:55:04.808Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-06T06:55:04.808Z",
      "author": "maintainer-agent",
      "text": "Why this exists: keep health diagnostics aligned with runtime extension behavior by probing built-in extensions too."
    },
    {
      "created_at": "2026-03-06T06:55:17.798Z",
      "author": "maintainer-agent",
      "text": "Planned changeset before edits: docs-first update README and PRD to require built-in extension inclusion in health probe, then implement shared built-in extension helper and wire health to include built-ins with deterministic activation metadata and tests."
    },
    {
      "created_at": "2026-03-06T07:00:04.380Z",
      "author": "maintainer-agent",
      "text": "Implemented docs-first contract updates in README and PRD, added shared built-in extension helper module, refactored CLI runtime loading to use it, and updated health probe path to include enabled built-in extensions in loaded/activation diagnostics."
    },
    {
      "created_at": "2026-03-06T07:11:48.839Z",
      "author": "maintainer-agent",
      "text": "Evidence: pm test pm-l88i --run --timeout 7200 --json passed all 4 linked checks (coverage, helper unit test, health+loader targeted suite, build). pm test-all --status in_progress --timeout 7200 --json passed totals items=1 linked_tests=4 passed=4 failed=0 skipped=0. pm test-all --status closed --timeout 7200 --json passed totals items=79 linked_tests=237 passed=61 failed=0 skipped=176. Coverage statement: node scripts/run-tests.mjs coverage reports 100 percent statements, branches, functions, and lines."
    },
    {
      "created_at": "2026-03-06T07:12:36.645Z",
      "author": "maintainer-agent",
      "text": "Follow-up fix during verification: added src/core/extensions/builtins.ts to vitest coverage include allowlist and updated health activation-probe expectation to command_handler_count=3 because built-in beads/todos command handlers are now part of health activation diagnostics."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-06T06:55:04.808Z",
      "author": "maintainer-agent",
      "text": "Plan docs-first update then implement health probe built-in inclusion plus tests."
    }
  ],
  "learnings": [
    {
      "created_at": "2026-03-06T06:55:04.808Z",
      "author": "maintainer-agent",
      "text": "Initial assumption health currently omits built-ins from activation probe details."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "PRD contract update for health built-ins"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "doc contract update for health"
    },
    {
      "path": "src/cli/commands/health.ts",
      "scope": "project",
      "note": "health extension probe runtime parity"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "reuse shared built-in extension helper"
    },
    {
      "path": "src/core/extensions/builtins.ts",
      "scope": "project",
      "note": "shared built-in extension metadata helper"
    },
    {
      "path": "tests/unit/extensions-builtins.spec.ts",
      "scope": "project",
      "note": "shared built-in extension helper coverage"
    },
    {
      "path": "tests/unit/health-command.spec.ts",
      "scope": "project",
      "note": "health diagnostics regression coverage"
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
      "command": "node scripts/run-tests.mjs test -- tests/unit/extensions-builtins.spec.ts",
      "scope": "project",
      "timeout_seconds": 900,
      "note": "built-in extension helper unit coverage"
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
      "note": "public contract"
    }
  ]
}

Context: runtime command execution always includes built-in beads/todos extensions (subject to settings), but health extension diagnostics currently probe only filesystem-loaded extensions. Approach: docs-first contract update, wire health probe to include built-ins with deterministic ordering, and add regression tests.
