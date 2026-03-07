{
  "id": "pm-e6qb",
  "title": "Pi wrapper fallback path hardening",
  "description": "Make Pi wrapper node fallback resolve the built CLI path deterministically instead of assuming cwd-relative dist/cli.js.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:extensions-pi",
    "code",
    "milestone:5",
    "pm-cli",
    "priority:1",
    "tests"
  ],
  "created_at": "2026-03-05T00:27:48.810Z",
  "updated_at": "2026-03-05T09:33:50.129Z",
  "deadline": "2026-03-06T00:27:48.810Z",
  "author": "maintainer-agent",
  "estimated_minutes": 75,
  "acceptance_criteria": "Pi wrapper falls back to node with a deterministic CLI path that does not depend on cwd, and unit + regression runs pass with 100 percent coverage gate maintained.",
  "dependencies": [
    {
      "id": "pm-ni7x",
      "kind": "related",
      "created_at": "2026-03-05T00:27:48.810Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-05T00:27:48.810Z",
      "author": "maintainer-agent",
      "text": "Why this exists: wrapper fallback should remain reliable when Pi executes outside repo root."
    },
    {
      "created_at": "2026-03-05T00:28:18.833Z",
      "author": "maintainer-agent",
      "text": "Planned change-set: resolve node fallback CLI path from wrapper module location and adjust unit tests to assert deterministic absolute fallback path behavior without cwd assumptions."
    },
    {
      "created_at": "2026-03-05T00:29:54.856Z",
      "author": "maintainer-agent",
      "text": "Implemented changeset: docs/pi/extensions/pm/index.ts now resolves NODE_FALLBACK_CLI_PATH from import.meta.url and uses that absolute path for node fallback invocation; tests/unit/pi-agent-extension.spec.ts now asserts the fallback arg is absolute and ends with dist/cli.js while preserving existing fallback behavior checks."
    },
    {
      "created_at": "2026-03-05T00:40:21.796Z",
      "author": "maintainer-agent",
      "text": "Evidence: pm test pm-e6qb --run --timeout 7200 --json passed 2/2 linked tests; pm test-all --status in_progress --timeout 7200 --json passed totals items=1 linked_tests=2 passed=2 failed=0 skipped=0; pm test-all --status closed --timeout 7200 --json passed totals items=65 linked_tests=204 passed=57 failed=0 skipped=147. Coverage proof remained 100 percent lines/branches/functions/statements (All files 100/100/100/100) from sandboxed run-tests coverage output. Docs alignment check: PRD/README/AGENTS contracts remain accurate with this internal fallback-path hardening; no contract text change required."
    },
    {
      "created_at": "2026-03-05T00:42:34.255Z",
      "author": "maintainer-agent",
      "text": "Post-close maintainer check: refreshed global install via npm install -g . and verified pm --version reports 0.1.0."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-05T00:27:48.810Z",
      "author": "maintainer-agent",
      "text": "Plan: update wrapper fallback path construction and extend pi-agent-extension unit assertions."
    }
  ],
  "files": [
    {
      "path": ".pi/extensions/pm-cli/index.ts",
      "scope": "project",
      "note": "Pi wrapper project-scoped module path"
    },
    {
      "path": "tests/unit/pi-agent-extension.spec.ts",
      "scope": "project",
      "note": "fallback regression assertions"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 2400,
      "note": "sandboxed coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/pi-agent-extension.spec.ts",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "targeted Pi wrapper regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "workflow contract"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "governing spec"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public contract reference"
    }
  ]
}

Context: docs/pi/extensions/pm/index.ts currently falls back to node dist/cli.js when pm is unavailable, which assumes the current working directory is the repository root. Approach: resolve fallback CLI path from module location and add targeted regression tests for deterministic fallback arg shape.
