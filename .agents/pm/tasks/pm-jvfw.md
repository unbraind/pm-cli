{
  "id": "pm-jvfw",
  "title": "M5 roadmap: Runtime wiring for extension registrations",
  "description": "Expand runtime execution wiring for non-flag extension registrations beyond current metadata capture baseline.",
  "type": "Task",
  "status": "closed",
  "priority": 2,
  "tags": [
    "area:extensions",
    "code",
    "milestone:5",
    "pm-cli",
    "roadmap",
    "tests"
  ],
  "created_at": "2026-03-07T21:52:34.802Z",
  "updated_at": "2026-03-07T22:35:00.808Z",
  "deadline": "2026-03-14T21:52:34.802Z",
  "author": "maintainer-agent",
  "estimated_minutes": 180,
  "acceptance_criteria": "Runtime wiring is implemented for at least one additional extension registration family beyond registerFlags help metadata, docs reflect scope accurately, and sandbox-safe regression + coverage remain 100 percent.",
  "dependencies": [
    {
      "id": "pm-b1w",
      "kind": "parent",
      "created_at": "2026-03-07T21:52:34.802Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-07T21:52:34.802Z",
      "author": "maintainer-agent",
      "text": "Why this exists milestone 5 still tracks broader runtime wiring for registered extension definitions in PRD roadmap."
    },
    {
      "created_at": "2026-03-07T22:11:07.687Z",
      "author": "maintainer-agent",
      "text": "Planned change-set: implement runtime command-handler wiring for registerImporter/registerExporter registrations (deterministic '<name> import|export' command paths) with docs-first updates and regression coverage."
    },
    {
      "created_at": "2026-03-07T22:35:00.316Z",
      "author": "maintainer-agent",
      "text": "Implemented docs-first runtime wiring for extension importer/exporter registrations: registerImporter/registerExporter now deterministically surface executable '<name> import|export' command handlers with isolated context snapshots, while preserving registration metadata contracts. Updated PRD.md + README.md and added regression assertions in tests/unit/extension-loader.spec.ts for handler creation and execution."
    },
    {
      "created_at": "2026-03-07T22:35:00.481Z",
      "author": "maintainer-agent",
      "text": "Evidence: pm test pm-jvfw --run --timeout 7200 --json passed (2/2 linked tests, including node scripts/run-tests.mjs coverage with 100% lines/branches/functions/statements). Regression sweeps passed sequentially: pm test-all --status in_progress --timeout 7200 --json => failed=0, passed=2, skipped=0; pm test-all --status closed --timeout 7200 --json => items=137, failed=0, passed=64, skipped=290 deterministic dedupe."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-07T21:52:34.802Z",
      "author": "maintainer-agent",
      "text": "Start by mapping current registration metadata-only paths then implement deterministic runtime wiring with tests."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative extension runtime contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public extension runtime baseline"
    },
    {
      "path": "src/core/extensions/loader.ts",
      "scope": "project",
      "note": "registration plumbing baseline"
    },
    {
      "path": "tests/unit/extension-loader.spec.ts",
      "scope": "project",
      "note": "runtime wiring regression coverage"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 5400,
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
      "note": "maintainer workflow contract"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative roadmap contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public runtime behavior contract"
    }
  ],
  "close_reason": "Importer/exporter registrations now wire deterministic '<name> import|export' runtime handlers with docs and regression coverage updates; pm test + test-all sweeps pass with 100% coverage."
}

Bridge remaining roadmap gap for extension registration runtime wiring after hook call-site expansion: scope includes actionable runtime execution surfaces for registered schema/import/search definitions with deterministic behavior and safety checks.
