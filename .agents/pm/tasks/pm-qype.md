{
  "id": "pm-qype",
  "title": "M5 roadmap: Broader command sandbox API boundary",
  "description": "Harden dynamic extension command option parsing against prototype-pollution keys while preserving deterministic loose-option behavior.",
  "type": "Task",
  "status": "closed",
  "priority": 2,
  "tags": [
    "area:extensions",
    "milestone:5",
    "pm-cli",
    "roadmap"
  ],
  "created_at": "2026-03-07T14:01:18.825Z",
  "updated_at": "2026-03-07T20:56:31.231Z",
  "deadline": "2026-03-10T20:32:23.001Z",
  "author": "maintainer-agent",
  "estimated_minutes": 120,
  "acceptance_criteria": "Dynamic extension command loose-option parsing ignores unsafe prototype keys, preserves deterministic option parsing for normal keys, and is covered by unit tests with sandbox-safe regression evidence.",
  "comments": [
    {
      "created_at": "2026-03-07T20:32:24.476Z",
      "author": "maintainer-agent",
      "text": "Planned change-set: harden dynamic extension command loose-option parsing in src/cli/main.ts by rejecting unsafe prototype-related keys and using a null-prototype map; add unit tests to lock deterministic behavior and guard against prototype-pollution vectors."
    },
    {
      "created_at": "2026-03-07T20:34:35.159Z",
      "author": "maintainer-agent",
      "text": "Implemented docs-first contract updates in PRD/README for extension loose-option parser hardening, extracted parser into src/cli/extension-command-options.ts, and added focused unit coverage in tests/unit/main-loose-options.spec.ts for deterministic parsing plus unsafe-key rejection."
    },
    {
      "created_at": "2026-03-07T20:35:49.535Z",
      "author": "maintainer-agent",
      "text": "Validation found release-readiness contract failure because new src/cli/extension-command-options.ts was not listed in vitest coverage include allowlist; updated vitest.config.ts include list to keep coverage contract aligned with src modules."
    },
    {
      "created_at": "2026-03-07T20:45:57.799Z",
      "author": "maintainer-agent",
      "text": "Evidence: pm test pm-qype --run --timeout 7200 --json passed (2/2 linked tests) after coverage-include alignment fix; pm test-all --status in_progress --timeout 7200 --json passed (items=1 linked_tests=2 passed=2 failed=0 skipped=0); pm test-all --status closed --timeout 7200 --json passed (items=134 linked_tests=348 passed=62 failed=0 skipped=286). Coverage remains 100% lines/branches/functions/statements."
    },
    {
      "created_at": "2026-03-07T20:46:11.148Z",
      "author": "maintainer-agent",
      "text": "Post-validation polish: replaced Object.prototype.hasOwnProperty.call assertions with Object.hasOwn in new unit test to satisfy Sonar lint guidance while preserving behavior checks."
    },
    {
      "created_at": "2026-03-07T20:56:31.231Z",
      "author": "maintainer-agent",
      "text": "Post-lint-fix verification: pm test pm-qype --run --timeout 7200 --json passed (2/2 linked tests, coverage 100% lines/branches/functions/statements); pm test-all --status in_progress --timeout 7200 --json passed (items=0 linked_tests=0); pm test-all --status closed --timeout 7200 --json passed (items=135 linked_tests=350 passed=63 failed=0 skipped=287)."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "milestone and security hardening contract update"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "extension parser hardening behavior documentation"
    },
    {
      "path": "src/cli/extension-command-options.ts",
      "scope": "project",
      "note": "hardened loose option parser module"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "dynamic extension command option parsing hardening"
    },
    {
      "path": "tests/unit/main-loose-options.spec.ts",
      "scope": "project",
      "note": "option parser sandbox boundary regression"
    },
    {
      "path": "vitest.config.ts",
      "scope": "project",
      "note": "coverage include contract alignment for new parser module"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 5400,
      "note": "coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/main-loose-options.spec.ts",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "targeted parser regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "maintainer workflow contract"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative milestone status"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public extension behavior contract"
    }
  ],
  "close_reason": "Implemented extension command loose-option parser hardening (unsafe key rejection + null-prototype option map), docs updates, and regression tests with 100% coverage maintained."
}

Expand sandbox API boundary for extensions beyond current implementation.
