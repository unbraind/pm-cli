{
  "id": "pm-ewoq",
  "title": "Pi wrapper workflow preset: close-task",
  "description": "Add a close-task workflow preset in the Pi extension that chains close plus release with deterministic argument forwarding.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:extensions",
    "area:pi",
    "code",
    "doc",
    "milestone:5",
    "pm-cli",
    "priority:1",
    "tests"
  ],
  "created_at": "2026-03-09T11:39:51.674Z",
  "updated_at": "2026-03-09T12:13:11.129Z",
  "deadline": "2026-03-10T11:39:51.000Z",
  "author": "maintainer-agent",
  "estimated_minutes": 90,
  "acceptance_criteria": "Pi action close-task is accepted in schema and action enum and executes close then release with deterministic author message and force forwarding and is covered by unit tests with docs parity updates.",
  "definition_of_ready": "Pi wrapper workflow preset semantics agreed in docs before implementation.",
  "order": 1,
  "goal": "Post-v0.1 roadmap hardening",
  "objective": "Improve Pi workflow ergonomics",
  "value": "Reduce repetitive two-step close and release command emission",
  "impact": "Lower operator error and speed up task lifecycle workflows",
  "outcome": "close-task preset safely closes and releases items",
  "why_now": "Maintainer loops repeatedly perform close and release and can benefit from deterministic preset automation.",
  "risk": "medium",
  "confidence": "high",
  "sprint": "maintainer-loop",
  "release": "v0.1",
  "comments": [
    {
      "created_at": "2026-03-09T11:39:51.674Z",
      "author": "maintainer-agent",
      "text": "Why this exists current workflow presets cover start and pause while close and release remains manual."
    },
    {
      "created_at": "2026-03-09T11:40:08.178Z",
      "author": "maintainer-agent",
      "text": "Planned changeset before edits docs first update PRD and README for close-task preset then implement Pi wrapper close-task sequence and add unit tests."
    },
    {
      "created_at": "2026-03-09T11:41:07.248Z",
      "author": "maintainer-agent",
      "text": "Docs-first update complete PRD and README now include close-task in Pi workflow preset action coverage."
    },
    {
      "created_at": "2026-03-09T12:13:09.534Z",
      "author": "maintainer-agent",
      "text": "Implemented close-task workflow preset in .pi extension. The preset now executes close with required text then release and forwards author message and force consistently. Added unit coverage for success flow and missing text validation and updated PRD README action coverage lists."
    },
    {
      "created_at": "2026-03-09T12:13:10.103Z",
      "author": "maintainer-agent",
      "text": "Evidence commands passed: pm test pm-ewoq --run --timeout 7200 --json; pm test-all --status in_progress --timeout 7200 --json totals items=1 linked_tests=2 passed=2 failed=0 skipped=0; pm test-all --status closed --timeout 7200 --json totals items=174 linked_tests=414 passed=75 failed=0 skipped=339. Coverage remains 100 percent lines branches functions statements."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-09T11:39:51.674Z",
      "author": "maintainer-agent",
      "text": "Plan docs first update then implement close-task sequence and add unit tests."
    }
  ],
  "files": [
    {
      "path": ".pi/extensions/pm-cli/index.ts",
      "scope": "project",
      "note": "workflow preset implementation target"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "docs-first Pi workflow preset coverage update"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "docs-first action list update"
    },
    {
      "path": "tests/unit/pi-agent-extension.spec.ts",
      "scope": "project",
      "note": "add close-task workflow preset tests"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "sandbox-safe full coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/pi-agent-extension.spec.ts",
      "scope": "project",
      "timeout_seconds": 240,
      "note": "targeted sandbox safe unit coverage"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "maintainer workflow policy"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "Pi wrapper action contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "Pi wrapper action coverage docs"
    }
  ],
  "close_reason": "close-task Pi workflow preset implemented with docs parity and full regression evidence at 100 percent coverage"
}

Implement a new Pi workflow preset action close-task to improve maintainer and agent ergonomics for terminal lifecycle transitions.
