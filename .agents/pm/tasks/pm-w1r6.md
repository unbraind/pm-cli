{
  "id": "pm-w1r6",
  "title": "Add --title and -t support for pm update",
  "description": "Support updating item title via pm update with --title/-t options.",
  "type": "Task",
  "status": "closed",
  "priority": 0,
  "tags": [
    "area:cli",
    "code",
    "doc",
    "pm-cli",
    "tests"
  ],
  "created_at": "2026-03-07T13:10:28.926Z",
  "updated_at": "2026-03-07T13:15:39.792Z",
  "deadline": "2026-03-09T13:10:28.926Z",
  "author": "maintainer-agent",
  "estimated_minutes": 60,
  "acceptance_criteria": "pm update accepts --title and -t to modify item title; PRD/README reflect this.",
  "comments": [
    {
      "created_at": "2026-03-07T13:10:28.926Z",
      "author": "maintainer-agent",
      "text": "Users should be able to update item title without editing files manually"
    },
    {
      "created_at": "2026-03-07T13:15:39.434Z",
      "author": "unknown",
      "text": "Implemented --title/-t support for pm update. Updated PRD and README command contract, added option parsing in src/cli/main.ts and src/cli/commands/update.ts, added Pi wrapper action mapping. Tests updated to assert the new flag and title modification behavior."
    },
    {
      "created_at": "2026-03-07T13:15:39.592Z",
      "author": "unknown",
      "text": "Evidence: pnpm test:coverage passed (100% lines/branches/functions/statements). PRD.md and README.md aligned. Contract tests and Pi agent wrapper tests passed."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-07T13:10:28.926Z",
      "author": "maintainer-agent",
      "text": "Need to update PRD and README first then cli and tests"
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project"
    },
    {
      "path": "README.md",
      "scope": "project"
    },
    {
      "path": "src/cli/commands/update.ts",
      "scope": "project"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project"
    },
    {
      "path": "tests/integration/release-readiness-contract.spec.ts",
      "scope": "project"
    },
    {
      "path": "tests/unit/update-command.spec.ts",
      "scope": "project"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 3600
    },
    {
      "command": "node scripts/run-tests.mjs test",
      "scope": "project",
      "timeout_seconds": 240
    }
  ],
  "close_reason": "Added --title update parity across CLI docs and wrapper with 100% coverage and passing tests."
}

Add --title and -t support for pm update. Update PRD.md README.md src/cli/main.ts and tests.
