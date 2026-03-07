{
  "id": "pm-zetb",
  "title": "PRD Milestone 1 - Core Item CRUD and Locking",
  "description": "Complete core create update close delete claim release and safe write semantics.",
  "type": "Epic",
  "status": "canceled",
  "priority": 0,
  "tags": [
    "area:milestone",
    "code",
    "docs",
    "milestone:1",
    "pm-cli",
    "priority:0",
    "tests"
  ],
  "created_at": "2026-03-06T22:55:53.463Z",
  "updated_at": "2026-03-06T23:18:35.918Z",
  "deadline": "2026-03-20T22:55:53.463Z",
  "author": "maintainer-agent",
  "estimated_minutes": 240,
  "acceptance_criteria": "Milestone 1 deliverables in PRD section 21 are fully represented by linked features and validated evidence.",
  "dependencies": [
    {
      "id": "pm-6hhn",
      "kind": "blocks",
      "created_at": "2026-03-06T22:55:53.463Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-06T22:55:53.463Z",
      "author": "maintainer-agent",
      "text": "Milestone 1 seeded from PRD to establish complete dogfood planning coverage."
    },
    {
      "created_at": "2026-03-06T23:18:35.754Z",
      "author": "maintainer-agent",
      "text": "Duplicate milestone epic identified during tracker normalization. Canonical milestone item is pm-u9r for Milestone 1; this seeded duplicate is being canceled to keep backlog deterministic and non-overlapping."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-06T22:55:53.463Z",
      "author": "maintainer-agent",
      "text": "Next step create or link concrete features and tasks under this milestone."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "milestone source"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs test",
      "scope": "project",
      "timeout_seconds": 600,
      "note": "sandbox-safe regression"
    }
  ],
  "docs": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "milestone definition"
    }
  ]
}

Canonical milestone tracking item seeded from PRD section 21. Child features and tasks should attach here via dependencies.
