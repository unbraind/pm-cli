{
  "id": "pm-cyj",
  "title": "Packaging hardening for npm release",
  "description": "Ensure package metadata, bin mapping, file allowlist, and prepublish build behavior are release-ready.",
  "type": "Chore",
  "status": "closed",
  "priority": 0,
  "tags": [
    "npm",
    "packaging",
    "pm-cli",
    "release-readiness"
  ],
  "created_at": "2026-02-17T23:37:47.025Z",
  "updated_at": "2026-02-18T01:23:45.114Z",
  "deadline": "2026-02-21T23:37:47.025Z",
  "author": "cursor-agent",
  "estimated_minutes": 180,
  "acceptance_criteria": "npm pack includes only required files, bin maps to built CLI, and prepublish checks/build safeguards are in place.",
  "dependencies": [
    {
      "id": "pm-2c8",
      "kind": "related",
      "created_at": "2026-02-17T23:37:47.025Z",
      "author": "cursor-agent"
    },
    {
      "id": "pm-912",
      "kind": "related",
      "created_at": "2026-02-17T23:37:47.025Z",
      "author": "cursor-agent"
    },
    {
      "id": "pm-ote",
      "kind": "parent",
      "created_at": "2026-02-17T23:37:47.025Z",
      "author": "cursor-agent"
    },
    {
      "id": "pm-pq8",
      "kind": "related",
      "created_at": "2026-02-17T23:37:47.025Z",
      "author": "cursor-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-02-18T00:06:40.377Z",
      "author": "cursor-agent",
      "text": "Packaging evidence: npm pack --dry-run succeeds, bin remains pm->dist/cli.js, dist artifacts are included, and publish payload uses a files allowlist excluding .agents project data."
    },
    {
      "created_at": "2026-02-18T00:16:41.772Z",
      "author": "cursor-agent",
      "text": "Final npm pack smoke check passes with scripts/install.sh and scripts/install.ps1 included in package allowlist alongside dist and docs."
    },
    {
      "created_at": "2026-02-18T01:22:33.253Z",
      "author": "steve",
      "text": "Planned change-set: add npm pack --dry-run smoke gate to CI so package payload validation runs continuously in release-readiness workflows."
    },
    {
      "created_at": "2026-02-18T01:23:27.006Z",
      "author": "steve",
      "text": "Evidence: updated .github/workflows/ci.yml to add CI step 'Packaging smoke check' running npm pack --dry-run. Validation: pm test pm-cyj --run --timeout 180 passed (npm pack --dry-run, exit 0). Regression: pm test-all --status in_progress --timeout 300 passed with totals items=6 linked_tests=8 passed=8 failed=0 skipped=0. Coverage proof from linked sandbox command node scripts/run-tests.mjs coverage remained 100% statements/branches/functions/lines."
    }
  ],
  "files": [
    {
      "path": ".github/workflows/ci.yml",
      "scope": "project",
      "note": "add npm pack dry-run CI gate"
    },
    {
      "path": ".gitignore",
      "scope": "project",
      "note": "Ignore coverage artifacts from local verification runs"
    },
    {
      "path": "package.json",
      "scope": "project",
      "note": "Added files allowlist and prepublish build guard"
    }
  ],
  "tests": [
    {
      "command": "npm pack --dry-run",
      "scope": "project",
      "timeout_seconds": 120,
      "note": "Validate packaged file set excludes dev artifacts"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "dogfood workflow contract"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "governing spec"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "release checklist contract"
    }
  ]
}

Harden package.json and packaging filters to ship only runtime assets and docs while preserving pm command entrypoint compatibility.
