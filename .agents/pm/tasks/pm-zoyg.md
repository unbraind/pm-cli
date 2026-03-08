{
  "id": "pm-zoyg",
  "title": "Preserve confidence in todos import mapping",
  "description": "Docs-first align todos import so confidence metadata round-trips from todos markdown into PM items.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:extensions",
    "area:schema",
    "milestone:7",
    "pm-cli",
    "tests"
  ],
  "created_at": "2026-03-08T03:19:06.134Z",
  "updated_at": "2026-03-08T10:21:34.892Z",
  "deadline": "2026-03-10T03:19:06.134Z",
  "author": "maintainer-agent",
  "estimated_minutes": 90,
  "acceptance_criteria": "Todos import preserves confidence values from markdown front matter and tests prove med alias and numeric confidence round-trip.",
  "comments": [
    {
      "created_at": "2026-03-08T03:19:06.134Z",
      "author": "maintainer-agent",
      "text": "Why this task exists todos import currently loses confidence metadata on reimport."
    },
    {
      "created_at": "2026-03-08T03:21:35.469Z",
      "author": "maintainer-agent",
      "text": "Docs-first and implementation pass complete: PRD and README now describe confidence preservation in todos import, parser now accepts numeric and text confidence values with med normalized to medium, and todos unit regression asserts both paths."
    },
    {
      "created_at": "2026-03-08T03:36:08.302Z",
      "author": "maintainer-agent",
      "text": "Evidence: pm test pm-zoyg --run passed after confidence-coverage fix with full 100 percent coverage and targeted docs and todos tests passing. Regression sweeps also passed: pm test-all --status in_progress (3 passed 0 failed) and pm test-all --status closed (66 passed 0 failed 302 skipped duplicates)."
    },
    {
      "created_at": "2026-03-08T10:21:34.892Z",
      "author": "maintainer-agent",
      "text": "Revalidation evidence (2026-03-08): pm test pm-zoyg --run --timeout 7200 --json passed 3/3 linked tests including node scripts/run-tests.mjs coverage with 100% lines/branches/functions/statements plus todos+release-readiness regressions. Regression sweeps: pm test-all --status in_progress --timeout 7200 --json (items=0) and pm test-all --status closed --timeout 7200 --json (items=145 linked_tests=371 passed=66 failed=0 skipped=305)."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-08T03:19:06.134Z",
      "author": "maintainer-agent",
      "text": "Plan update PRD and README mapping notes then add parser tests and integration coverage."
    }
  ],
  "files": [
    {
      "path": "README.md",
      "scope": "project",
      "note": "planned extension behavior docs updated for confidence mapping"
    },
    {
      "path": "src/extensions/builtins/todos/import-export.ts",
      "scope": "project",
      "note": "confidence import mapping implementation"
    },
    {
      "path": "tests/unit/todos-extension.spec.ts",
      "scope": "project",
      "note": "todos confidence import assertions"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 3600,
      "note": "full coverage gate after todos confidence changes"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "docs parity regression for confidence mapping"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/todos-extension.spec.ts",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "todos confidence regression"
    }
  ],
  "docs": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "todos import export behavior contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "extension behavior contract narrative"
    }
  ],
  "close_reason": "Todos import now preserves confidence metadata with deterministic normalization and full regressions passing."
}

Extend built-in todos import mapping to preserve confidence metadata and validate deterministic normalization behavior.
