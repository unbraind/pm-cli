{
  "id": "pm-jiw",
  "title": "Milestone 6 - Hardening + Release Readiness",
  "description": "Milestone epic for CI hardening fixtures and release validation.",
  "type": "Epic",
  "status": "closed",
  "priority": 0,
  "tags": [
    "area:release",
    "core",
    "milestone:6",
    "pm-cli"
  ],
  "created_at": "2026-02-17T23:01:12.657Z",
  "updated_at": "2026-03-04T16:22:28.059Z",
  "deadline": "2026-03-19T23:01:12.657Z",
  "author": "steve",
  "estimated_minutes": 360,
  "acceptance_criteria": "Milestone 6 checklist items are implemented and release gates pass.",
  "dependencies": [
    {
      "id": "pm-b1w",
      "kind": "blocks",
      "created_at": "2026-02-17T23:01:12.657Z",
      "author": "steve"
    },
    {
      "id": "pm-j7a",
      "kind": "child",
      "created_at": "2026-02-17T23:01:12.657Z",
      "author": "steve"
    }
  ],
  "comments": [
    {
      "created_at": "2026-02-17T23:01:12.657Z",
      "author": "steve",
      "text": "Milestone 6 stabilizes quality and release confidence."
    },
    {
      "created_at": "2026-03-04T16:13:16.657Z",
      "author": "cursor-maintainer",
      "text": "Planned change-set: verify milestone-6 release-readiness gates (build + full coverage + pm test-all regressions) and close this epic only if evidence confirms acceptance criteria."
    },
    {
      "created_at": "2026-03-04T16:22:22.204Z",
      "author": "cursor-maintainer",
      "text": "Evidence: pm test pm-jiw --run --timeout 1800 passed (node scripts/run-tests.mjs coverage) with 48/48 test files passing and coverage at 100% lines/branches/functions/statements. Regression sweeps passed via pm test-all --status in_progress --timeout 1800 (1 passed, 0 failed) and pm test-all --status closed --timeout 1800 (56 passed, 0 failed, 119 skipped deterministic duplicates)."
    }
  ],
  "notes": [
    {
      "created_at": "2026-02-17T23:01:12.657Z",
      "author": "steve",
      "text": "Success means CI matrix and docs examples are validated in tests."
    }
  ],
  "files": [
    {
      "path": ".github/workflows/ci.yml",
      "scope": "project",
      "note": "CI release gate matrix"
    },
    {
      "path": "package.json",
      "scope": "project",
      "note": "build and coverage scripts for release gates"
    },
    {
      "path": "scripts/run-tests.mjs",
      "scope": "project",
      "note": "sandbox-safe regression runner"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "full coverage gate in sandbox"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "dogfood workflow and verification protocol"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative release criteria"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public command and release contract"
    }
  ]
}

Finalize release readiness with tests fixtures and docs validation.
