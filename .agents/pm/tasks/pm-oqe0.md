{
  "id": "pm-oqe0",
  "title": "Pi wrapper action parity: add completion action",
  "description": "Docs-first add Pi wrapper support for pm completion so Pi automation can generate shell completion scripts through the extension action surface.",
  "type": "Task",
  "status": "closed",
  "priority": 0,
  "tags": [
    "area:extensions-pi",
    "code",
    "doc",
    "milestone:6",
    "pm-cli",
    "priority:0",
    "release-readiness",
    "tests"
  ],
  "created_at": "2026-03-08T18:43:57.258Z",
  "updated_at": "2026-03-08T19:24:04.471Z",
  "deadline": "2026-03-09T20:00:00.000Z",
  "author": "maintainer-agent",
  "estimated_minutes": 75,
  "acceptance_criteria": "Pi wrapper accepts action=completion with shell bash|zsh|fish, forwards deterministic CLI args, docs reflect the action surface, and coverage remains 100 percent.",
  "definition_of_ready": "Gap confirmed by wrapper action enum and dispatch switch lacking completion path while CLI supports pm completion.",
  "order": 1,
  "goal": "Release-hardening",
  "objective": "Keep Pi wrapper action surface aligned with core CLI commands",
  "value": "Pi agents can use shell completion generation without dropping to raw shell invocation",
  "impact": "Reduces wrapper-to-CLI parity drift and manual workarounds",
  "outcome": "Pi wrapper dispatches completion action deterministically",
  "why_now": "Roadmap still references action coverage expansion and completion is a low-risk high-parity gap",
  "risk": "low",
  "confidence": "high",
  "sprint": "maintainer-loop-2026-03-08",
  "release": "v0.1",
  "expected_result": "Pi wrapper completion action works and docs/tests stay aligned",
  "affected_version": "0.1.0",
  "component": "pi-wrapper",
  "regression": false,
  "customer_impact": "Improves automation ergonomics for shell completion setup",
  "dependencies": [
    {
      "id": "pm-096j",
      "kind": "related",
      "created_at": "2026-03-08T18:43:57.258Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-08T18:43:57.258Z",
      "author": "maintainer-agent",
      "text": "Why this exists Pi wrapper still lacks completion action parity against core CLI command surface."
    },
    {
      "created_at": "2026-03-08T18:44:06.854Z",
      "author": "maintainer-agent",
      "text": "Planned changeset before edits: update PRD/README/AGENTS Pi wrapper action coverage text for completion support, then add completion action schema + dispatch mapping in .pi/extensions/pm-cli/index.ts with unit and release-contract coverage."
    },
    {
      "created_at": "2026-03-08T18:46:20.108Z",
      "author": "maintainer-agent",
      "text": "Implemented docs-first and wrapper parity updates: added completion action + shell parameter to Pi wrapper schema/dispatch, updated PRD/README/AGENTS Pi sections, and extended unit/integration contract tests to lock parity."
    },
    {
      "created_at": "2026-03-08T19:23:50.031Z",
      "author": "maintainer-agent",
      "text": "Evidence: pm test pm-oqe0 --run --timeout 7200 --json passed linked tests 2/2 (coverage + targeted parity regression). pm test-all --status in_progress --timeout 7200 --json passed with items=1 linked_tests=2 passed=2 failed=0 skipped=0. pm test-all --status closed --timeout 7200 --json passed on deterministic rerun with items=158 linked_tests=396 passed=72 failed=0 skipped=324. Coverage remains 100 percent statements branches functions lines."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-08T18:43:57.258Z",
      "author": "maintainer-agent",
      "text": "Plan docs first then wrapper action schema/dispatch tests and release contract guard."
    }
  ],
  "files": [
    {
      "path": ".pi/extensions/pm-cli/index.ts",
      "scope": "project",
      "note": "add completion action schema and arg mapping"
    },
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "Pi wrapper completion usage guidance"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "Pi wrapper action coverage contract update"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "Pi wrapper action coverage contract update"
    },
    {
      "path": "tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "note": "docs contract guard"
    },
    {
      "path": "tests/unit/pi-agent-extension.spec.ts",
      "scope": "project",
      "note": "wrapper parity regression"
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
      "command": "node scripts/run-tests.mjs test -- tests/unit/pi-agent-extension.spec.ts tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "targeted parity regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "Pi wrapper usage guidance"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "governing Pi wrapper contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public Pi wrapper contract"
    }
  ],
  "close_reason": "Pi wrapper completion action parity implemented with docs+tests and mandatory sweeps passing"
}

Implement docs-first Pi wrapper action coverage expansion for completion command and verify with unit + release contract coverage.
