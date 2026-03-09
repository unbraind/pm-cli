{
  "id": "pm-6k5l",
  "title": "Maintain release readiness 2026-03-09 (Run 5)",
  "description": "Track cleanup of legacy create_tasks.sh and finalize release-tracking artifacts while revalidating regression and coverage gates.",
  "type": "Chore",
  "status": "closed",
  "priority": 0,
  "tags": [
    "area:maintenance",
    "area:tests",
    "code",
    "doc",
    "milestone:6",
    "pm-cli",
    "priority:0"
  ],
  "created_at": "2026-03-09T15:52:30.417Z",
  "updated_at": "2026-03-09T16:29:47.648Z",
  "deadline": "2026-03-10T16:00:00.000Z",
  "author": "maintainer-agent",
  "estimated_minutes": 45,
  "acceptance_criteria": "Legacy create_tasks.sh removed with no references and pm tracking evidence updated and regression plus coverage gates pass at 100 percent.",
  "goal": "Release-hardening",
  "objective": "Keep repository release-ready post launch",
  "value": "Reduce maintenance drift and prevent stale workflows",
  "impact": "Lowers risk of invalid pm item seeding",
  "outcome": "Repo stays green with simplified maintainer workflow",
  "why_now": "Immediate cleanup after launch prevents stale script reuse",
  "sprint": "maintainer-loop-2026-03-09-5",
  "release": "v0.1",
  "comments": [
    {
      "created_at": "2026-03-09T15:52:30.417Z",
      "author": "maintainer-agent",
      "text": "Why this exists keep post release repo state clean and release ready while enforcing dogfood tracking"
    },
    {
      "created_at": "2026-03-09T15:52:46.132Z",
      "author": "maintainer-agent",
      "text": "Intended changeset remove obsolete create_tasks.sh and keep release evidence current with full regression verification"
    },
    {
      "created_at": "2026-03-09T16:10:28.479Z",
      "author": "maintainer-agent",
      "text": "Observed regression in closed sweep item pm-tq1 installer command fails with npm EEXIST when prefix already contains pm binary; implementing idempotent installer fix"
    },
    {
      "created_at": "2026-03-09T16:29:36.935Z",
      "author": "maintainer-agent",
      "text": "Implemented installer idempotency fix by adding npm --force in scripts/install.sh and scripts/install.ps1 and added release-readiness contract assertions for --force in tests/integration/release-readiness-contract.spec.ts"
    },
    {
      "created_at": "2026-03-09T16:29:38.297Z",
      "author": "maintainer-agent",
      "text": "Validation evidence pm test pm-6k5l --run passed after changes including node scripts/run-tests.mjs coverage and targeted cli integration tests; pm test-all --status in_progress passed totals items=1 linked_tests=2 passed=2 failed=0; pm test-all --status closed rerun passed totals items=177 linked_tests=422 passed=79 failed=0 skipped=343"
    },
    {
      "created_at": "2026-03-09T16:29:38.719Z",
      "author": "maintainer-agent",
      "text": "Coverage evidence from pm-driven runs remains 100 percent for lines branches functions and statements"
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-09T15:52:30.417Z",
      "author": "maintainer-agent",
      "text": "Plan claim item link touched files docs and tests run pm test and test all then record evidence with coverage confirmation"
    }
  ],
  "files": [
    {
      "path": "create_tasks.sh",
      "scope": "project",
      "note": "remove obsolete seed script"
    },
    {
      "path": "scripts/install.ps1",
      "scope": "project",
      "note": "keep PowerShell installer parity for idempotent updates"
    },
    {
      "path": "scripts/install.sh",
      "scope": "project",
      "note": "make npm install idempotent under reused prefix"
    },
    {
      "path": "tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "note": "add regression coverage for repeat install with same prefix"
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
      "command": "node scripts/run-tests.mjs test -- tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "targeted installer regression check"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "all-fields and dogfood protocol"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative product requirements"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public contract alignment"
    }
  ],
  "close_reason": "Installer idempotency fixed and full pm regression sweeps passed with 100 percent coverage"
}

Post-release maintenance sweep to keep repository release-ready and remove obsolete helper automation that no longer matches all-fields create contract.
