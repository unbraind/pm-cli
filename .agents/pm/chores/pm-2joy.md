{
  "id": "pm-2joy",
  "title": "Release-readiness contract audit and next fix (2026-03-06 run 4)",
  "description": "Audit PRD README AGENTS and implementation parity then deliver the next highest-value contract-aligned improvement.",
  "type": "Chore",
  "status": "closed",
  "priority": 0,
  "tags": [
    "contract-sync",
    "maintenance",
    "pm-cli",
    "release-readiness"
  ],
  "created_at": "2026-03-06T18:55:19.104Z",
  "updated_at": "2026-03-06T19:11:33.496Z",
  "deadline": "2026-03-07T18:55:19.104Z",
  "author": "maintainer-agent",
  "estimated_minutes": 120,
  "acceptance_criteria": "One concrete contract-aligned improvement is implemented, verified with sandbox-safe regression and coverage, and evidence is logged.",
  "comments": [
    {
      "created_at": "2026-03-06T18:55:19.104Z",
      "author": "maintainer-agent",
      "text": "Start run 4 maintenance loop with focused discovery and no duplicate work."
    },
    {
      "created_at": "2026-03-06T18:55:38.050Z",
      "author": "maintainer-agent",
      "text": "Discovery: running focused contract checks (release-readiness and help/readme suites) to identify the smallest high-value drift fix for this run."
    },
    {
      "created_at": "2026-03-06T18:56:38.369Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: add release-readiness contract coverage that asserts pm --version output matches package.json version and semver format."
    },
    {
      "created_at": "2026-03-06T19:11:27.485Z",
      "author": "maintainer-agent",
      "text": "Implemented changeset: added release-readiness contract coverage in tests/integration/release-readiness-contract.spec.ts to assert --version output matches package.json semantic version metadata and prevent packaging/version drift."
    },
    {
      "created_at": "2026-03-06T19:11:27.630Z",
      "author": "maintainer-agent",
      "text": "Evidence: node scripts/run-tests.mjs test -- tests/integration/release-readiness-contract.spec.ts passed (24/24). node dist/cli.js test pm-2joy --run --timeout 3600 passed linked tests (2 passed, 0 failed) including node scripts/run-tests.mjs coverage and node scripts/run-tests.mjs test, with coverage remaining 100% lines/branches/functions/statements. node dist/cli.js test-all --status in_progress --timeout 3600 passed (items=1 linked_tests=2 passed=2 failed=0 skipped=0). node dist/cli.js test-all --status closed --timeout 3600 passed (items=100 linked_tests=283 passed=63 failed=0 skipped=220). Follow-up items: none."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-06T18:55:19.104Z",
      "author": "maintainer-agent",
      "text": "Bootstrap complete next step is focused contract checks to pick smallest high-value fix."
    }
  ],
  "files": [
    {
      "path": "tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "note": "version parity contract guard"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 600,
      "note": "sandbox-safe coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test",
      "scope": "project",
      "timeout_seconds": 240,
      "note": "sandbox-safe regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "agent workflow contract"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public contract"
    }
  ],
  "close_reason": "Added --version parity guard in release-readiness contracts and completed required sandbox-safe verification sweeps with 100% coverage intact."
}

Maintain release-readiness by completing one focused contract-aligned improvement with full dogfood evidence.
