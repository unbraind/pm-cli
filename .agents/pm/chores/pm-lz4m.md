{
  "id": "pm-lz4m",
  "title": "Release @unbrained/pm-cli 2026.3.12",
  "description": "Execute the documented release workflow to publish the next pm-cli version to GitHub Releases and npm.",
  "type": "Chore",
  "status": "in_progress",
  "priority": 0,
  "tags": [
    "pm-cli",
    "publish",
    "release"
  ],
  "created_at": "2026-03-12T23:36:45.792Z",
  "updated_at": "2026-03-12T23:41:04.907Z",
  "deadline": "2026-03-13T23:36:45.792Z",
  "assignee": "release-agent",
  "author": "release-agent",
  "estimated_minutes": 120,
  "acceptance_criteria": "package.json and changelog are updated for the release version, release gates pass, release tag is pushed, GitHub Release is created, and npm publish succeeds without secret leaks.",
  "definition_of_ready": "Release workflow is documented and repository has required publishing permissions/secrets.",
  "goal": "Release",
  "objective": "Publish a verified pm-cli release",
  "value": "Delivers latest pm-cli improvements safely",
  "impact": "Keeps GitHub and npm distribution synchronized",
  "outcome": "A verified release is available on GitHub and npm",
  "why_now": "User requested immediate release execution",
  "risk": "high",
  "confidence": "high",
  "release": "v2026.3.12",
  "customer_impact": "Faster access to latest CLI fixes and features",
  "comments": [
    {
      "created_at": "2026-03-12T23:36:45.792Z",
      "author": "release-agent",
      "text": "Starting release workflow for version 2026.3.12."
    },
    {
      "created_at": "2026-03-12T23:37:09.722Z",
      "author": "release-agent",
      "text": "Preparing release metadata update: set version to 2026.3.12 and cut CHANGELOG release section."
    },
    {
      "created_at": "2026-03-12T23:41:04.907Z",
      "author": "release-agent",
      "text": "Local release gates passed for 2026.3.12: pnpm build, pnpm typecheck, pnpm test (54/54 files, 528/528 tests), pnpm test:coverage (100% lines/branches/functions/statements), node scripts/release-version.mjs check --tag v2026.3.12 --verify-next, pnpm security:scan (no credential-like secrets), node scripts/run-tests.mjs coverage (100%), npm pack --dry-run, pnpm smoke:npx (passed)."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-12T23:36:45.792Z",
      "author": "release-agent",
      "text": "Run full release gates and secret scan before tag push."
    }
  ],
  "files": [
    {
      "path": "CHANGELOG.md",
      "scope": "project",
      "note": "release notes source"
    },
    {
      "path": "package.json",
      "scope": "project",
      "note": "release version source of truth"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "sandboxed coverage gate for release"
    }
  ],
  "docs": [
    {
      "path": "docs/RELEASING.md",
      "scope": "project",
      "note": "canonical release procedure"
    }
  ]
}

Prepare changelog, run release gates, and publish via the tag-triggered GitHub Actions workflow.
