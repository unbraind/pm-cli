{
  "id": "pm-mwwp",
  "title": "M5 hardening: enforce extension capability declarations",
  "description": "Require extension APIs to respect manifest capabilities and fail activation when unsupported registration hooks are used.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:extensions",
    "code",
    "docs",
    "milestone:5",
    "pm-cli",
    "priority:1",
    "tests"
  ],
  "created_at": "2026-03-06T09:21:20.880Z",
  "updated_at": "2026-03-06T09:40:05.330Z",
  "deadline": "2026-03-08T09:21:08.000Z",
  "author": "cursor-maintainer",
  "estimated_minutes": 75,
  "acceptance_criteria": "Extension activation rejects register* or hooks.* calls when required capability is missing; README/PRD describe capability enforcement; all linked and regression tests pass with 100% coverage.",
  "comments": [
    {
      "created_at": "2026-03-06T09:21:20.880Z",
      "author": "cursor-maintainer",
      "text": "Capability list is currently descriptive only and should become an enforced safety boundary."
    },
    {
      "created_at": "2026-03-06T09:21:38.917Z",
      "author": "cursor-maintainer",
      "text": "Planned changeset: docs-first update PRD/README capability contracts, then enforce capability checks in extension API registration/hook methods and add extension-loader regressions."
    },
    {
      "created_at": "2026-03-06T09:25:31.855Z",
      "author": "cursor-maintainer",
      "text": "Implemented docs-first + code changes: PRD/README now require capability-gated extension API registrations, loader now enforces capabilities for registerCommand/registerRenderer/hooks/schema/importer/search APIs, and extension-loader unit regressions cover missing-capability activation failures."
    },
    {
      "created_at": "2026-03-06T09:40:04.958Z",
      "author": "cursor-maintainer",
      "text": "Evidence: docs-first updates landed in PRD.md and README.md. Capability enforcement implemented in src/core/extensions/loader.ts for commands/renderers/hooks/schema/importers/search registration APIs. Regression updates in tests/unit/extension-loader.spec.ts and tests/unit/health-command.spec.ts. Validation commands: pm test pm-mwwp --run --timeout 7200 --json => linked_tests=2 passed=2 failed=0 skipped=0; pm test-all --status in_progress --timeout 7200 --json => items=1 linked_tests=2 passed=2 failed=0 skipped=0; pm test-all --status closed --timeout 7200 --json => items=84 linked_tests=253 passed=62 failed=0 skipped=191. Coverage statement: node scripts/run-tests.mjs coverage reports 100% lines/branches/functions/statements (All files 100/100/100/100)."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-06T09:21:20.880Z",
      "author": "cursor-maintainer",
      "text": "Docs-first update then loader capability checks and unit coverage."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "Capability enforcement contract update"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "Capability-enforcement documentation"
    },
    {
      "path": "src/core/extensions/loader.ts",
      "scope": "project",
      "note": "Capability enforcement implementation"
    },
    {
      "path": "tests/unit/extension-loader.spec.ts",
      "scope": "project",
      "note": "Capability-enforcement regression coverage"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 240,
      "note": "Coverage gate proof"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/extension-loader.spec.ts",
      "scope": "project",
      "timeout_seconds": 240,
      "note": "Targeted extension-loader regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "Maintainer workflow and safety contract"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "Authoritative extension capability contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "Public command and extension contract"
    }
  ]
}

Add capability gating for extension API registration methods so manifests explicitly declare commands/renderers/hooks/schema/importers/search usage. Keep deterministic activation failure behavior and validate with targeted+full regression runs.
