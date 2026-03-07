{
  "id": "pm-cnil",
  "title": "Optimize test-all dedupe across timeout variants",
  "description": "Ensure test-all executes identical linked command/path only once even when timeout metadata differs, to keep closed-sweep regressions bounded.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:testing",
    "code",
    "milestone:6",
    "pm-cli",
    "priority:1",
    "tests"
  ],
  "created_at": "2026-03-06T21:31:15.657Z",
  "updated_at": "2026-03-06T21:47:11.037Z",
  "deadline": "2026-03-08T18:00:00.000Z",
  "author": "maintainer-agent",
  "estimated_minutes": 90,
  "acceptance_criteria": "pm test-all deduplicates by scope+command/path identity regardless of timeout metadata, chooses a deterministic effective timeout, reports deterministic duplicate skips, and tests/docs reflect behavior.",
  "comments": [
    {
      "created_at": "2026-03-06T21:31:15.657Z",
      "author": "maintainer-agent",
      "text": "Why this exists: release sweeps run too long due to timeout-variant duplicate linked tests."
    },
    {
      "created_at": "2026-03-06T21:31:23.205Z",
      "author": "maintainer-agent",
      "text": "Planned change-set: align docs and implementation so test-all dedupe key ignores timeout metadata and uses deterministic effective timeout when running the retained command."
    },
    {
      "created_at": "2026-03-06T21:34:08.029Z",
      "author": "maintainer-agent",
      "text": "Implemented: test-all now computes a per-key effective timeout (max timeout_seconds across duplicates) before execution, while still emitting duplicate skipped results deterministically. Updated PRD/README/AGENTS contract text and added unit coverage for timeout-variant duplicate commands."
    },
    {
      "created_at": "2026-03-06T21:35:44.535Z",
      "author": "maintainer-agent",
      "text": "Verification note: initial full coverage run failed at 99.96% due to uncovered helper branch in src/cli/commands/test-all.ts. Applied follow-up refactor to remove dead branch structure and keep timeout maxing logic deterministic."
    },
    {
      "created_at": "2026-03-06T21:37:12.970Z",
      "author": "maintainer-agent",
      "text": "Added unit test for equal-timeout duplicate command entries (different notes) to cover deterministic timeout conflict path and restore 100% coverage gate."
    },
    {
      "created_at": "2026-03-06T21:47:10.731Z",
      "author": "maintainer-agent",
      "text": "Evidence: pm test pm-cnil --run passed (tests/unit/test-all-command.spec.ts, 7/7). node scripts/run-tests.mjs coverage passed with 100% statements/branches/functions/lines. pm test-all --status in_progress passed (1 item, failed=0). pm test-all --status closed passed (107 items, linked_tests=296, passed=63, failed=0, skipped=233)."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-06T21:31:15.657Z",
      "author": "maintainer-agent",
      "text": "Plan: update docs then test-all keying logic and unit coverage; verify via sandbox-safe run-tests."
    }
  ],
  "files": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "agent workflow note for timeout-aware test-all dedupe"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative test-all dedupe timeout contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "document timeout conflict resolution in test-all dedupe"
    },
    {
      "path": "src/cli/commands/test-all.ts",
      "scope": "project",
      "note": "dedupe key and timeout selection logic"
    },
    {
      "path": "tests/unit/test-all-command.spec.ts",
      "scope": "project",
      "note": "coverage for timeout-variant dedupe"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/test-all-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "targeted command coverage"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "maintainer workflow contract"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "command contract for test-all dedupe semantics"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public command behavior contract"
    }
  ],
  "close_reason": "test-all duplicate timeout resolution implemented and verified; docs updated; regression sweeps passed"
}

Observed release-maintenance sweeps can trigger repeated execution of identical linked test commands when only timeout_seconds differs across historical items. This creates very long runs and weakens regression-loop usability.
