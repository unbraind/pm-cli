{
  "id": "pm-uh4d",
  "title": "Release-readiness loop: enforce global install bootstrap contract",
  "description": "Document and test the maintainer requirement to refresh global pm from this repository during bootstrap.",
  "type": "Chore",
  "status": "closed",
  "priority": 0,
  "tags": [
    "area:bootstrap",
    "contract-sync",
    "doc",
    "maintenance",
    "pm-cli",
    "priority:0",
    "release-readiness",
    "tests"
  ],
  "created_at": "2026-03-06T20:52:25.754Z",
  "updated_at": "2026-03-06T21:03:27.886Z",
  "deadline": "2026-03-07T20:52:25.754Z",
  "author": "maintainer-agent",
  "estimated_minutes": 90,
  "acceptance_criteria": "AGENTS session bootstrap explicitly requires refreshing global pm from this repository and release-readiness contract tests enforce the text contract; sandbox-safe verification remains 100 percent coverage.",
  "dependencies": [
    {
      "id": "pm-lfae",
      "kind": "related",
      "created_at": "2026-03-06T20:52:25.754Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-06T20:52:25.754Z",
      "author": "maintainer-agent",
      "text": "Why this exists: convert maintainer global-install habit into explicit doc plus regression contract guard."
    },
    {
      "created_at": "2026-03-06T20:52:35.909Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: update AGENTS session bootstrap with explicit npm install -g . refresh + verification guidance, then extend release-readiness contract tests to assert that guidance remains present."
    },
    {
      "created_at": "2026-03-06T21:03:27.432Z",
      "author": "maintainer-agent",
      "text": "Implemented docs-first bootstrap hardening: AGENTS session bootstrap now explicitly requires running npm install -g . from repo root and verifying pm --version before mutation commands; release-readiness contract test now enforces those tokens."
    },
    {
      "created_at": "2026-03-06T21:03:27.581Z",
      "author": "maintainer-agent",
      "text": "Evidence: npm install -g . succeeded and pm --version reports 0.1.0. pm test pm-uh4d --run --timeout 7200 passed linked tests (coverage + release-readiness spec). pm test-all --status in_progress --timeout 7200 passed (items=1 linked_tests=2 passed=2 failed=0 skipped=0). pm test-all --status closed --timeout 7200 passed (items=105 linked_tests=292 passed=63 failed=0 skipped=229). Coverage remains 100% lines/branches/functions/statements."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-06T20:52:25.754Z",
      "author": "maintainer-agent",
      "text": "Docs first then tests then full pm verification and evidence logging."
    }
  ],
  "files": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "bootstrap guidance source of truth"
    },
    {
      "path": "tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "note": "bootstrap contract assertions"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "sandbox-safe coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "contract regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "authoritative maintainer workflow"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "governing contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public contract reference"
    }
  ],
  "close_reason": "Bootstrap global-install contract is now explicit in AGENTS and guarded by release-readiness tests; all required pm test and test-all sweeps passed with coverage at 100%."
}

Context: maintainer runs already execute global install refresh, but this is not explicitly guarded in release-readiness contracts.\nApproach: update AGENTS bootstrap section first, then extend release-readiness contract tests to assert this guidance stays present.
