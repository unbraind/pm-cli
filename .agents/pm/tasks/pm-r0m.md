{
  "id": "pm-r0m",
  "title": "M3: list and list-* filters with deterministic sort",
  "description": "Implement list commands and deterministic ordering with filters.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:list",
    "core",
    "milestone:3",
    "pm-cli"
  ],
  "created_at": "2026-02-17T23:02:09.324Z",
  "updated_at": "2026-02-18T18:45:00.399Z",
  "deadline": "2026-03-03T23:02:09.324Z",
  "author": "steve",
  "estimated_minutes": 120,
  "acceptance_criteria": "List outputs are filterable and sorted per PRD rules.",
  "dependencies": [
    {
      "id": "pm-54d",
      "kind": "parent",
      "created_at": "2026-02-17T23:02:09.324Z",
      "author": "steve"
    },
    {
      "id": "pm-c0r",
      "kind": "blocks",
      "created_at": "2026-02-17T23:02:09.324Z",
      "author": "steve"
    }
  ],
  "comments": [
    {
      "created_at": "2026-02-18T18:36:52.182Z",
      "author": "cursor-maintainer",
      "text": "Planned change-set: verify PRD deterministic list ordering (open before terminal, priority asc, updated_at desc, id asc), tighten any implementation gaps, and add/adjust tests for uncovered branches before running pm test and pm test-all."
    },
    {
      "created_at": "2026-02-18T18:38:07.235Z",
      "author": "cursor-maintainer",
      "text": "Implemented list filter validation hardening: --priority and --limit now require integers, and --type now validates/canonicalizes to Epic|Feature|Task|Chore|Issue (case-insensitive). Added unit coverage for invalid decimal filters, invalid type, and normalized lowercase type filter."
    },
    {
      "created_at": "2026-02-18T18:44:50.674Z",
      "author": "cursor-maintainer",
      "text": "Evidence: pm test pm-r0m --run --timeout 1200 passed (2/2 linked commands: node scripts/run-tests.mjs coverage + node scripts/run-tests.mjs test). Coverage gate remained 100% lines/branches/functions/statements. Regression sweep passed via pm test-all --status in_progress --timeout 1200 (items=5, linked_tests=17, failed=0)."
    }
  ],
  "files": [
    {
      "path": "src/cli/commands/list.ts",
      "scope": "project",
      "note": "list command filtering and output contract"
    },
    {
      "path": "src/core/store/item-store.ts",
      "scope": "project",
      "note": "item retrieval and ordering behavior"
    },
    {
      "path": "tests/unit/list-command.spec.ts",
      "scope": "project",
      "note": "list filter validation and normalization cases"
    },
    {
      "path": "tests/unit/list-sort-branches.spec.ts",
      "scope": "project",
      "note": "unit coverage for deterministic ordering branches"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 900,
      "note": "sandboxed full coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test",
      "scope": "project",
      "timeout_seconds": 900,
      "note": "sandboxed regression test gate"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "dogfood and test safety workflow"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative requirements for list sorting and filters"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public command surface contract for list/list-*"
    }
  ]
}

Implement deterministic listing and filter processing.
