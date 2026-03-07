{
  "id": "pm-jvfw",
  "title": "M5 roadmap: Runtime wiring for extension registrations",
  "description": "Expand runtime execution wiring for non-flag extension registrations beyond current metadata capture baseline.",
  "type": "Task",
  "status": "open",
  "priority": 2,
  "tags": [
    "area:extensions",
    "code",
    "milestone:5",
    "pm-cli",
    "roadmap",
    "tests"
  ],
  "created_at": "2026-03-07T21:52:34.802Z",
  "updated_at": "2026-03-07T21:52:34.802Z",
  "deadline": "2026-03-14T21:52:34.802Z",
  "author": "maintainer-agent",
  "estimated_minutes": 180,
  "acceptance_criteria": "Runtime wiring is implemented for at least one additional extension registration family beyond registerFlags help metadata, docs reflect scope accurately, and sandbox-safe regression + coverage remain 100 percent.",
  "dependencies": [
    {
      "id": "pm-b1w",
      "kind": "parent",
      "created_at": "2026-03-07T21:52:34.802Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-07T21:52:34.802Z",
      "author": "maintainer-agent",
      "text": "Why this exists milestone 5 still tracks broader runtime wiring for registered extension definitions in PRD roadmap."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-07T21:52:34.802Z",
      "author": "maintainer-agent",
      "text": "Start by mapping current registration metadata-only paths then implement deterministic runtime wiring with tests."
    }
  ],
  "files": [
    {
      "path": "src/core/extensions/loader.ts",
      "scope": "project",
      "note": "registration plumbing baseline"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 5400,
      "note": "coverage gate"
    }
  ],
  "docs": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative roadmap contract"
    }
  ]
}

Bridge remaining roadmap gap for extension registration runtime wiring after hook call-site expansion: scope includes actionable runtime execution surfaces for registered schema/import/search definitions with deterministic behavior and safety checks.
