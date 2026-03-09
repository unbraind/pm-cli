{
  "id": "pm-1hm2",
  "title": "Release hardening: scoped npm + version policy + CI",
  "description": "Audit for leaked private data, enforce calendar SemVer policy, and harden GitHub/npm release automation for scoped package publishing.",
  "type": "Chore",
  "status": "closed",
  "priority": 0,
  "tags": [
    "ci",
    "pm-cli",
    "release-readiness",
    "security"
  ],
  "created_at": "2026-03-09T12:42:13.949Z",
  "updated_at": "2026-03-09T12:56:34.722Z",
  "deadline": "2026-03-10T12:42:13.949Z",
  "author": "maintainer-agent",
  "estimated_minutes": 180,
  "acceptance_criteria": "No leaked credentials in tracked files/pm data; package/versioning follows YYYY.M.D[-N] policy; CI/release pipelines enforce policy and support @unbrained/pm-cli publishing + npx usage; contributor release docs updated.",
  "comments": [
    {
      "created_at": "2026-03-09T12:42:13.949Z",
      "author": "maintainer-agent",
      "text": "Initiate final release hardening sweep before public launch."
    },
    {
      "created_at": "2026-03-09T12:56:28.657Z",
      "author": "maintainer-agent",
      "text": "Evidence: release hardening validations passed. Commands: pnpm version:next => 2026.3.9; pnpm version:check => passed; pnpm security:scan => no credential-like secrets in tracked files (including .agents/pm tracked data); pnpm smoke:npx => passed (2026.3.9); node scripts/run-tests.mjs test -- tests/integration/ci-workflow-contract.spec.ts tests/integration/help-readme-contract.spec.ts tests/integration/release-readiness-contract.spec.ts => 48/48 passing; pnpm test => 54 files, 541 tests passing; node scripts/run-tests.mjs coverage => 54 files, 541 tests passing at 100% lines/branches/functions/statements."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-09T12:42:13.949Z",
      "author": "maintainer-agent",
      "text": "Implement version policy checks and release workflow guardrails."
    }
  ],
  "files": [
    {
      "path": ".github/ISSUE_TEMPLATE/bug-report.yml",
      "scope": "project",
      "note": "calendar version placeholder"
    },
    {
      "path": ".github/PULL_REQUEST_TEMPLATE.md",
      "scope": "project",
      "note": "new release safety checklist items"
    },
    {
      "path": ".github/workflows/ci.yml",
      "scope": "project",
      "note": "version/security/npx gates in CI"
    },
    {
      "path": ".github/workflows/nightly.yml",
      "scope": "project",
      "note": "nightly version and security checks"
    },
    {
      "path": ".github/workflows/release.yml",
      "scope": "project",
      "note": "release environment publish flow with tag guard"
    },
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "scoped package-spec recursion examples"
    },
    {
      "path": "CHANGELOG.md",
      "scope": "project",
      "note": "release hardening changelog entries"
    },
    {
      "path": "CONTRIBUTING.md",
      "scope": "project",
      "note": "link release runbook"
    },
    {
      "path": "docs/RELEASING.md",
      "scope": "project",
      "note": "maintainer release runbook"
    },
    {
      "path": "package.json",
      "scope": "project",
      "note": "scope package + version policy"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "scoped package-spec recursion examples"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "scoped install docs and release checklist"
    },
    {
      "path": "scripts/check-secrets.mjs",
      "scope": "project",
      "note": "tracked-file secret leak scanner"
    },
    {
      "path": "scripts/install.ps1",
      "scope": "project",
      "note": "scoped installer default package"
    },
    {
      "path": "scripts/install.sh",
      "scope": "project",
      "note": "scoped installer default package"
    },
    {
      "path": "scripts/release-version.mjs",
      "scope": "project",
      "note": "calendar SemVer policy and registry sequencing checks"
    },
    {
      "path": "scripts/smoke-npx-from-pack.mjs",
      "scope": "project",
      "note": "packaged npx smoke test"
    },
    {
      "path": "tests/integration/ci-workflow-contract.spec.ts",
      "scope": "project",
      "note": "workflow contract assertions"
    },
    {
      "path": "tests/integration/help-readme-contract.spec.ts",
      "scope": "project",
      "note": "README installer and package assertions"
    },
    {
      "path": "tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "note": "version policy and packaging assertions"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "full regression gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/integration/ci-workflow-contract.spec.ts tests/integration/help-readme-contract.spec.ts tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "targeted contract verification"
    },
    {
      "command": "pnpm security:scan",
      "scope": "project",
      "timeout_seconds": 120,
      "note": "tracked credential leak scan"
    },
    {
      "command": "pnpm smoke:npx",
      "scope": "project",
      "timeout_seconds": 180,
      "note": "packaged npx executable smoke"
    },
    {
      "command": "pnpm version:check",
      "scope": "project",
      "timeout_seconds": 120,
      "note": "calendar version policy validation"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "dogfood command contract package-spec update"
    },
    {
      "path": "CHANGELOG.md",
      "scope": "project",
      "note": "unreleased release hardening notes"
    },
    {
      "path": "CONTRIBUTING.md",
      "scope": "project",
      "note": "release runbook linkage"
    },
    {
      "path": "docs/RELEASING.md",
      "scope": "project",
      "note": "maintainer release process"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "canonical package-spec recursion examples"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public release/install contract"
    }
  ],
  "close_reason": "Release management hardening completed: scoped package + calendar version policy + CI/release gates validated."
}

Prepare repository for public production release without publishing yet.
