{
  "id": "pm-zre8",
  "title": "Maintain release readiness 2026-03-09 (Run 7)",
  "description": "Align maintainer bootstrap docs and release-readiness contracts to require runtime/version/build sanity checks before mutation runs.",
  "type": "Chore",
  "status": "closed",
  "priority": 0,
  "tags": [
    "area:bootstrap",
    "doc",
    "milestone:6",
    "pm-cli",
    "priority:0",
    "tests"
  ],
  "created_at": "2026-03-09T17:05:54.655Z",
  "updated_at": "2026-03-09T17:26:39.703Z",
  "deadline": "2026-03-10T23:59:00.000Z",
  "author": "maintainer-agent",
  "estimated_minutes": 75,
  "acceptance_criteria": "AGENTS and README maintainer bootstrap sections explicitly include node -v, pnpm -v, and pnpm build checks; release-readiness contract test enforces all bootstrap sections include this sanity baseline; pm test and pm test-all sweeps pass with 100% coverage.",
  "definition_of_ready": "Bootstrap parity gap confirmed across authoritative docs and contract tests.",
  "order": 1,
  "goal": "Release-hardening",
  "objective": "Keep maintainer bootstrap workflow deterministic and complete",
  "value": "Reduces bootstrap drift and failed maintainer runs",
  "impact": "Improves reliability of dogfooding sessions",
  "outcome": "All maintainer bootstrap docs enforce the same sanity checklist",
  "why_now": "Current docs are partially inconsistent on runtime/build preflight guidance",
  "risk": "low",
  "confidence": "high",
  "sprint": "maintainer-loop-2026-03-09-7",
  "release": "v0.1",
  "regression": false,
  "dependencies": [
    {
      "id": "pm-j0o4",
      "kind": "related",
      "created_at": "2026-03-09T17:05:54.655Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-09T17:05:54.655Z",
      "author": "maintainer-agent",
      "text": "Why this exists CONTRIBUTING includes runtime/build sanity checks but AGENTS and README bootstrap sections and contracts should enforce the same baseline."
    },
    {
      "created_at": "2026-03-09T17:06:09.395Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: update README and AGENTS maintainer bootstrap snippets to include node -v, pnpm -v, and pnpm build; extend release-readiness contract assertions so all bootstrap docs enforce identical sanity checks."
    },
    {
      "created_at": "2026-03-09T17:07:11.510Z",
      "author": "maintainer-agent",
      "text": "Implemented docs-first parity update: AGENTS session bootstrap now includes baseline runtime/build sanity checks (PM_CMD --version, node -v, pnpm -v, pnpm build), README maintainer bootstrap now includes node/pnpm/build checks, and release-readiness contract assertions now enforce these tokens across AGENTS/CONTRIBUTING/README bootstrap sections."
    },
    {
      "created_at": "2026-03-09T17:24:43.654Z",
      "author": "maintainer-agent",
      "text": "Validation evidence: pm test pm-zre8 --run --timeout 3600 passed (2/2 linked tests: node scripts/run-tests.mjs coverage and targeted release-readiness contract). pm test-all --status in_progress --timeout 3600 passed totals items=1 linked_tests=2 passed=2 failed=0 skipped=0. pm test-all --status closed --timeout 3600 passed totals items=179 linked_tests=426 passed=79 failed=0 skipped=347. Coverage remained 100 percent lines branches functions and statements."
    },
    {
      "created_at": "2026-03-09T17:26:39.703Z",
      "author": "maintainer-agent",
      "text": "Delivery evidence: committed as 93c4065 and pushed to origin/main after passing pm test, pm test-all in_progress, and pm test-all closed sweeps with 100 percent coverage."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-09T17:05:54.655Z",
      "author": "maintainer-agent",
      "text": "Plan update AGENTS and README bootstrap snippets first then extend release-readiness contract assertions and run pm test plus test-all sweeps."
    }
  ],
  "files": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "bootstrap sanity checklist parity"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "add runtime/build sanity checks to maintainer bootstrap"
    },
    {
      "path": "tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "note": "enforce bootstrap sanity tokens"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 2400,
      "note": "full coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "bootstrap contract regression"
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
      "note": "governing product contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "maintainer bootstrap parity"
    }
  ],
  "close_reason": "Bootstrap sanity checks aligned across AGENTS README and contracts; pm test and test-all sweeps passed with 100 percent coverage."
}

Docs-first maintenance run to align AGENTS and README maintainer bootstrap sections with CONTRIBUTING baseline sanity checks (node -v, pnpm -v, pnpm build) and lock parity with release-readiness contract tests.
