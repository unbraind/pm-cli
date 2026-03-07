{
  "id": "pm-3ses",
  "title": "M5 follow-up: isolate hook execution contexts",
  "description": "Ensure extension hooks run with isolated context snapshots so one hook cannot mutate caller or sibling hook context.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:extensions",
    "code",
    "doc",
    "milestone:5",
    "pm-cli",
    "priority:1",
    "tests"
  ],
  "created_at": "2026-03-06T04:32:38.865Z",
  "updated_at": "2026-03-06T04:45:05.449Z",
  "deadline": "2026-03-07T23:59:00.000Z",
  "author": "maintainer-agent",
  "estimated_minutes": 90,
  "acceptance_criteria": "Hook execution uses cloned context snapshots per hook call and tests prove mutations do not leak across hooks or back to caller.",
  "dependencies": [
    {
      "id": "pm-b1w",
      "kind": "related",
      "created_at": "2026-03-06T04:32:38.865Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-06T04:32:38.865Z",
      "author": "maintainer-agent",
      "text": "Why this exists close remaining hook sandbox boundary by isolating per hook context snapshots."
    },
    {
      "created_at": "2026-03-06T04:32:54.426Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: docs-first update PRD and README to codify per-hook context snapshot isolation then harden extension loader hook execution to clone context per callback and add regression tests for mutation non-leakage."
    },
    {
      "created_at": "2026-03-06T04:33:52.152Z",
      "author": "maintainer-agent",
      "text": "Docs-first update complete: PRD and README now codify per-hook context snapshot isolation so hook-side mutations cannot leak across callbacks or caller state."
    },
    {
      "created_at": "2026-03-06T04:34:48.699Z",
      "author": "maintainer-agent",
      "text": "Implemented code changes: executeRegisteredHooks now runs each hook with a cloned context snapshot and extension-loader unit coverage now verifies mutation isolation across hooks and caller state."
    },
    {
      "created_at": "2026-03-06T04:44:37.820Z",
      "author": "maintainer-agent",
      "text": "Evidence: pm test pm-3ses --run --timeout 7200 --json passed with linked_tests=2 passed=2 failed=0 skipped=0. pm test-all --status in_progress --timeout 7200 --json passed totals items=1 linked_tests=2 passed=2 failed=0 skipped=0. pm test-all --status closed --timeout 7200 --json passed totals items=76 linked_tests=231 passed=61 failed=0 skipped=170. Coverage statement: linked sandboxed coverage runs remained 100% lines branches functions and statements including src/core/extensions/loader.ts and tests/unit/extension-loader.spec.ts."
    },
    {
      "created_at": "2026-03-06T04:45:00.044Z",
      "author": "maintainer-agent",
      "text": "Post-change environment check: pnpm build and npm install -g . succeeded and pm --version reports 0.1.0 from current repository state."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-06T04:32:38.865Z",
      "author": "maintainer-agent",
      "text": "Plan docs first contract update loader hardening unit regression coverage then pm test and test-all sweeps."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "docs-first hook isolation contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "docs-first update"
    },
    {
      "path": "src/core/extensions/loader.ts",
      "scope": "project",
      "note": "hook execution isolation implementation"
    },
    {
      "path": "tests/unit/extension-loader.spec.ts",
      "scope": "project",
      "note": "hook context isolation regression"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 7200,
      "note": "coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/extension-loader.spec.ts",
      "scope": "project",
      "timeout_seconds": 3600,
      "note": "targeted extension loader regressions"
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
      "note": "governing spec"
    }
  ]
}

Close the remaining hook sandbox boundary by cloning beforeCommand afterCommand onRead onWrite and onIndex contexts per hook execution while preserving deterministic warning semantics.
