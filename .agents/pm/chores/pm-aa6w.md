{
  "id": "pm-aa6w",
  "title": "Add Node 25 to nightly CI and create docs/ architecture+extension guides",
  "description": "Forward-compatibility: add Node 25 (current release) to nightly CI matrix. Production-readiness: create docs/ directory with ARCHITECTURE.md and EXTENSIONS.md to support contributors and users of the tool.",
  "type": "Chore",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:ci",
    "area:docs",
    "code",
    "doc",
    "milestone:6",
    "pm-cli",
    "tests"
  ],
  "created_at": "2026-03-08T21:32:45.349Z",
  "updated_at": "2026-03-08T21:39:14.145Z",
  "deadline": "2026-03-09T21:32:45.349Z",
  "author": "maintainer-agent",
  "estimated_minutes": 90,
  "acceptance_criteria": "Node 25 in nightly workflow YAML and contract test. docs/ with ARCHITECTURE.md and EXTENSIONS.md. 100% coverage maintained.",
  "goal": "Release readiness",
  "objective": "Forward-compat CI and contributor docs",
  "value": "Enables forward compatibility testing and lowers contributor onboarding friction",
  "impact": "Prevents Node 25 regressions early; helps contributors understand codebase",
  "outcome": "Node 25 in nightly; docs/ with architecture and extension guides",
  "why_now": "Node 25 is current; docs/ is a standard production artifact missing from the repo",
  "risk": "low",
  "confidence": "high",
  "sprint": "maintainer-loop",
  "release": "v0.1.0",
  "comments": [
    {
      "created_at": "2026-03-08T21:32:45.349Z",
      "author": "maintainer-agent",
      "text": "Node 25 tested locally and passes all 535 tests. Adding to nightly for forward-compat coverage."
    },
    {
      "created_at": "2026-03-08T21:38:52.472Z",
      "author": "maintainer-agent",
      "text": "Tests passed: 535/535. Coverage: 100% all metrics. Node 25 nightly added, docs/ created (ARCHITECTURE.md + EXTENSIONS.md), package.json files includes docs/**, contract tests updated."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-08T21:32:45.349Z",
      "author": "maintainer-agent",
      "text": "Plan: add Node 25 to nightly matrix and contract test + create docs/ARCHITECTURE.md and docs/EXTENSIONS.md."
    }
  ],
  "files": [
    {
      "path": ".github/workflows/nightly.yml",
      "scope": "project",
      "note": "add Node 25 to matrix"
    },
    {
      "path": "CHANGELOG.md",
      "scope": "project",
      "note": "documented Node 25 and docs/ additions"
    },
    {
      "path": "docs/ARCHITECTURE.md",
      "scope": "project",
      "note": "new architecture guide"
    },
    {
      "path": "docs/EXTENSIONS.md",
      "scope": "project",
      "note": "new extension development guide"
    },
    {
      "path": "package.json",
      "scope": "project",
      "note": "added docs/** to files list"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "added docs/ section and links"
    },
    {
      "path": "tests/integration/ci-workflow-contract.spec.ts",
      "scope": "project",
      "note": "assert Node 25 in nightly"
    },
    {
      "path": "tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "note": "assert docs/** in package files"
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
  "close_reason": "All acceptance criteria met: Node 25 in nightly.yml + ci-workflow-contract test; docs/ARCHITECTURE.md and docs/EXTENSIONS.md created; docs/** in package.json files; 535/535 tests pass; 100% coverage confirmed."
}

Two improvements: 1) Add Node 25 to nightly.yml matrix; 2) Create docs/ARCHITECTURE.md and docs/EXTENSIONS.md; 3) Update contract test; 4) Update package.json files list.
