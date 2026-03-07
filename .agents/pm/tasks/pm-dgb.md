{
  "id": "pm-dgb",
  "title": "M1: ID generation and normalization",
  "description": "Implement prefix-aware ID generation collision checks and normalization.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:ids",
    "core",
    "milestone:1",
    "pm-cli"
  ],
  "created_at": "2026-02-17T23:02:07.810Z",
  "updated_at": "2026-02-21T01:46:08.878Z",
  "deadline": "2026-02-23T23:02:07.810Z",
  "author": "steve",
  "estimated_minutes": 90,
  "acceptance_criteria": "ID generation avoids collisions and normalization is deterministic.",
  "dependencies": [
    {
      "id": "pm-2xl",
      "kind": "blocks",
      "created_at": "2026-02-17T23:02:07.810Z",
      "author": "steve"
    },
    {
      "id": "pm-u9r",
      "kind": "parent",
      "created_at": "2026-02-17T23:02:07.810Z",
      "author": "steve"
    }
  ],
  "comments": [
    {
      "created_at": "2026-02-21T01:33:05.982Z",
      "author": "maintainer-agent",
      "text": "Planned change-set: align default generated ID token length with PRD by fixing token generation logic in src/core/item/id.ts, then add deterministic collision/normalization tests and expand coverage enforcement for the ID module."
    },
    {
      "created_at": "2026-02-21T01:45:53.673Z",
      "author": "maintainer-agent",
      "text": "Implemented: src/core/item/id.ts now generates token bytes with randomBytes(length), ensuring default generated IDs use 4-character tokens per PRD. Added tests/unit/id-generation.spec.ts covering normalization, collision retry, and bounded-attempt exhaustion paths, and expanded vitest coverage include to src/core/item/id.ts. Evidence: node dist/cli.js test pm-dgb --run --timeout 2400 --json passed linked runs (coverage + full regression + targeted id suite); node dist/cli.js test-all --status in_progress --timeout 2400 --json => items=11 linked_tests=58 passed=35 failed=0 skipped=23; node dist/cli.js test-all --status closed --timeout 2400 --json => items=20 linked_tests=54 passed=19 failed=0 skipped=35. Coverage gate remains 100% lines/branches/functions/statements."
    },
    {
      "created_at": "2026-02-21T01:46:08.878Z",
      "author": "maintainer-agent",
      "text": "Docs alignment check: no changes required in PRD.md, README.md, or AGENTS.md for this iteration because they already specify the target ID behavior and implementation now conforms."
    }
  ],
  "files": [
    {
      "path": "src/core/item/id.ts",
      "scope": "project",
      "note": "fix default token length generation logic"
    },
    {
      "path": "tests/unit/id-generation.spec.ts",
      "scope": "project",
      "note": "new deterministic ID generation tests"
    },
    {
      "path": "vitest.config.ts",
      "scope": "project",
      "note": "enforce ID module in 100 percent coverage gate"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "coverage gate proof"
    },
    {
      "command": "node scripts/run-tests.mjs test",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "sandbox full regression"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/id-generation.spec.ts",
      "scope": "project",
      "timeout_seconds": 300,
      "note": "targeted ID generation regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "dogfood workflow"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "governing ID contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public command contract"
    }
  ]
}

Build ID utilities for generation normalization and validation.
