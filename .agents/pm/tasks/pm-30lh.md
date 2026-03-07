{
  "id": "pm-30lh",
  "title": "M5 follow-up: validate extension hook registration handlers",
  "description": "Harden extension API hook registration so non-function handlers fail activation deterministically.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:extensions",
    "code",
    "milestone:5",
    "pm-cli",
    "priority:1",
    "tests"
  ],
  "created_at": "2026-03-04T19:12:46.724Z",
  "updated_at": "2026-03-04T19:31:06.396Z",
  "deadline": "2026-03-06T23:59:00.000Z",
  "author": "cursor-maintainer",
  "estimated_minutes": 75,
  "acceptance_criteria": "Non-function hook registrations fail extension activation deterministically, docs are aligned, and regression tests plus pm test/pm test-all sweeps pass with 100% coverage.",
  "dependencies": [
    {
      "id": "pm-b1w",
      "kind": "parent",
      "created_at": "2026-03-04T19:12:46.724Z",
      "author": "cursor-maintainer"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-04T19:12:46.724Z",
      "author": "cursor-maintainer",
      "text": "This task closes runtime hardening gaps for malformed hook registration payloads in JS extensions."
    },
    {
      "created_at": "2026-03-04T19:12:56.109Z",
      "author": "cursor-maintainer",
      "text": "Planned changeset: docs-first update PRD and README to require hook registration handler validation, then enforce runtime function checks for api.hooks registrations in extension loader and add extension-loader regression tests."
    },
    {
      "created_at": "2026-03-04T19:14:01.682Z",
      "author": "cursor-maintainer",
      "text": "Docs-first update complete: PRD and README now require registration-time validation for hook handlers with deterministic activation failure semantics."
    },
    {
      "created_at": "2026-03-04T19:30:57.032Z",
      "author": "cursor-maintainer",
      "text": "Implemented docs-first + code changeset: updated PRD.md and README.md to define registration-time hook handler validation, added runtime function checks for api.hooks.beforeCommand/afterCommand/onWrite/onRead/onIndex in src/core/extensions/loader.ts, and extended tests/unit/extension-loader.spec.ts with invalid-hook activation regressions for all hook registration APIs."
    },
    {
      "created_at": "2026-03-04T19:30:57.210Z",
      "author": "cursor-maintainer",
      "text": "Evidence: pm test pm-30lh --run --timeout 7200 --json passed 2/2 linked tests (coverage + targeted extension-loader suite). pm test-all --status in_progress --timeout 7200 --json passed totals items=1 linked_tests=2 passed=2 failed=0 skipped=0. pm test-all --status closed --timeout 7200 --json passed totals items=54 linked_tests=179 passed=56 failed=0 skipped=123. Coverage statement: node scripts/run-tests.mjs coverage reports 100% statements/branches/functions/lines. Follow-up items created: none."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-04T19:12:46.724Z",
      "author": "cursor-maintainer",
      "text": "Update docs first then enforce hook registration function checks and extend extension-loader tests."
    }
  ],
  "learnings": [
    {
      "created_at": "2026-03-04T19:12:46.724Z",
      "author": "cursor-maintainer",
      "text": "Runtime guardrails are required even when TypeScript signatures exist because extensions execute as JavaScript."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "docs-first hook validation contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "docs-first public behavior update"
    },
    {
      "path": "src/core/extensions/loader.ts",
      "scope": "project",
      "note": "hook registration runtime validation"
    },
    {
      "path": "tests/unit/extension-loader.spec.ts",
      "scope": "project",
      "note": "regression coverage for invalid hook registration"
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
      "command": "node scripts/run-tests.mjs test -- tests/unit/extension-loader.spec.ts",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "targeted extension loader regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "dogfood workflow requirements"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "extension registration contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public extension behavior contract"
    }
  ]
}

Add runtime validation for api.hooks.beforeCommand/afterCommand/onWrite/onRead/onIndex registration inputs so malformed JS extensions fail during activation with deterministic warnings.
