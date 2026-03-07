{
  "id": "pm-qyyv",
  "title": "M4 roadmap: Broader multi-factor tuning for hybrid search",
  "description": "Implement broader multi-factor tuning.",
  "type": "Task",
  "status": "closed",
  "priority": 2,
  "tags": [
    "area:search",
    "milestone:4",
    "pm-cli",
    "roadmap"
  ],
  "created_at": "2026-03-07T14:01:18.657Z",
  "updated_at": "2026-03-07T20:26:38.737Z",
  "author": "maintainer-agent",
  "estimated_minutes": 120,
  "acceptance_criteria": "Multi-factor tuning configurable and applied.",
  "comments": [
    {
      "created_at": "2026-03-07T20:00:20.030Z",
      "author": "maintainer-agent",
      "text": "Implemented configurable keyword scoring tuning (weights + title exact bonus) and added deterministic unit coverage for tuning resolution and ranking influence."
    },
    {
      "created_at": "2026-03-07T20:26:31.777Z",
      "author": "maintainer-agent",
      "text": "Aligned PRD/README with implemented search tuning: optional settings.search.tuning now documented with deterministic defaults and milestone wording updated to reflect implemented multi-factor lexical tuning."
    },
    {
      "created_at": "2026-03-07T20:26:31.965Z",
      "author": "maintainer-agent",
      "text": "Evidence: pm test pm-qyyv --run passed; pm test-all --status in_progress passed with deterministic duplicate skip; pm test-all --status closed passed (failed=0)."
    }
  ],
  "files": [
    {
      "path": "src/cli/commands/search.ts",
      "scope": "project",
      "note": "planned change"
    },
    {
      "path": "src/types.ts",
      "scope": "project",
      "note": "search tuning settings contract"
    },
    {
      "path": "tests/unit/search-command.spec.ts",
      "scope": "project",
      "note": "multi-factor tuning coverage"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs test",
      "scope": "project",
      "timeout_seconds": 240,
      "note": "sandbox-safe regression"
    }
  ],
  "docs": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "governing spec"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "search tuning contract"
    }
  ],
  "close_reason": "Implemented configurable multi-factor lexical tuning and synchronized PRD/README contracts; pm test and regression sweeps passed."
}

Implement broader multi-factor tuning for hybrid search mode.
