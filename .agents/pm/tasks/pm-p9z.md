{
  "id": "pm-p9z",
  "title": "M2: RFC6902 patch generation per mutation",
  "description": "Implement patch generation pipeline for item document diffs.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:history",
    "core",
    "milestone:2",
    "pm-cli"
  ],
  "created_at": "2026-02-17T23:02:08.449Z",
  "updated_at": "2026-02-23T18:19:38.505Z",
  "deadline": "2026-02-27T23:02:08.449Z",
  "author": "steve",
  "estimated_minutes": 120,
  "acceptance_criteria": "Each mutation emits deterministic RFC6902 patch operations.",
  "dependencies": [
    {
      "id": "pm-c0r",
      "kind": "parent",
      "created_at": "2026-02-17T23:02:08.449Z",
      "author": "steve"
    },
    {
      "id": "pm-u9r",
      "kind": "blocks",
      "created_at": "2026-02-17T23:02:08.449Z",
      "author": "steve"
    }
  ],
  "comments": [
    {
      "created_at": "2026-02-23T18:06:11.005Z",
      "author": "cursor-maintainer",
      "text": "Planned change-set: audit RFC6902 patch generation determinism and strengthen unit coverage for canonical before/after patch output; update tracking links and close this task with evidence if criteria are met."
    },
    {
      "created_at": "2026-02-23T18:07:11.136Z",
      "author": "cursor-maintainer",
      "text": "Implemented deterministic patch-assertion coverage in tests/unit/determinism.spec.ts: asserts exact RFC6902 operations and verifies identical patch/hash output when front-matter keys are reordered."
    },
    {
      "created_at": "2026-02-23T18:19:37.923Z",
      "author": "cursor-maintainer",
      "text": "Evidence: updated tests/unit/determinism.spec.ts to assert exact RFC6902 replace operations and key-order invariant patch/hash output. Verification passed via pm test pm-p9z --run --timeout 2400 --json (2/2 linked tests passed, including node scripts/run-tests.mjs coverage and targeted determinism spec). Regression sweeps passed: pm test-all --status in_progress --timeout 2400 --json -> items=9 linked_tests=32 passed=14 failed=0 skipped=18; pm test-all --status closed --timeout 2400 --json -> items=31 linked_tests=111 passed=48 failed=0 skipped=63. Coverage remained 100% lines/branches/functions/statements."
    }
  ],
  "files": [
    {
      "path": "src/core/history/history.ts",
      "scope": "project",
      "note": "RFC6902 patch creation and hash computation"
    },
    {
      "path": "tests/unit/determinism.spec.ts",
      "scope": "project",
      "note": "deterministic patch and hash assertions"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 2400,
      "note": "full coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/determinism.spec.ts",
      "scope": "project",
      "timeout_seconds": 900,
      "note": "targeted patch determinism coverage"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "dogfood workflow and test safety rules"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative history patch requirements"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public command and history behavior contract"
    }
  ]
}

Add diff generation for canonical before and after documents.
