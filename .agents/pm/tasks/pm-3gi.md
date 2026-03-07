{
  "id": "pm-3gi",
  "title": "M1: Item schema model and validation",
  "description": "Define canonical item schema and runtime validation path.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:schema",
    "core",
    "milestone:1",
    "pm-cli"
  ],
  "created_at": "2026-02-17T23:02:07.402Z",
  "updated_at": "2026-02-22T22:37:32.592Z",
  "deadline": "2026-02-23T23:02:07.402Z",
  "author": "steve",
  "estimated_minutes": 120,
  "acceptance_criteria": "Item schema enforces PRD fields and allowed enums.",
  "dependencies": [
    {
      "id": "pm-2xl",
      "kind": "blocks",
      "created_at": "2026-02-17T23:02:07.402Z",
      "author": "steve"
    },
    {
      "id": "pm-u9r",
      "kind": "parent",
      "created_at": "2026-02-17T23:02:07.402Z",
      "author": "steve"
    }
  ],
  "comments": [
    {
      "created_at": "2026-02-22T22:16:13.123Z",
      "author": "maintainer-agent",
      "text": "Plan: harden runtime item front-matter validation in parser paths, add targeted unit tests for required fields/enums/priority/timestamps, then run item tests and regression test-all before closure decision."
    },
    {
      "created_at": "2026-02-22T22:20:57.528Z",
      "author": "maintainer-agent",
      "text": "Implemented parser-level front-matter validation for required PRD fields (id/title/description/type/status/priority/tags/timestamps), with deterministic PmCliError messages for missing/malformed JSON and invalid enum/range/timestamp values. Added unit coverage in tests/unit/item-format-validation.spec.ts."
    },
    {
      "created_at": "2026-02-22T22:22:58.993Z",
      "author": "maintainer-agent",
      "text": "pm test --run failed coverage gate at 99.95% lines/99.96% statements due uncovered item-format parse catch branch (line 267). Next change: add a malformed-balanced JSON front-matter test that reaches JSON.parse catch path."
    },
    {
      "created_at": "2026-02-22T22:37:25.610Z",
      "author": "maintainer-agent",
      "text": "Evidence: (1) pm test pm-3gi --run --timeout 1200 first surfaced coverage regression at 99.95% lines/99.96% statements (uncovered parse catch branch), then passed after adding malformed-balanced JSON test with full 100/100/100/100 coverage. (2) pm test-all --status in_progress --timeout 1200 => items=9 linked_tests=30 passed=11 failed=0 skipped=19. (3) pm test-all --status closed --timeout 1200 => items=28 linked_tests=103 passed=46 failed=0 skipped=57. Follow-up items: none needed for this change-set."
    }
  ],
  "files": [
    {
      "path": "src/core/item/item-format.ts",
      "scope": "project",
      "note": "front-matter validation implementation"
    },
    {
      "path": "tests/unit/item-format-validation.spec.ts",
      "scope": "project",
      "note": "schema validation coverage"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "full sandbox coverage gate"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "agent operating rules"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "governing spec"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public contract"
    }
  ]
}

Implement type model and validation boundaries for items.
