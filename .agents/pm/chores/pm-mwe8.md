{
  "id": "pm-mwe8",
  "title": "Add automated npm release workflow and Node 24 CI coverage",
  "description": "The repository lacks an automated npm publishing workflow triggered by version tags. Additionally, Node 24 (current release, will become LTS Oct 2025) is not in the CI matrix. Both are production-readiness requirements for a widely-used npm package.",
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
  "created_at": "2026-03-08T21:08:48.927Z",
  "updated_at": "2026-03-08T21:12:37.957Z",
  "deadline": "2026-03-09T21:08:48.927Z",
  "author": "maintainer-agent",
  "estimated_minutes": 60,
  "acceptance_criteria": "Pushing a v0.1.0 tag triggers CI + npm publish; Node 24 appears in ci.yml and nightly.yml matrix; docs updated; tests pass at 100%",
  "definition_of_ready": "Release workflow template designed; Node 24 confirmed as current release.",
  "order": 1,
  "goal": "Release readiness",
  "objective": "Automate npm publish and widen Node compatibility matrix",
  "value": "Eliminates manual publish steps and ensures compatibility with future Node LTS",
  "impact": "Reduces release friction; increases confidence in Node version compatibility",
  "outcome": "Automated releases on tag push; CI confirms Node 24 compatibility",
  "why_now": "Project is at v0.1 release milestone; automated publish is standard for production npm packages",
  "risk": "low",
  "confidence": "high",
  "release": "v0.1",
  "comments": [
    {
      "created_at": "2026-03-08T21:08:48.927Z",
      "author": "maintainer-agent",
      "text": "Addresses two gaps: missing release automation and Node 24 CI coverage."
    },
    {
      "created_at": "2026-03-08T21:12:26.863Z",
      "author": "maintainer-agent",
      "text": "Implementation complete. Changes: (1) .github/workflows/release.yml created with v*.*.* tag trigger, full CI suite, npm publish, and coverage upload. (2) node: 24 added to ci.yml and nightly.yml matrices. (3) PRD Milestone 6 checklist updated to mark release workflow as complete. (4) README.md Automated Release section added. (5) CHANGELOG.md updated with CI/release automation entries. (6) ci-workflow-contract.spec.ts updated with new assertions for Node 24 in both matrices and a new test for release.yml contract. Tests: 535 passing (1 new), 100% coverage maintained."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-08T21:08:48.927Z",
      "author": "maintainer-agent",
      "text": "Create release.yml with tag-trigger publish and add Node 24 to CI matrices."
    }
  ],
  "files": [
    {
      "path": ".github/workflows/ci.yml",
      "scope": "project",
      "note": "add Node 24 to matrix"
    },
    {
      "path": ".github/workflows/nightly.yml",
      "scope": "project",
      "note": "add Node 24 to nightly matrix"
    },
    {
      "path": ".github/workflows/release.yml",
      "scope": "project",
      "note": "new release workflow to create"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 300,
      "note": "full coverage gate after changes"
    }
  ],
  "docs": [
    {
      "path": "CHANGELOG.md",
      "scope": "project",
      "note": "document new CI and release features"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "update milestone 6 checklist"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "update release readiness section"
    }
  ],
  "close_reason": "Release workflow and Node 24 CI coverage fully implemented. .github/workflows/release.yml created with tag-trigger npm publish. Node 24 added to ci.yml and nightly.yml matrices. CI contract tests updated (535 tests, 100% coverage)."
}
