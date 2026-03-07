{
  "id": "pm-8z7",
  "title": "M6: CI matrix finalized",
  "description": "Finalize CI matrix across Linux macOS and Windows.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:ci",
    "core",
    "milestone:6",
    "pm-cli"
  ],
  "created_at": "2026-02-17T23:02:12.452Z",
  "updated_at": "2026-02-20T02:42:43.177Z",
  "deadline": "2026-03-19T23:02:12.452Z",
  "author": "steve",
  "estimated_minutes": 120,
  "acceptance_criteria": "CI matrix runs lint typecheck and tests across target platforms.",
  "dependencies": [
    {
      "id": "pm-b1w",
      "kind": "blocks",
      "created_at": "2026-02-17T23:02:12.452Z",
      "author": "steve"
    },
    {
      "id": "pm-jiw",
      "kind": "parent",
      "created_at": "2026-02-17T23:02:12.452Z",
      "author": "steve"
    }
  ],
  "comments": [
    {
      "created_at": "2026-02-20T02:05:32.821Z",
      "author": "cursor-maintainer",
      "text": "Planned change-set: finalize GitHub Actions matrix with deterministic platform/node coverage, concurrency cancellation, and least-privilege permissions while preserving sandboxed regression gates."
    },
    {
      "created_at": "2026-02-20T02:07:17.254Z",
      "author": "cursor-maintainer",
      "text": "Implemented CI matrix finalization: added workflow-level read-only permissions and concurrency cancellation; expanded CI to include Node 22 on ubuntu while keeping cross-platform Node 20 lanes; constrained coverage/sandbox/packaging gates to canonical ubuntu-node20 lane; expanded nightly to Node 20+22 with conditional coverage/full-test split; updated ci-workflow-contract integration test expectations accordingly."
    },
    {
      "created_at": "2026-02-20T02:25:18.587Z",
      "author": "cursor-maintainer",
      "text": "Updated PRD milestone checklist to mark CI matrix finalized as complete, keeping docs authoritative and aligned with implemented workflows."
    },
    {
      "created_at": "2026-02-20T02:42:42.852Z",
      "author": "cursor-maintainer",
      "text": "Evidence: pm test pm-8z7 --run --timeout 1200 --json passed both linked tests (sandbox coverage + CLI integration). Coverage remained 100% statements/branches/functions/lines. Regression sweeps passed: pm test-all --status in_progress --timeout 1200 --json => items=9 linked_tests=40 passed=39 failed=0 skipped=1; pm test-all --status closed --timeout 1200 --json => items=17 linked_tests=47 passed=44 failed=0 skipped=3. Follow-up items created: none required."
    }
  ],
  "files": [
    {
      "path": ".github/workflows/ci.yml",
      "scope": "project",
      "note": "primary CI matrix"
    },
    {
      "path": ".github/workflows/nightly.yml",
      "scope": "project",
      "note": "nightly matrix coverage"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "mark Milestone 6 CI matrix checklist as complete"
    },
    {
      "path": "tests/integration/ci-workflow-contract.spec.ts",
      "scope": "project",
      "note": "workflow contract expectations for finalized matrix"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 900,
      "note": "coverage gate in sandbox"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "timeout_seconds": 600,
      "note": "CLI integration regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "dogfood and test safety rules"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "milestone 6 CI requirements"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "release readiness checklist"
    }
  ]
}

Finalize cross-platform CI and quality gates.
