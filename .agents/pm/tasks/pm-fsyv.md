{
  "id": "pm-fsyv",
  "title": "M5: Enforce symlink-resolved extension entry boundary",
  "description": "Harden extension loader so entry containment is validated after symlink resolution.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:extensions-loader",
    "code",
    "milestone:5",
    "pm-cli",
    "priority:1",
    "security",
    "tests"
  ],
  "created_at": "2026-03-03T23:15:51.883Z",
  "updated_at": "2026-03-03T23:37:02.045Z",
  "deadline": "2026-03-10T23:15:51.000Z",
  "author": "cursor-maintainer",
  "estimated_minutes": 90,
  "acceptance_criteria": "Extension discovery/load rejects symlink-escaped entries with deterministic warnings, docs are aligned first, and coverage-gated tests verify both escaped and in-tree symlink entry behavior.",
  "dependencies": [
    {
      "id": "pm-7sd",
      "kind": "discovered_from",
      "created_at": "2026-03-03T23:15:51.883Z",
      "author": "cursor-maintainer"
    },
    {
      "id": "pm-b1w",
      "kind": "parent",
      "created_at": "2026-03-03T23:15:51.883Z",
      "author": "cursor-maintainer"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-03T23:15:51.883Z",
      "author": "cursor-maintainer",
      "text": "Symlink escapes can bypass current entry boundary checks and this task hardens containment."
    },
    {
      "created_at": "2026-03-03T23:16:07.069Z",
      "author": "cursor-maintainer",
      "text": "Planned changeset: docs-first clarify symlink-resolved entry containment semantics, then implement loader realpath enforcement with unit coverage for escaped and in-tree symlink targets."
    },
    {
      "created_at": "2026-03-03T23:27:52.881Z",
      "author": "cursor-maintainer",
      "text": "Implemented docs-first symlink boundary hardening. Docs: PRD.md and README.md now require extension entry containment after canonical realpath resolution including symlink targets. Code: src/core/extensions/loader.ts now validates entry containment after canonical resolution. Tests: tests/unit/extension-loader.spec.ts now covers symlink escape rejection and in-tree symlink acceptance. Evidence: node dist/cli.js test pm-fsyv --run --timeout 7200 --json passed 2/2 linked tests; node dist/cli.js test-all --status in_progress --timeout 7200 --json totals items=8 linked_tests=32 passed=14 failed=0 skipped=18; node dist/cli.js test-all --status closed --timeout 7200 --json totals items=35 linked_tests=123 passed=50 failed=0 skipped=73. Coverage statement: linked coverage runs remained 100% lines/branches/functions/statements."
    },
    {
      "created_at": "2026-03-03T23:37:02.045Z",
      "author": "cursor-maintainer",
      "text": "Post-lint refactor verification: refactored scanExtensionLayer path into scanExtensionDirectory helper to resolve introduced cognitive-complexity warning without behavior changes. Re-ran required evidence after this code change: node dist/cli.js test pm-fsyv --run --timeout 7200 --json passed 2/2 linked tests; node dist/cli.js test-all --status in_progress --timeout 7200 --json totals items=7 linked_tests=30 passed=14 failed=0 skipped=16; node dist/cli.js test-all --status closed --timeout 7200 --json totals items=36 linked_tests=125 passed=50 failed=0 skipped=75. Coverage remains 100% lines/branches/functions/statements in linked coverage runs."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-03T23:15:51.883Z",
      "author": "cursor-maintainer",
      "text": "Docs-first update then loader realpath enforcement and unit regression coverage."
    }
  ],
  "learnings": [
    {
      "created_at": "2026-03-03T23:15:51.883Z",
      "author": "cursor-maintainer",
      "text": "none"
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative security semantics"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "docs-first boundary contract update"
    },
    {
      "path": "src/core/extensions/loader.ts",
      "scope": "project",
      "note": "planned symlink boundary hardening"
    },
    {
      "path": "tests/unit/extension-loader.spec.ts",
      "scope": "project",
      "note": "symlink boundary regression coverage"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 2400,
      "note": "coverage gate proof"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/extension-loader.spec.ts",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "targeted loader regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "workflow and test safety contract"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "governing security contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public contract update"
    }
  ]
}

Current entry containment checks use resolved path strings but do not validate symlink targets. Add realpath-aware containment enforcement so entries escaping extension directories via symlinks are rejected deterministically.
