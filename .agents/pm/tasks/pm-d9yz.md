{
  "id": "pm-d9yz",
  "title": "Normalize duplicate milestone epics in tracker",
  "description": "Resolve duplicate open milestone epics by linking to canonical closed milestone lineage and canceling redundant entries to keep work selection deterministic.",
  "type": "Task",
  "status": "closed",
  "priority": 0,
  "tags": [
    "area:planning",
    "area:tracking",
    "docs",
    "milestone:6",
    "pm-cli",
    "priority:0",
    "tests"
  ],
  "created_at": "2026-03-06T23:17:23.778Z",
  "updated_at": "2026-03-06T23:33:08.205Z",
  "deadline": "2026-03-09T23:59:00.000Z",
  "author": "maintainer-agent",
  "estimated_minutes": 75,
  "acceptance_criteria": "All duplicate open milestone epics are either canceled with rationale or linked to canonical items; list-open no longer contains duplicate milestone epics; mandatory pm test and pm test-all sweeps pass with 100% coverage evidence logged.",
  "dependencies": [
    {
      "id": "pm-ep96",
      "kind": "discovered_from",
      "created_at": "2026-03-06T23:17:23.778Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-06T23:17:23.778Z",
      "author": "maintainer-agent",
      "text": "Duplicate open milestone epics were introduced during backlog seeding and now violate duplicate-prevention policy."
    },
    {
      "created_at": "2026-03-06T23:17:54.342Z",
      "author": "maintainer-agent",
      "text": "Planned change-set: annotate and cancel duplicate open milestone epics (pm-6hhn, pm-zetb, pm-murz, pm-met4, pm-xtfo, pm-gyfn, pm-defw) in favor of existing canonical closed milestone lineage to restore deterministic work selection."
    },
    {
      "created_at": "2026-03-06T23:33:07.790Z",
      "author": "maintainer-agent",
      "text": "Implemented tracker normalization by canceling duplicate seeded milestone epics and mapping each to canonical milestones: pm-6hhn->pm-2xl, pm-zetb->pm-u9r, pm-murz->pm-c0r, pm-met4->pm-54d, pm-xtfo->pm-f45, pm-gyfn->pm-b1w, pm-defw->pm-jiw. Verification: pm test pm-d9yz --run --timeout 7200 --json passed (2/2 linked tests); pm test-all --status in_progress --timeout 7200 --json passed (items=1 linked_tests=2 passed=2 failed=0 skipped=0); pm test-all --status closed --timeout 7200 --json passed (items=112 linked_tests=305 passed=63 failed=0 skipped=242). Coverage remains 100% lines/branches/functions/statements in linked sandbox coverage runs."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-06T23:17:23.778Z",
      "author": "maintainer-agent",
      "text": "Perform docs-aligned tracker cleanup first then run full required verification commands."
    }
  ],
  "files": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "duplicate-prevention workflow policy"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "milestone and duplicate-prevention policy source"
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
      "note": "sandbox-safe regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "dogfood workflow source"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "governing spec"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "operator contract"
    }
  ],
  "close_reason": "Duplicate milestone epics canceled and canonical lineage retained; mandatory pm test and regression sweeps passed with 100% coverage."
}

Context: current tracker contains a newly seeded open milestone chain (pm-6hhn..pm-defw) while canonical milestone epics already exist and are closed, creating duplicate planning artifacts. Approach: document rationale in comments, update duplicate epics with explicit duplicate notes, cancel redundant open epics with close reasons, and keep one canonical lineage for future work selection.
