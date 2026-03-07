{
  "id": "pm-8mkp",
  "title": "README maintainer bootstrap parity with AGENTS",
  "description": "Add explicit maintainer bootstrap dogfooding guidance to README and enforce it via release-readiness contract tests.",
  "type": "Chore",
  "status": "closed",
  "priority": 0,
  "tags": [
    "area:bootstrap",
    "area:docs",
    "doc",
    "milestone:6",
    "pm-cli",
    "priority:0",
    "release-readiness",
    "tests"
  ],
  "created_at": "2026-03-06T21:55:52.775Z",
  "updated_at": "2026-03-06T22:07:34.887Z",
  "deadline": "2026-03-08T22:00:00.000Z",
  "author": "maintainer-agent",
  "estimated_minutes": 75,
  "acceptance_criteria": "README includes explicit maintainer bootstrap requirements (PM_AUTHOR, npm install -g ., PM_CMD selection, pm --version, PM_PATH/PM_GLOBAL_PATH sandbox guidance), release-readiness tests enforce the section, and full verification sweeps pass with 100% coverage.",
  "dependencies": [
    {
      "id": "pm-m91u",
      "kind": "related",
      "created_at": "2026-03-06T21:55:52.775Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-06T21:55:52.775Z",
      "author": "maintainer-agent",
      "text": "Why this exists: README should include maintainer bootstrap parity so release workflows are discoverable in the primary docs."
    },
    {
      "created_at": "2026-03-06T21:56:07.832Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: add a Maintainer Bootstrap section to README with PM_AUTHOR/global-install/PM_CMD selection and sandbox test guidance, then extend release-readiness contract tests to enforce these README tokens."
    },
    {
      "created_at": "2026-03-06T21:56:43.333Z",
      "author": "maintainer-agent",
      "text": "Implemented docs-first parity update: README now contains a Maintainer Bootstrap section aligned with AGENTS/CONTRIBUTING, and release-readiness contract tests now assert required README bootstrap tokens."
    },
    {
      "created_at": "2026-03-06T22:07:28.904Z",
      "author": "maintainer-agent",
      "text": "Evidence: pm test pm-8mkp --run --timeout 7200 --json passed linked tests (2/2). pm test-all --status in_progress --timeout 7200 --json passed (items=1 linked_tests=2 passed=2 failed=0 skipped=0). pm test-all --status closed --timeout 7200 --json passed (items=108 linked_tests=297 passed=63 failed=0 skipped=234). Coverage remains 100% lines/branches/functions/statements."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-06T21:55:52.775Z",
      "author": "maintainer-agent",
      "text": "Plan: docs-first README update then release-readiness contract assertions then mandatory pm test and test-all sweeps."
    }
  ],
  "files": [
    {
      "path": "README.md",
      "scope": "project",
      "note": "add maintainer bootstrap section"
    },
    {
      "path": "tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "note": "assert README bootstrap section tokens"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 2400,
      "note": "coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "contract regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "authoritative maintainer bootstrap policy"
    },
    {
      "path": "CONTRIBUTING.md",
      "scope": "project",
      "note": "existing bootstrap reference"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "release-ready docs contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public maintainer workflow guidance"
    }
  ],
  "close_reason": "README maintainer bootstrap guidance now matches AGENTS/CONTRIBUTING and contract tests enforce parity; verification sweeps passed with 100% coverage."
}

README currently lacks an explicit maintainer bootstrap section even though AGENTS and CONTRIBUTING require it. This change keeps maintainer workflow discoverable from the primary project page and prevents drift with contract tests.
