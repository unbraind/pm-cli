{
  "id": "pm-6hhn",
  "title": "PRD Milestone 0 - Foundations",
  "description": "Establish deterministic storage schema core invariants and baseline command behavior.",
  "type": "Epic",
  "status": "canceled",
  "priority": 0,
  "tags": [
    "area:milestone",
    "code",
    "docs",
    "milestone:0",
    "pm-cli",
    "priority:0",
    "tests"
  ],
  "created_at": "2026-03-06T22:55:53.278Z",
  "updated_at": "2026-03-06T23:18:35.604Z",
  "deadline": "2026-03-20T22:55:53.278Z",
  "author": "maintainer-agent",
  "estimated_minutes": 240,
  "acceptance_criteria": "Milestone 0 deliverables in PRD section 21 are fully represented by linked features and validated evidence.",
  "comments": [
    {
      "created_at": "2026-03-06T22:55:53.278Z",
      "author": "maintainer-agent",
      "text": "Milestone 0 seeded from PRD to establish complete dogfood planning coverage."
    },
    {
      "created_at": "2026-03-06T23:18:35.452Z",
      "author": "maintainer-agent",
      "text": "Duplicate milestone epic identified during tracker normalization. Canonical milestone item is pm-2xl for Milestone 0; this seeded duplicate is being canceled to keep backlog deterministic and non-overlapping."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-06T22:55:53.278Z",
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
