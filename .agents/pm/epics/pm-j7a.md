{
  "id": "pm-j7a",
  "title": "Build pm-cli v1",
  "description": "Top-level delivery epic for pm CLI.",
  "type": "Epic",
  "status": "closed",
  "priority": 0,
  "tags": [
    "area:program",
    "core",
    "milestone:root",
    "pm-cli"
  ],
  "created_at": "2026-02-17T22:59:06.628Z",
  "updated_at": "2026-03-05T00:40:32.009Z",
  "deadline": "2026-03-19T22:59:06.628Z",
  "author": "steve",
  "estimated_minutes": 2400,
  "acceptance_criteria": "All PRD milestones are completed and verified.",
  "comments": [
    {
      "created_at": "2026-02-17T22:59:06.628Z",
      "author": "steve",
      "text": "Root epic exists to coordinate milestone delivery."
    },
    {
      "created_at": "2026-03-04T16:22:45.978Z",
      "author": "cursor-maintainer",
      "text": "Progress update: closed milestone epic pm-jiw (Milestone 6) after sandboxed coverage gate and full pm test-all regression sweeps passed with zero failures; remaining open milestone is pm-b1w."
    },
    {
      "created_at": "2026-03-04T16:50:30.256Z",
      "author": "cursor-maintainer",
      "text": "Progress update: closed extension hardening task pm-qkx0 under milestone pm-b1w and validated via pm test plus pm test-all sweeps with 100 percent coverage gate passing."
    },
    {
      "created_at": "2026-03-04T19:08:17.543Z",
      "author": "cursor-maintainer",
      "text": "Progress update: closed task pm-k3zx to harden recursive test-all detection for global-flag invocation forms in pm test command validation/runtime skip flow, with docs-first contract updates and full pm test + pm test-all evidence at 100 percent coverage."
    },
    {
      "created_at": "2026-03-04T19:31:13.991Z",
      "author": "cursor-maintainer",
      "text": "Progress update: closed child task pm-30lh under milestone pm-b1w; extension hook registration APIs now enforce function handlers at activation with deterministic failure semantics and full regression sweeps passing at 100% coverage."
    },
    {
      "created_at": "2026-03-04T19:52:55.300Z",
      "author": "steve",
      "text": "Progress update: closed task pm-0e8w under milestone pm-b1w; extension command-handler context now runs against cloned args/options/global snapshots to prevent mutation leakage, validated via pm test and pm test-all sweeps with 100% coverage."
    },
    {
      "created_at": "2026-03-04T20:13:21.157Z",
      "author": "cursor-maintainer",
      "text": "Progress update: closed milestone follow-up task pm-8d71 under pm-b1w; extension override/renderer failure containment now includes isolated result snapshots with full pm test and pm test-all evidence at 100% coverage."
    },
    {
      "created_at": "2026-03-04T20:35:02.249Z",
      "author": "maintainer-agent",
      "text": "Progress update: closed milestone-5 follow-up task pm-xyv3 for activity history-directory onRead hook dispatch with docs alignment, targeted regression coverage, and full pm test + pm test-all evidence at 100% coverage."
    },
    {
      "created_at": "2026-03-04T21:07:40.066Z",
      "author": "maintainer-agent",
      "text": "Progress update: closed task pm-q35x (milestone 4 security hardening) by enforcing include-linked scope-root containment in search linked-content reads, updating PRD/README docs-first, and validating with pm test + pm test-all sweeps at 100% coverage."
    },
    {
      "created_at": "2026-03-04T21:29:20.846Z",
      "author": "maintainer-agent",
      "text": "Progress update: closed task pm-lxa0 (milestone 4 security hardening follow-up) by enforcing symlink-resolved include-linked containment checks in search linked corpus reads, updating PRD/README docs-first, and validating with pm test plus pm test-all sweeps at 100% coverage."
    },
    {
      "created_at": "2026-03-04T21:35:07.865Z",
      "author": "maintainer-agent",
      "text": "Running final verification sweep for root epic closure: docs alignment check complete, starting linked sandbox coverage/test and test-all regressions."
    },
    {
      "created_at": "2026-03-04T21:45:15.921Z",
      "author": "maintainer-agent",
      "text": "Evidence: ran pm test pm-j7a --run (2/2 linked tests passed: node scripts/run-tests.mjs coverage + node scripts/run-tests.mjs test); ran pm test-all --status in_progress (items=1, passed=2, failed=0, skipped=0); ran pm test-all --status closed (items=61, linked_tests=194, passed=57, failed=0, skipped=137 duplicate/no-command skips). Coverage gate remains enforced at 100% thresholds via node scripts/run-tests.mjs coverage and passed."
    },
    {
      "created_at": "2026-03-04T23:24:14.666Z",
      "author": "cursor-maintainer",
      "text": "Progress update: closed task pm-ni7x for Pi wrapper numeric scalar parity (priority estimate limit timeout accept number|string with deterministic stringification), with docs-first README/PRD updates and pm test plus regression sweeps passing at 100 percent coverage."
    },
    {
      "created_at": "2026-03-05T00:40:32.009Z",
      "author": "maintainer-agent",
      "text": "Progress update: closed task pm-e6qb to harden Pi wrapper fallback invocation by resolving node dist/cli.js path from module location; validated via pm test pm-e6qb --run plus pm test-all in_progress/closed sweeps with 100% coverage maintained."
    }
  ],
  "notes": [
    {
      "created_at": "2026-02-17T22:59:06.628Z",
      "author": "steve",
      "text": "Success means milestones 0-6 are closed with evidence."
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "regression gate"
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

Coordinate milestones 0..6 and enforce dogfooding.
