{
  "id": "pm-wdgn",
  "title": "Harden chained sandbox env detection per segment",
  "description": "Require sandbox-safe evaluation per chained command segment for pm test --add direct runner validation.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:test-command",
    "code",
    "doc",
    "milestone:3",
    "pm-cli",
    "priority:1",
    "tests"
  ],
  "created_at": "2026-03-05T12:46:34.203Z",
  "updated_at": "2026-03-05T12:57:33.617Z",
  "deadline": "2026-03-06T23:59:00.000Z",
  "author": "maintainer-agent",
  "estimated_minutes": 90,
  "acceptance_criteria": "pm test --add rejects chained direct runner segments that lack explicit PM_PATH and PM_GLOBAL_PATH even when other segments set them; docs and unit tests cover the behavior and coverage remains 100 percent.",
  "dependencies": [
    {
      "id": "pm-mlc3",
      "kind": "related",
      "created_at": "2026-03-05T12:46:34.203Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-05T12:46:34.203Z",
      "author": "maintainer-agent",
      "text": "Need per-segment sandbox checks to close a chained-command bypass in pm test add validation"
    },
    {
      "created_at": "2026-03-05T12:46:50.440Z",
      "author": "maintainer-agent",
      "text": "Implementing now: update docs language for chained direct-runner safety semantics, then enforce per-segment sandbox-env validation in src/cli/commands/test.ts and add regression tests for cross-segment bypass attempts."
    },
    {
      "created_at": "2026-03-05T12:48:25.718Z",
      "author": "maintainer-agent",
      "text": "Docs-first update applied in README.md, PRD.md, and AGENTS.md to state chained direct test-runner segments are validated independently. Implemented parser hardening in src/cli/commands/test.ts by requiring explicit PM_PATH+PM_GLOBAL_PATH per unsafe direct-runner segment; added regressions in tests/unit/test-command.spec.ts for cross-segment bypass rejection and per-segment explicit-env acceptance."
    },
    {
      "created_at": "2026-03-05T12:57:27.314Z",
      "author": "maintainer-agent",
      "text": "Evidence: pm test pm-wdgn --run --timeout 2400 --json => linked_tests=2 passed=2 failed=0. pm test-all --status in_progress --timeout 2400 --json => items=1 linked_tests=2 passed=2 failed=0 skipped=0. pm test-all --status closed --timeout 2400 --json => items=70 linked_tests=216 passed=59 failed=0 skipped=157. Coverage gate remains 100% lines/branches/functions/statements."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-05T12:46:34.203Z",
      "author": "maintainer-agent",
      "text": "Update docs first then implement parser hardening and regression tests"
    }
  ],
  "learnings": [
    {
      "created_at": "2026-03-05T12:46:34.203Z",
      "author": "maintainer-agent",
      "text": "Safety checks for chained shell commands must evaluate segment boundaries"
    }
  ],
  "files": [
    {
      "path": "src/cli/commands/test.ts",
      "scope": "project",
      "note": "sandbox direct-runner validation"
    },
    {
      "path": "tests/unit/test-command.spec.ts",
      "scope": "project",
      "note": "regression coverage"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 2400,
      "note": "coverage gate verification"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/test-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "targeted test-command regressions"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "dogfood and test safety protocol"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative behavior contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "clarify chained sandbox env requirement"
    }
  ]
}

Current sandbox env detection in pm test --add is command-wide. Chained commands can pass validation when PM_PATH and PM_GLOBAL_PATH are set in one segment but an unsafe direct runner appears in a different segment. Tighten validation so each chained direct-runner segment must either use node scripts/run-tests.mjs or explicitly set both env vars.
