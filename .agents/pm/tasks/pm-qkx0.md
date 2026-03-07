{
  "id": "pm-qkx0",
  "title": "M5 follow-up: validate extension registration handler types",
  "description": "Harden extension API registration by validating command and renderer handler functions with deterministic activation failures.",
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
  "created_at": "2026-03-04T16:32:27.596Z",
  "updated_at": "2026-03-04T16:50:01.688Z",
  "deadline": "2026-03-06T16:32:06.000Z",
  "author": "cursor-maintainer",
  "estimated_minutes": 75,
  "acceptance_criteria": "Invalid extension registerCommand and registerRenderer payloads fail activation deterministically with extension_activate_failed warnings and regression tests proving behavior.",
  "dependencies": [
    {
      "id": "pm-b1w",
      "kind": "parent",
      "created_at": "2026-03-04T16:32:27.596Z",
      "author": "cursor-maintainer"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-04T16:32:27.596Z",
      "author": "cursor-maintainer",
      "text": "This exists to close a runtime hardening gap for malformed JS extension registration calls."
    },
    {
      "created_at": "2026-03-04T16:32:35.773Z",
      "author": "cursor-maintainer",
      "text": "Implementing deterministic runtime checks for malformed registerCommand definitions and registerRenderer handlers before adding regression assertions."
    },
    {
      "created_at": "2026-03-04T16:33:12.958Z",
      "author": "cursor-maintainer",
      "text": "Implemented loader runtime guards so registerCommand now requires a definition object and string name and registerRenderer now requires a function handler."
    },
    {
      "created_at": "2026-03-04T16:50:01.381Z",
      "author": "cursor-maintainer",
      "text": "Evidence: pm test pm-qkx0 --run passed (1 linked test). pm test-all --status in_progress passed (items=1 passed=1 failed=0). First pm test-all --status closed run surfaced coverage regression at 99.96 after new validation guards. Added invalid command definition name type regression coverage in tests/unit/extension-loader.spec.ts. Re-ran pm test-all --status closed and it passed (items=52 linked_tests=176 passed=56 failed=0 skipped=120). coverage/coverage-summary.json now reports 100% lines statements branches and functions."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-04T16:32:27.596Z",
      "author": "cursor-maintainer",
      "text": "Implement validation in extension API and cover with unit tests then run pm test sweeps."
    }
  ],
  "learnings": [
    {
      "created_at": "2026-03-04T16:32:27.596Z",
      "author": "cursor-maintainer",
      "text": "Runtime validation is required even with TypeScript types because extensions may be plain JavaScript."
    }
  ],
  "files": [
    {
      "path": "src/core/extensions/loader.ts",
      "scope": "project",
      "note": "extension api validation logic"
    },
    {
      "path": "tests/unit/extension-loader.spec.ts",
      "scope": "project",
      "note": "regression coverage for invalid registration"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/extension-loader.spec.ts",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "targeted extension loader regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "dogfood tracking workflow"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "milestone 5 extension hardening contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public extension behavior contract"
    }
  ]
}

Add strict runtime validation for registerCommand definition payloads and registerRenderer handlers so malformed JS extensions fail deterministically.
