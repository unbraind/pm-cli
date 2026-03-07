{
  "id": "pm-l4o",
  "title": "M1: Markdown item parser and serializer",
  "description": "Implement JSON front matter plus body parse and write flow.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:item-io",
    "core",
    "milestone:1",
    "pm-cli"
  ],
  "created_at": "2026-02-17T23:02:07.611Z",
  "updated_at": "2026-02-23T00:02:13.393Z",
  "deadline": "2026-02-23T23:02:07.611Z",
  "author": "steve",
  "estimated_minutes": 150,
  "acceptance_criteria": "Item parser and serializer round-trip without semantic drift.",
  "dependencies": [
    {
      "id": "pm-2xl",
      "kind": "blocks",
      "created_at": "2026-02-17T23:02:07.611Z",
      "author": "steve"
    },
    {
      "id": "pm-u9r",
      "kind": "parent",
      "created_at": "2026-02-17T23:02:07.611Z",
      "author": "steve"
    }
  ],
  "comments": [
    {
      "created_at": "2026-02-22T23:45:15.158Z",
      "author": "cursor-maintainer",
      "text": "Planned changeset: validate parser/serializer round-trip behavior against current implementation and tests, link canonical docs/files/tests, then run pm-linked verification and regression sweeps before closure decision."
    },
    {
      "created_at": "2026-02-23T00:02:12.781Z",
      "author": "cursor-maintainer",
      "text": "Evidence: ran pm test pm-l4o --run --timeout 3600 --json (3/3 linked tests passed), pm test-all --status in_progress --timeout 3600 --json (totals items=9 linked_tests=32 passed=13 failed=0 skipped=19), and pm test-all --status closed --timeout 3600 --json (totals items=29 linked_tests=104 passed=46 failed=0 skipped=58). Coverage statement: sandboxed coverage run in pm-linked tests remains 100% lines/branches/functions/statements. Acceptance criteria met: parser/serializer round-trip behaves without semantic drift in targeted determinism and front-matter validation tests."
    }
  ],
  "files": [
    {
      "path": "src/core/item/item-format.ts",
      "scope": "project",
      "note": "parser and serializer implementation"
    },
    {
      "path": "tests/unit/determinism.spec.ts",
      "scope": "project",
      "note": "canonical round-trip determinism coverage"
    },
    {
      "path": "tests/unit/item-format-validation.spec.ts",
      "scope": "project",
      "note": "front-matter validation coverage"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 2400,
      "note": "full sandboxed coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/determinism.spec.ts",
      "scope": "project",
      "timeout_seconds": 900,
      "note": "targeted serialization round-trip"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/item-format-validation.spec.ts",
      "scope": "project",
      "timeout_seconds": 900,
      "note": "targeted front-matter validation"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "agent workflow contract"
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

Implement parser and canonical serializer for item markdown files.
