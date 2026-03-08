{
  "id": "pm-ixbk",
  "title": "Add package.json npm metadata and GitHub community files",
  "description": "package.json is missing repository, homepage, bugs, and author fields required for proper npm page display and discoverability. GitHub is also missing issue/PR templates and Dependabot config - all standard for production open-source npm packages.",
  "type": "Chore",
  "status": "closed",
  "priority": 0,
  "tags": [
    "area:ci",
    "area:release",
    "code",
    "docs",
    "milestone:6",
    "pm-cli",
    "priority:0",
    "release-readiness"
  ],
  "created_at": "2026-03-08T21:16:00.083Z",
  "updated_at": "2026-03-08T21:18:27.151Z",
  "deadline": "2026-03-09T21:16:00.083Z",
  "author": "maintainer-agent",
  "estimated_minutes": 45,
  "acceptance_criteria": "package.json has repository/bugs/homepage/author fields; .github/ISSUE_TEMPLATE/ has bug-report and feature-request templates; .github/PULL_REQUEST_TEMPLATE.md exists; .github/dependabot.yml exists; release-readiness tests updated; 100% coverage maintained",
  "definition_of_ready": "GitHub repo URL confirmed; npm package name verified.",
  "order": 1,
  "goal": "Release readiness",
  "objective": "Complete npm package and GitHub community hygiene",
  "value": "Improves npm discoverability, enables automated dependency updates, and guides community contributions",
  "impact": "Polished npm page; automated security patches via Dependabot; structured issue reporting",
  "outcome": "Package appears professional on npm; community can contribute with clear templates",
  "why_now": "These are standard requirements before v0.1 public release",
  "risk": "low",
  "confidence": "high",
  "release": "v0.1",
  "comments": [
    {
      "created_at": "2026-03-08T21:16:00.083Z",
      "author": "maintainer-agent",
      "text": "Missing npm metadata fields (repository/bugs/homepage/author) affect how npm displays the package. Dependabot and GitHub templates are standard for production open-source."
    },
    {
      "created_at": "2026-03-08T21:18:21.635Z",
      "author": "maintainer-agent",
      "text": "Implementation complete. Changes: (1) package.json - added repository/bugs/homepage/author fields and expanded keywords with ai/git-native/task-tracker/coding-agents. (2) .github/ISSUE_TEMPLATE/bug-report.yml - structured bug report template with version/OS/repro fields. (3) .github/ISSUE_TEMPLATE/feature-request.yml - feature request template with problem/solution/area fields. (4) .github/PULL_REQUEST_TEMPLATE.md - PR checklist including pm item links and test evidence. (5) .github/dependabot.yml - weekly npm+GitHub Actions updates. (6) CHANGELOG.md updated. Tests: 535 passing, 100% coverage maintained."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-08T21:16:00.083Z",
      "author": "maintainer-agent",
      "text": "Add to package.json: repository bugs homepage author. Create .github/ISSUE_TEMPLATE/ bug-report.yml + feature-request.yml. Create .github/PULL_REQUEST_TEMPLATE.md. Create .github/dependabot.yml for pnpm and GitHub Actions updates."
    }
  ],
  "files": [
    {
      "path": ".github/dependabot.yml",
      "scope": "project",
      "note": "new file"
    },
    {
      "path": ".github/ISSUE_TEMPLATE/bug-report.yml",
      "scope": "project",
      "note": "new file"
    },
    {
      "path": ".github/ISSUE_TEMPLATE/feature-request.yml",
      "scope": "project",
      "note": "new file"
    },
    {
      "path": ".github/PULL_REQUEST_TEMPLATE.md",
      "scope": "project",
      "note": "new file"
    },
    {
      "path": "package.json",
      "scope": "project",
      "note": "add repository bugs homepage author fields"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 300,
      "note": "full coverage gate"
    }
  ],
  "docs": [
    {
      "path": "CHANGELOG.md",
      "scope": "project",
      "note": "document new community files"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "no change needed - metadata is in package.json"
    }
  ],
  "close_reason": "package.json npm metadata fields added; GitHub issue/PR templates and Dependabot configured; keywords expanded; all tests pass at 100% coverage."
}
