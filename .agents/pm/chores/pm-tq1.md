{
  "id": "pm-tq1",
  "title": "Installer scripts and update path",
  "description": "Add cross-platform install scripts and document safe install/update flows for npm and script-based bootstrap.",
  "type": "Chore",
  "status": "closed",
  "priority": 1,
  "tags": [
    "install",
    "pm-cli",
    "release-readiness",
    "windows"
  ],
  "created_at": "2026-02-17T23:37:53.836Z",
  "updated_at": "2026-02-22T16:01:10.867Z",
  "deadline": "2026-02-22T23:37:53.836Z",
  "author": "cursor-agent",
  "estimated_minutes": 180,
  "acceptance_criteria": "Install scripts work on Linux/macOS and PowerShell, support update flow, and usage is documented with safe execution guidance.",
  "dependencies": [
    {
      "id": "pm-cyj",
      "kind": "related",
      "created_at": "2026-02-17T23:37:53.836Z",
      "author": "cursor-agent"
    },
    {
      "id": "pm-ote",
      "kind": "parent",
      "created_at": "2026-02-17T23:37:53.836Z",
      "author": "cursor-agent"
    },
    {
      "id": "pm-pq8",
      "kind": "related",
      "created_at": "2026-02-17T23:37:53.836Z",
      "author": "cursor-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-02-18T00:06:54.171Z",
      "author": "cursor-agent",
      "text": "Installer evidence: scripts/install.sh successfully installs from local file package spec with custom --prefix and verifies pm --version. PowerShell runtime (pwsh) is unavailable in this Linux environment, so install.ps1 execution is documented but not executable here."
    },
    {
      "created_at": "2026-02-18T00:16:09.711Z",
      "author": "cursor-agent",
      "text": "README now documents npm update path and idempotent installer rerun behavior to complete install/update documentation scope."
    },
    {
      "created_at": "2026-02-20T08:40:19.747Z",
      "author": "cursor-maintainer",
      "text": "Planned change-set: docs-first replace README installer <raw-url> placeholders with concrete GitHub raw links for this repository, then validate the README contract with focused tests and full regression runs."
    },
    {
      "created_at": "2026-02-20T08:40:46.663Z",
      "author": "cursor-maintainer",
      "text": "Implemented docs-first change-set: README installer bootstrap snippets now use concrete raw GitHub URLs for unbraind/pm-cli install scripts, and help-readme contract integration tests now assert those exact URLs and reject placeholder tokens."
    },
    {
      "created_at": "2026-02-20T09:06:05.432Z",
      "author": "cursor-maintainer",
      "text": "Evidence: node dist/cli.js test pm-tq1 --run --timeout 2400 --json passed 3/3 linked tests (coverage + README contract + installer smoke). Regression sweeps: node dist/cli.js test-all --status in_progress --timeout 2400 --json => items=8 linked_tests=41 passed=40 failed=0 skipped=1; node dist/cli.js test-all --status closed --timeout 2400 --json => items=18 linked_tests=49 passed=46 failed=0 skipped=3. Coverage proof: linked node scripts/run-tests.mjs coverage runs report 100% lines/branches/functions/statements. Follow-up items created: none."
    },
    {
      "created_at": "2026-02-22T12:12:20.438Z",
      "author": "maintainer-agent",
      "text": "Planned change-set: docs-first installer parity hardening for Windows/Linux package override behavior, then add regression coverage that keeps installer contracts deterministic without requiring pwsh runtime in CI."
    },
    {
      "created_at": "2026-02-22T12:32:02.722Z",
      "author": "maintainer-agent",
      "text": "Implemented docs-first installer parity hardening for local package override flows: README.md now documents PM_CLI_PACKAGE override usage for installer smoke tests; scripts/install.ps1 now resolves PackageName from PM_CLI_PACKAGE when PackageName is unset/blank (default remains pm-cli); tests/integration/help-readme-contract.spec.ts now asserts README documents PM_CLI_PACKAGE and verifies shell/PowerShell installer override contract markers to guard cross-platform parity without requiring pwsh runtime. Evidence: (1) node dist/cli.js test pm-tq1 --run --timeout 3600 --json passed all linked tests (coverage + focused contract + install.sh smoke); (2) node dist/cli.js test-all --status in_progress --timeout 3600 --json passed totals items=10 linked_tests=35 passed=15 failed=0 skipped=20; (3) node dist/cli.js test-all --status closed --timeout 3600 --json passed totals items=22 linked_tests=86 passed=42 failed=0 skipped=44. Coverage proof: linked node scripts/run-tests.mjs coverage run stayed at 100% lines/branches/functions/statements."
    },
    {
      "created_at": "2026-02-22T13:31:25.783Z",
      "author": "cursor-maintainer",
      "text": "Planned change-set: ensure scoped npm package overrides (e.g. @scope/pkg) still honor --version in both install.sh and install.ps1 while keeping file/url specs as literal install specs; update README installer contract and help-readme installer parity tests first, then implement script logic."
    },
    {
      "created_at": "2026-02-22T13:42:39.865Z",
      "author": "cursor-maintainer",
      "text": "Implemented docs-first installer parity hardening for scoped package overrides: README.md now states that scoped package names (e.g. @scope/pkg) honor --version while literal specs remain unchanged; scripts/install.sh and scripts/install.ps1 now detect literal install specs (file/url/path/tarball/already-versioned) so only package names receive @<version>; tests/integration/help-readme-contract.spec.ts now asserts this contract and both installer detection helpers. Evidence: node scripts/run-tests.mjs test -- tests/integration/help-readme-contract.spec.ts passed 5/5; node dist/cli.js test pm-tq1 --run --timeout 3600 --json passed all 3 linked tests (coverage + installer contract + install.sh smoke); node dist/cli.js test-all --status in_progress --timeout 3600 --json totals items=10 linked_tests=35 passed=15 failed=0 skipped=20; node dist/cli.js test-all --status closed --timeout 3600 --json totals items=22 linked_tests=86 passed=42 failed=0 skipped=44. Coverage statement: 100% lines/branches/functions/statements preserved in coverage runs. Follow-up items created: none."
    },
    {
      "created_at": "2026-02-22T15:46:55.100Z",
      "author": "maintainer-agent@cursor",
      "text": "Planned change-set: run linked installer/coverage validations and full pm test-all sweeps, then close this chore if acceptance criteria remain fully satisfied on current main."
    },
    {
      "created_at": "2026-02-22T16:01:10.441Z",
      "author": "maintainer-agent@cursor",
      "text": "Evidence: node dist/cli.js test pm-tq1 --run --timeout 3600 --json passed 3/3 linked tests (coverage + README installer contract + install.sh smoke). Coverage proof: node scripts/run-tests.mjs coverage reported 100% lines/branches/functions/statements. Regression sweeps passed: node dist/cli.js test-all --status in_progress --timeout 3600 --json => items=10 linked_tests=37 passed=16 failed=0 skipped=21; node dist/cli.js test-all --status closed --timeout 3600 --json => items=24 linked_tests=90 passed=43 failed=0 skipped=47. Follow-up items created: none."
    }
  ],
  "files": [
    {
      "path": "README.md",
      "scope": "project",
      "note": "replace installer placeholder URLs with concrete upstream links"
    },
    {
      "path": "scripts/install.ps1",
      "scope": "project",
      "note": "PowerShell installer with prefix and version options"
    },
    {
      "path": "scripts/install.sh",
      "scope": "project",
      "note": "POSIX installer with prefix and version options"
    },
    {
      "path": "tests/integration/help-readme-contract.spec.ts",
      "scope": "project",
      "note": "assert installer URL contract in README"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 900,
      "note": "Coverage gate regression proof"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/integration/help-readme-contract.spec.ts",
      "scope": "project",
      "timeout_seconds": 300,
      "note": "README installer contract regression"
    },
    {
      "command": "PM_CLI_PACKAGE=file:/home/steve/GITHUB_RELEASE/pm-cli bash scripts/install.sh --prefix /tmp/pm-cli-install-test --version latest",
      "scope": "project",
      "timeout_seconds": 180,
      "note": "Local package install smoke test"
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
      "note": "governing spec for release-ready docs"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public installation contract"
    }
  ]
}

Provide scripts/install.sh and scripts/install.ps1 for install/update workflows, with verification commands and safer alternatives documented.
