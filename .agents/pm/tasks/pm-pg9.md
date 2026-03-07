{
  "id": "pm-pg9",
  "title": "M2: Append-only history writer",
  "description": "Implement append-only JSONL history writes with hashes.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:history",
    "core",
    "milestone:2",
    "pm-cli"
  ],
  "created_at": "2026-02-17T23:02:08.633Z",
  "updated_at": "2026-03-03T20:20:11.865Z",
  "deadline": "2026-02-27T23:02:08.633Z",
  "author": "steve",
  "estimated_minutes": 120,
  "acceptance_criteria": "History appends are durable deterministic and never rewrite prior lines.",
  "dependencies": [
    {
      "id": "pm-c0r",
      "kind": "parent",
      "created_at": "2026-02-17T23:02:08.633Z",
      "author": "steve"
    },
    {
      "id": "pm-u9r",
      "kind": "blocks",
      "created_at": "2026-02-17T23:02:08.633Z",
      "author": "steve"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-03T20:09:44.136Z",
      "author": "cursor-maintainer",
      "text": "Planned changeset: verify append-only history writer behavior against implementation and add focused determinism regression coverage asserting appendHistoryEntry preserves prior JSONL lines while appending new entries."
    },
    {
      "created_at": "2026-03-03T20:10:09.692Z",
      "author": "cursor-maintainer",
      "text": "Implemented focused regression in tests/unit/determinism.spec.ts: appendHistoryEntry now has explicit append-only verification that first JSONL line remains unchanged after a second append and entries stay ordered/deterministic."
    },
    {
      "created_at": "2026-03-03T20:20:05.176Z",
      "author": "cursor-maintainer",
      "text": "Evidence: node dist/cli.js test pm-pg9 --run --timeout 3600 --json passed (linked_tests=2; passed=2; failed=0) including node scripts/run-tests.mjs coverage and node scripts/run-tests.mjs test -- tests/unit/determinism.spec.ts. Regression sweeps passed: node dist/cli.js test-all --status in_progress --timeout 3600 --json totals items=9 linked_tests=32 passed=14 failed=0 skipped=18; node dist/cli.js test-all --status closed --timeout 3600 --json totals items=32 linked_tests=113 passed=48 failed=0 skipped=65. Coverage statement: coverage remained 100% lines/branches/functions/statements. Follow-up items created: none."
    }
  ],
  "files": [
    {
      "path": "src/core/history/history.ts",
      "scope": "project",
      "note": "append-only history writer behavior"
    },
    {
      "path": "tests/unit/determinism.spec.ts",
      "scope": "project",
      "note": "append-only history regression coverage"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 3600,
      "note": "coverage gate verification"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/determinism.spec.ts",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "targeted history determinism regression"
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
      "note": "governing spec"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public contract"
    }
  ]
}

Write mutation events with hash metadata into per-item JSONL files.
