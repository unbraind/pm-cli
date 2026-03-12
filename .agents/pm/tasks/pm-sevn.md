{
  "id": "pm-sevn",
  "title": "Replace docs-as-contract tests with pm-data/runtime checks",
  "description": "Remove README/PRD/AGENTS.md as authoritative contract sources in integration tests and shift release-readiness/help coverage toward pm data and runtime behavior instead.",
  "type": "Task",
  "status": "closed",
  "priority": 0,
  "tags": [
    "pm-cli",
    "pm-data",
    "release-readiness",
    "runtime",
    "tests"
  ],
  "created_at": "2026-03-12T22:55:06.526Z",
  "updated_at": "2026-03-12T23:09:47.363Z",
  "deadline": "2026-03-13T22:55:06.526Z",
  "author": "codex-maintainer",
  "estimated_minutes": 120,
  "acceptance_criteria": "1) Integration tests no longer derive contract expectations from README.md, PRD.md, or AGENTS.md. 2) Remaining release-readiness/help coverage validates runtime behavior and/or pm data instead. 3) README is no longer described as a contract surface in code/docs touched by this change.",
  "definition_of_ready": "README/PRD/AGENTS contract couplings have been identified in the integration suite and supporting docs.",
  "goal": "Contract source cleanup",
  "objective": "Make pm data and runtime behavior the test authority",
  "value": "Reduces brittle prose-doc coupling and keeps documentation descriptive",
  "impact": "Release-readiness tests stop failing on documentation layout changes",
  "outcome": "Tests validate pm behavior without treating docs as specs",
  "why_now": "The current contract suite is coupled to docs the user does not want treated as authoritative.",
  "risk": "medium",
  "confidence": "medium",
  "component": "tests/runtime",
  "customer_impact": "Documentation can evolve without breaking contract tests when behavior has not changed.",
  "comments": [
    {
      "created_at": "2026-03-12T22:55:06.526Z",
      "author": "codex-maintainer",
      "text": "Track removal of prose-doc contract coupling from release-readiness and help integration coverage."
    },
    {
      "created_at": "2026-03-12T23:03:15.471Z",
      "author": "codex-maintainer",
      "text": "Refactored release-readiness/help coverage away from README/PRD/AGENTS contract parsing and toward runtime behavior plus sandboxed pm-data flows. Updated supporting repo language to describe pm data and runtime tests as the source of truth."
    },
    {
      "created_at": "2026-03-12T23:08:00.126Z",
      "author": "codex-maintainer",
      "text": "Renamed the release-readiness suite to release-readiness-runtime and removed AGENTS.md/PRD.md from the runtime readiness assertions; enforcement now stays on pm data and runtime behavior."
    },
    {
      "created_at": "2026-03-12T23:09:39.484Z",
      "author": "codex-maintainer",
      "text": "Evidence: linked runtime regression passed (36 tests), node scripts/check-secrets.mjs reported no tracked credential-like secrets, and node scripts/run-tests.mjs coverage passed with 528 tests and 100% lines/branches/functions/statements."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-12T22:55:06.526Z",
      "author": "codex-maintainer",
      "text": "Primary targets are tests/integration/release-readiness-contract.spec.ts and tests/integration/help-readme-contract.spec.ts plus supporting labels/docs."
    }
  ],
  "files": [
    {
      "path": ".github/PULL_REQUEST_TEMPLATE.md",
      "scope": "project",
      "note": "PR checklist wording cleanup"
    },
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "example note wording cleanup"
    },
    {
      "path": "CONTRIBUTING.md",
      "scope": "project",
      "note": "pm-data source-of-truth guidance"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "planning-reference wording cleanup"
    },
    {
      "path": "tests/integration/help-runtime.spec.ts",
      "scope": "project",
      "note": "runtime help coverage"
    },
    {
      "path": "tests/integration/release-readiness-runtime.spec.ts",
      "scope": "project",
      "note": "main release-readiness runtime suite"
    },
    {
      "path": "tests/unit/create-command.spec.ts",
      "scope": "project",
      "note": "README label cleanup"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs test -- tests/integration/release-readiness-runtime.spec.ts tests/integration/help-runtime.spec.ts tests/unit/create-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "runtime and pm-data regression"
    }
  ],
  "docs": [
    {
      "path": "docs/ARCHITECTURE.md",
      "scope": "project",
      "note": "test suite description cleanup"
    }
  ],
  "close_reason": "Runtime help/readiness enforcement now uses pm data and runtime checks instead of README/PRD/AGENTS contracts; linked regression and full 100% coverage passed."
}

Refactor contract-heavy integration coverage so user documentation is descriptive only. Runtime behavior and pm data should be the source of truth for verification.
