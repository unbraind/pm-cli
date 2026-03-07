{
  "id": "pm-hzh6",
  "title": "M5 hardening: unknown extension capability diagnostics",
  "description": "Add deterministic unknown-capability diagnostics during extension discovery while preserving capability gating and activation isolation.",
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
  "created_at": "2026-03-06T09:42:43.394Z",
  "updated_at": "2026-03-06T09:57:36.684Z",
  "deadline": "2026-03-08T09:42:43.394Z",
  "author": "cursor-maintainer",
  "estimated_minutes": 60,
  "acceptance_criteria": "discover/load surfaces deterministic extension_capability_unknown diagnostics for unknown manifest capability names; known capability enforcement behavior remains intact; README/PRD are aligned; linked tests and regression suite pass with 100% coverage.",
  "dependencies": [
    {
      "id": "pm-mwwp",
      "kind": "related",
      "created_at": "2026-03-06T09:42:43.394Z",
      "author": "cursor-maintainer"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-06T09:42:43.394Z",
      "author": "cursor-maintainer",
      "text": "Unknown capability names should be explicit diagnostics instead of silent no-ops."
    },
    {
      "created_at": "2026-03-06T09:42:57.987Z",
      "author": "cursor-maintainer",
      "text": "Planned changeset: update PRD/README capability contract to specify unknown-capability diagnostics, then implement deterministic extension_capability_unknown warnings in loader discovery and add regression assertions."
    },
    {
      "created_at": "2026-03-06T09:57:36.333Z",
      "author": "cursor-maintainer",
      "text": "Implemented docs-first hardening for unknown manifest capability names: PRD.md + README.md now specify deterministic extension_capability_unknown diagnostics; loader discovery now emits extension_capability_unknown:<layer>:<name>:<capability> warnings while preserving load/activation isolation; tests/unit/extension-loader.spec.ts now asserts unknown-capability warnings and non-blocking load behavior. Verification: pm test pm-hzh6 --run --timeout 7200 --json => linked_tests=2 passed=2 failed=0 skipped=0; pm test-all --status in_progress --timeout 7200 --json => items=1 linked_tests=2 passed=2 failed=0 skipped=0; pm test-all --status closed --timeout 7200 --json => items=85 linked_tests=255 passed=62 failed=0 skipped=193. Coverage evidence remains 100% lines/branches/functions/statements from linked coverage run."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-06T09:42:43.394Z",
      "author": "cursor-maintainer",
      "text": "Docs-first update then loader warning implementation then regression tests and coverage."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "Specify unknown capability diagnostics"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "Document unknown-capability diagnostics"
    },
    {
      "path": "src/core/extensions/loader.ts",
      "scope": "project",
      "note": "Add unknown-capability diagnostic generation"
    },
    {
      "path": "tests/unit/extension-loader.spec.ts",
      "scope": "project",
      "note": "Add unknown-capability warning regression"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 240,
      "note": "Coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/extension-loader.spec.ts",
      "scope": "project",
      "timeout_seconds": 240,
      "note": "Loader discovery regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "Agent workflow policy"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "Document unknown-capability diagnostics"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "Public extension diagnostics contract"
    }
  ]
}

Context: extension manifests now enforce declared known capabilities but unknown capability names are silently ignored. Approach: add deterministic discovery-time diagnostics for unknown capability names, document behavior, and cover with unit tests while keeping runtime failure isolation unchanged.
