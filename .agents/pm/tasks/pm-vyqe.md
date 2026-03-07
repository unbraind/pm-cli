{
  "id": "pm-vyqe",
  "title": "Add --ac alias for create acceptance criteria",
  "description": "Support --ac as a deterministic alias to --acceptance-criteria for pm create and document it in authoritative docs.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:cli",
    "area:docs",
    "code",
    "milestone:1",
    "pm-cli",
    "priority:1",
    "tests"
  ],
  "created_at": "2026-03-07T00:21:45.673Z",
  "updated_at": "2026-03-07T00:47:58.133Z",
  "deadline": "2026-03-10T23:59:00.000Z",
  "author": "maintainer-agent",
  "estimated_minutes": 90,
  "acceptance_criteria": "pm create accepts --ac as an alias of --acceptance-criteria; help docs show alias; regression tests pass with 100% coverage unchanged.",
  "dependencies": [
    {
      "id": "pm-u9r",
      "kind": "related",
      "created_at": "2026-03-07T00:21:45.673Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-07T00:21:45.673Z",
      "author": "maintainer-agent",
      "text": "Why this exists maintainers need concise acceptance criteria flag alias parity in create contract"
    },
    {
      "created_at": "2026-03-07T00:21:52.621Z",
      "author": "maintainer-agent",
      "text": "Planned change-set: update PRD README AGENTS create flag contracts to include --ac alias first, then wire CLI create option alias and add regression assertions for help and parsing behavior."
    },
    {
      "created_at": "2026-03-07T00:23:27.493Z",
      "author": "maintainer-agent",
      "text": "Implemented docs-first alias parity: PRD README and AGENTS now document --ac for create acceptance criteria; CLI create option now registers --acceptance-criteria with --ac alias; integration contracts expanded for required flag coverage and direct alias creation behavior."
    },
    {
      "created_at": "2026-03-07T00:47:57.831Z",
      "author": "maintainer-agent",
      "text": "Evidence: pnpm build passed. pm test pm-vyqe --run --timeout 7200 --json passed (2/2 linked tests). pm test-all --status in_progress --timeout 7200 --json passed with totals items=1 linked_tests=2 passed=2 failed=0 skipped=0. Initial pm test-all --status closed surfaced pre-existing stale linked test in pm-2c8 referencing deleted tests/unit/command-wrapper-exports.spec.ts; fixed via pm test pm-2c8 --remove with force and reran closed sweep successfully: items=114 linked_tests=309 passed=62 failed=0 skipped=247. Coverage remains 100 percent lines branches functions statements."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-07T00:21:45.673Z",
      "author": "maintainer-agent",
      "text": "Plan update docs first then wire commander alias and extend integration tests"
    }
  ],
  "learnings": [
    {
      "created_at": "2026-03-07T00:21:45.673Z",
      "author": "maintainer-agent",
      "text": "none"
    }
  ],
  "files": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "all-fields template alias documentation"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "create contract alias documentation"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "create help contract alias documentation"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "create option alias wiring"
    },
    {
      "path": "tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "note": "create alias integration coverage"
    },
    {
      "path": "tests/integration/help-readme-contract.spec.ts",
      "scope": "project",
      "note": "help readme alias contract regression"
    },
    {
      "path": "tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "note": "required create flags contract includes alias"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 3600,
      "note": "coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/integration/help-readme-contract.spec.ts",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "help readme alias regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "maintainer operation contract"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative command contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public command contract"
    }
  ],
  "close_reason": "Implemented create --ac alias parity across docs CLI and regression tests with full sandbox test sweeps passing and 100% coverage maintained."
}

Context: maintainer all-fields templates reference --ac but create help currently only advertises --acceptance-criteria. Approach: docs-first contract update then command option alias wiring and regression coverage updates.
