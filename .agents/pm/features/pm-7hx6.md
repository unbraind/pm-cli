{
  "id": "pm-7hx6",
  "title": "Add pm completion command for bash/zsh/fish shell completion",
  "description": "Implement pm completion command",
  "type": "Feature",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:cli",
    "code",
    "docs",
    "milestone:6",
    "pm-cli",
    "tests"
  ],
  "created_at": "2026-03-08T18:01:45.100Z",
  "updated_at": "2026-03-08T18:11:50.163Z",
  "deadline": "2026-03-09T18:01:45.100Z",
  "author": "maintainer-agent",
  "estimated_minutes": 90,
  "acceptance_criteria": "pm completion bash/zsh/fish outputs valid scripts",
  "definition_of_ready": "PRD and README updated; test plan ready",
  "order": 1,
  "goal": "Production-ready CLI usability",
  "objective": "Add shell tab completion",
  "value": "Standard feature for production CLI tools",
  "impact": "Improves discoverability and usability",
  "outcome": "pm tab completion in bash/zsh/fish",
  "why_now": "Highest-impact usability gap remaining",
  "risk": "low",
  "confidence": "high",
  "sprint": "release-hardening",
  "release": "v0.1.1",
  "comments": [
    {
      "created_at": "2026-03-08T18:01:45.100Z",
      "author": "maintainer-agent",
      "text": "Starting implementation of shell completion command"
    },
    {
      "created_at": "2026-03-08T18:11:41.930Z",
      "author": "maintainer-agent",
      "text": "Implementation complete. Files changed: src/cli/commands/completion.ts (new, 260 lines), src/cli/commands/index.ts (export added), src/cli/main.ts (command registered), tests/unit/completion-command.spec.ts (new, 47 tests), vitest.config.ts (include added), CHANGELOG.md/README.md/PRD.md (docs updated). Evidence: 522 tests pass at 100% lines/branches/functions/statements coverage. pm completion bash/zsh/fish all output valid scripts. --json mode returns {shell, script, setup_hint}. Unknown shell returns exit code 2."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-08T18:01:45.100Z",
      "author": "maintainer-agent",
      "text": "completion.ts generates bash/zsh/fish scripts"
    }
  ],
  "files": [
    {
      "path": "CHANGELOG.md",
      "scope": "project",
      "note": "documented shell completion feature"
    },
    {
      "path": "src/cli/commands/completion.ts",
      "scope": "project",
      "note": "new file"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "register command"
    },
    {
      "path": "tests/unit/completion-command.spec.ts",
      "scope": "project",
      "note": "47 tests covering all completion shells and CLI behavior"
    },
    {
      "path": "vitest.config.ts",
      "scope": "project",
      "note": "added completion.ts to coverage include list"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 600,
      "note": "coverage gate"
    }
  ],
  "docs": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "spec"
    }
  ],
  "close_reason": "Shell completion implemented for bash/zsh/fish. 47 new tests cover all code paths. 522 total tests pass at 100% coverage. All docs (PRD, README, CHANGELOG) updated per R1."
}

Shell completion feature
