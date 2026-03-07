{
  "id": "pm-m91u",
  "title": "Contributing maintainer bootstrap global-install parity",
  "description": "Align CONTRIBUTING maintainer bootstrap with AGENTS requirement to refresh global pm from this repository before mutations.",
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
  "created_at": "2026-03-06T21:09:54.214Z",
  "updated_at": "2026-03-06T21:21:21.586Z",
  "deadline": "2026-03-07T21:09:54.214Z",
  "author": "maintainer-agent",
  "estimated_minutes": 75,
  "acceptance_criteria": "CONTRIBUTING maintainer bootstrap explicitly requires npm install -g . and pm --version verification before mutation runs; release-readiness tests enforce this contract and 100% coverage remains intact.",
  "dependencies": [
    {
      "id": "pm-uh4d",
      "kind": "related",
      "created_at": "2026-03-06T21:09:54.214Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-06T21:09:54.214Z",
      "author": "maintainer-agent",
      "text": "Why this exists: AGENTS already requires global install refresh but CONTRIBUTING bootstrap omits the explicit command."
    },
    {
      "created_at": "2026-03-06T21:10:17.174Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: update CONTRIBUTING maintainer bootstrap to include npm install -g . refresh requirement and add release-readiness contract assertions to keep CONTRIBUTING aligned with AGENTS bootstrap policy."
    },
    {
      "created_at": "2026-03-06T21:10:44.627Z",
      "author": "maintainer-agent",
      "text": "Implemented docs-first parity update: CONTRIBUTING maintainer bootstrap now requires npm install -g . + pm --version before selecting PM_CMD, and release-readiness contract tests now assert CONTRIBUTING bootstrap tokens for global-install dogfooding parity."
    },
    {
      "created_at": "2026-03-06T21:21:21.243Z",
      "author": "maintainer-agent",
      "text": "Evidence: refreshed global install from repo (npm install -g . => up to date; pm --version => 0.1.0). pnpm build passed. pm test pm-m91u --run --timeout 7200 --json passed linked tests (2 passed, 0 failed, 0 skipped). pm test-all --status in_progress --timeout 7200 --json passed (items=1 linked_tests=2 passed=2 failed=0 skipped=0). pm test-all --status closed --timeout 7200 --json passed (items=106 linked_tests=294 passed=63 failed=0 skipped=231). Coverage remains 100% lines/branches/functions/statements."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-06T21:09:54.214Z",
      "author": "maintainer-agent",
      "text": "Plan: docs-first update CONTRIBUTING then add release-readiness assertion and run pm test + pm test-all sweeps."
    }
  ],
  "files": [
    {
      "path": "CONTRIBUTING.md",
      "scope": "project",
      "note": "maintainer bootstrap guidance"
    },
    {
      "path": "tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "note": "contract guard for contributing bootstrap"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 2400,
      "note": "sandbox-safe coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "release-readiness contract regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "authoritative maintainer bootstrap requirement"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "release-ready docs contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public bootstrap and release guidance"
    }
  ],
  "close_reason": "CONTRIBUTING bootstrap now includes required global install refresh and contract test guard; required build + pm test + pm test-all sweeps passed with 100% coverage."
}

Docs-first parity change: add explicit npm install -g . bootstrap step to CONTRIBUTING maintainer workflow and guard with release-readiness contract coverage.
