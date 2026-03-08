{
  "id": "pm-x4f9",
  "title": "Add README badges and update CONTRIBUTING.md to reference docs/",
  "description": "Production-ready npm packages have CI status, npm version, license, and Node version badges in their README. Also update CONTRIBUTING.md to link to docs/ guides.",
  "type": "Chore",
  "status": "closed",
  "priority": 2,
  "tags": [
    "area:docs",
    "doc",
    "milestone:6",
    "pm-cli"
  ],
  "created_at": "2026-03-08T21:50:41.448Z",
  "updated_at": "2026-03-08T21:52:05.162Z",
  "deadline": "2026-03-09T21:50:41.448Z",
  "author": "maintainer-agent",
  "estimated_minutes": 20,
  "acceptance_criteria": "README has CI/npm/license/node badges. CONTRIBUTING.md links to docs/. Tests pass.",
  "goal": "Production readiness",
  "objective": "Standard npm package badges and docs cross-linking",
  "value": "Users can see CI status, version, license at a glance",
  "impact": "Lowers trust barrier for new users and contributors",
  "outcome": "README has badges; CONTRIBUTING.md links to docs/",
  "why_now": "docs/ was just created; badges are a one-time easy add",
  "risk": "low",
  "confidence": "high",
  "sprint": "maintainer-loop",
  "release": "v0.1.0",
  "comments": [
    {
      "created_at": "2026-03-08T21:50:41.448Z",
      "author": "maintainer-agent",
      "text": "Badges: CI workflow status + npm version + license + node compat."
    },
    {
      "created_at": "2026-03-08T21:52:00.579Z",
      "author": "maintainer-agent",
      "text": "Implemented: README badges (CI/npm/license/node) added at top. CONTRIBUTING.md updated to reference docs/ARCHITECTURE.md and docs/EXTENSIONS.md. 535/535 tests pass."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-08T21:50:41.448Z",
      "author": "maintainer-agent",
      "text": "Use GitHub Actions badge for CI and shields.io for npm/license/node."
    }
  ],
  "files": [
    {
      "path": "CONTRIBUTING.md",
      "scope": "project",
      "note": "add links to docs/"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "add badges at top"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs test",
      "scope": "project",
      "timeout_seconds": 300,
      "note": "full test suite"
    }
  ],
  "docs": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "governing spec"
    }
  ],
  "close_reason": "README badges added; CONTRIBUTING.md links to docs/; 535/535 tests pass at 100% coverage."
}

Add badges: CI, npm version, license, Node version. Update CONTRIBUTING.md to reference docs/.
