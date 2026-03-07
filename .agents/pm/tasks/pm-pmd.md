{
  "id": "pm-pmd",
  "title": "M4: Keyword indexing and search command",
  "description": "Implement keyword corpus indexing and query execution.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:search-keyword",
    "core",
    "milestone:4",
    "pm-cli"
  ],
  "created_at": "2026-02-17T23:02:10.065Z",
  "updated_at": "2026-02-18T18:19:31.612Z",
  "deadline": "2026-03-07T23:02:10.065Z",
  "author": "steve",
  "estimated_minutes": 120,
  "acceptance_criteria": "Keyword search command is available and returns deterministic ranked hits across title, description, tags, status, body, comments, notes, learnings, and dependency ids/kinds with TOON/JSON parity and 100% coverage maintained.",
  "dependencies": [
    {
      "id": "pm-54d",
      "kind": "blocks",
      "created_at": "2026-02-17T23:02:10.065Z",
      "author": "steve"
    },
    {
      "id": "pm-f45",
      "kind": "parent",
      "created_at": "2026-02-17T23:02:10.065Z",
      "author": "steve"
    }
  ],
  "comments": [
    {
      "created_at": "2026-02-18T18:03:38.258Z",
      "author": "cursor-maintainer",
      "text": "Plan: docs-first update PRD/README to move keyword search from roadmap to implemented, then add deterministic keyword search command with ranking and tests before running linked pm test + pm test-all."
    },
    {
      "created_at": "2026-02-18T18:04:43.179Z",
      "author": "cursor-maintainer",
      "text": "Docs-first update complete: README and PRD now declare pm search keyword mode in implemented command surface, while semantic/hybrid, reindex, close, and delete remain roadmap work."
    },
    {
      "created_at": "2026-02-18T18:19:26.331Z",
      "author": "cursor-maintainer",
      "text": "Implementation complete: added pm search keyword command with deterministic scoring/sorting and list-like filters, wired CLI/help surface, updated README/PRD contracts, and added unit/integration coverage. Evidence: pm test pm-pmd --run passed both linked commands (coverage + targeted search tests) with 100% statements/branches/functions/lines. Regression evidence: pm test-all --status in_progress --timeout 1800 --json passed totals items=5 linked_tests=17 passed=17 failed=0 skipped=0."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "Docs-first update for milestone/command matrix"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "Docs-first update for command surface"
    },
    {
      "path": "src/cli/commands/index.ts",
      "scope": "project",
      "note": "Export search command runner"
    },
    {
      "path": "src/cli/commands/search.ts",
      "scope": "project",
      "note": "Keyword search scoring and filtering implementation"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "CLI command registration"
    },
    {
      "path": "src/commands/search.ts",
      "scope": "project",
      "note": "Keyword search implementation"
    },
    {
      "path": "tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "note": "CLI smoke coverage for search command"
    },
    {
      "path": "tests/integration/help-readme-contract.spec.ts",
      "scope": "project",
      "note": "README heading contract update for roadmap section"
    },
    {
      "path": "tests/unit/search-command.spec.ts",
      "scope": "project",
      "note": "Search ranking and corpus coverage tests"
    },
    {
      "path": "tests/unit/structure-exports.spec.ts",
      "scope": "project",
      "note": "Ensure runSearch is exported from command index"
    },
    {
      "path": "vitest.config.ts",
      "scope": "project",
      "note": "Include search command in strict 100 percent coverage gate"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "Sandboxed full coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/search-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 300,
      "note": "Targeted sandboxed search unit tests"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "Dogfood workflow rules"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "Authoritative product contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "Public command surface contract"
    }
  ]
}

Implement always-available keyword search functionality.
