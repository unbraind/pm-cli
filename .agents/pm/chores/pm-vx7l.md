{
  "id": "pm-vx7l",
  "title": "Sync prompt docs with close workflow",
  "description": "Align internal prompt templates to use pm close instead of update --status closed.",
  "type": "Chore",
  "status": "closed",
  "priority": 2,
  "tags": [
    "area:docs",
    "pm-cli",
    "prompts",
    "workflow"
  ],
  "created_at": "2026-03-06T13:24:08.467Z",
  "updated_at": "2026-03-06T13:42:18.742Z",
  "deadline": "2026-03-08T13:24:08.467Z",
  "author": "maintainer-agent",
  "estimated_minutes": 45,
  "acceptance_criteria": "Prompt docs no longer recommend update --status closed and instead use pm close where applicable.",
  "dependencies": [
    {
      "id": "pm-3nv9",
      "kind": "related",
      "created_at": "2026-03-06T13:24:08.467Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-06T13:24:08.467Z",
      "author": "maintainer-agent",
      "text": "Follow-up created from close workflow alignment run"
    },
    {
      "created_at": "2026-03-06T13:28:48.390Z",
      "author": "maintainer-agent",
      "text": "Planned change: replace prompt examples that use update --status closed with pm close workflow examples."
    },
    {
      "created_at": "2026-03-06T13:29:23.302Z",
      "author": "maintainer-agent",
      "text": "Implemented docs fix: prompt-04 now uses pm close in close-workflow guidance and template snippet."
    },
    {
      "created_at": "2026-03-06T13:42:18.589Z",
      "author": "maintainer-agent",
      "text": "Evidence: node dist/cli.js test pm-vx7l --run passed; node dist/cli.js test-all --status in_progress passed (items=1, linked_tests=1, failed=0); node scripts/run-tests.mjs coverage passed with 100% lines/branches/functions/statements; node dist/cli.js test-all --status closed passed (items=88, linked_tests=263, passed=62, failed=0, skipped=201)."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-06T13:24:08.467Z",
      "author": "maintainer-agent",
      "text": "Update prompt templates that still show update-based closure"
    }
  ],
  "files": [
    {
      "path": "docs/prompts/prompt-04.md",
      "scope": "project",
      "note": "update close workflow examples"
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
      "path": "AGENTS.md",
      "scope": "project",
      "note": "agent workflow policy"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public contract alignment"
    }
  ],
  "close_reason": "Prompt docs now use pm close workflow examples and all required verification commands passed with 100% coverage."
}

During contract-alignment work, docs/prompts templates still reference update-based closure examples. Track a focused docs pass to align these prompts with PRD README AGENTS close semantics.
