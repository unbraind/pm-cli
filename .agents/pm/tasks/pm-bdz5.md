{
  "id": "pm-bdz5",
  "title": "M5 roadmap: Pi tool wrapper packaging/distribution polish",
  "description": "Polish packaging and distribution of Pi tool wrapper.",
  "type": "Task",
  "status": "closed",
  "priority": 2,
  "tags": [
    "area:extensions",
    "milestone:5",
    "pm-cli",
    "roadmap"
  ],
  "created_at": "2026-03-07T14:01:19.679Z",
  "updated_at": "2026-03-07T14:45:41.464Z",
  "author": "maintainer-agent",
  "estimated_minutes": 60,
  "acceptance_criteria": "Pi wrapper invokes pm when available and otherwise falls back to the packaged dist/cli.js path; behavior is documented and covered by unit tests.",
  "comments": [
    {
      "created_at": "2026-03-07T14:13:48.475Z",
      "author": "maintainer-agent",
      "text": "Claimed task. Will review Pi extension packaging and distribution."
    },
    {
      "created_at": "2026-03-07T14:23:51.706Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: document and harden Pi wrapper packaging fallback so missing global pm deterministically falls back to this package's dist/cli.js path; add regression assertions for fallback path correctness."
    },
    {
      "created_at": "2026-03-07T14:45:40.940Z",
      "author": "maintainer-agent",
      "text": "Implemented Pi wrapper fallback path hardening: corrected node fallback from .pi extension to packaged dist/cli.js and added regression assertions that fallback path is absolute, resolves under /pm-cli/dist/cli.js, and exists on disk."
    },
    {
      "created_at": "2026-03-07T14:45:41.111Z",
      "author": "maintainer-agent",
      "text": "Evidence: pm test pm-bdz5 --run passed (8/8); pm test-all --status in_progress passed (1 linked test); pm test-all --status closed passed (items=129 linked_tests=341 passed=62 failed=0 skipped=279); node scripts/run-tests.mjs coverage reports 100% statements/branches/functions/lines."
    }
  ],
  "files": [
    {
      "path": ".pi/extensions/pm-cli/index.ts",
      "scope": "project",
      "note": "Pi extension module"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "Specify packaged dist fallback contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "Document deterministic fallback invocation order"
    },
    {
      "path": "tests/unit/pi-agent-extension.spec.ts",
      "scope": "project",
      "note": "fallback path regression assertions"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/pi-agent-extension.spec.ts",
      "scope": "project",
      "timeout_seconds": 240,
      "note": "Pi extension tests"
    }
  ],
  "docs": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "Pi wrapper fallback invocation contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "Pi extension docs"
    }
  ],
  "close_reason": "Pi wrapper now deterministically falls back to packaged dist/cli.js, docs updated, and regression plus full pm test sweeps pass with 100% coverage maintained."
}

Implement packaging/distribution polish for the built-in Pi tool wrapper extension.
