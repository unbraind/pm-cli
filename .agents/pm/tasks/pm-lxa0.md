{
  "id": "pm-lxa0",
  "title": "Harden include-linked symlink containment",
  "description": "Prevent include-linked search reads from traversing outside scope roots through symlink targets.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:search",
    "area:security",
    "code",
    "docs",
    "milestone:4",
    "pm-cli",
    "priority:1",
    "tests"
  ],
  "created_at": "2026-03-04T21:16:24.297Z",
  "updated_at": "2026-03-04T21:29:35.747Z",
  "deadline": "2026-03-06T00:00:00.000Z",
  "author": "maintainer-agent",
  "estimated_minutes": 90,
  "acceptance_criteria": "search --include-linked skips linked files docs and tests whose resolved realpath escapes project or global roots including symlink escapes; docs and tests reflect this; coverage remains 100%.",
  "dependencies": [
    {
      "id": "pm-j7a",
      "kind": "parent",
      "created_at": "2026-03-04T21:16:24.297Z",
      "author": "maintainer-agent"
    },
    {
      "id": "pm-q35x",
      "kind": "discovered_from",
      "created_at": "2026-03-04T21:16:24.297Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-04T21:16:24.297Z",
      "author": "maintainer-agent",
      "text": "Follow-up security hardening for include-linked containment with symlink escape coverage"
    },
    {
      "created_at": "2026-03-04T21:16:37.174Z",
      "author": "maintainer-agent",
      "text": "Planned changeset before edits: update PRD and README first to require symlink-resolved scope containment for include-linked reads, then implement realpath-aware checks in search linked-corpus loader and add regression tests for in-root symlink escape paths."
    },
    {
      "created_at": "2026-03-04T21:17:50.362Z",
      "author": "maintainer-agent",
      "text": "Docs-first update completed: PRD and README now require include-linked scope containment to validate both resolved paths and symlink-resolved realpaths before reading linked content."
    },
    {
      "created_at": "2026-03-04T21:29:05.351Z",
      "author": "maintainer-agent",
      "text": "Implemented changeset: search linked-corpus loading now resolves project/global containment roots to realpaths, validates both resolved-path and linked-file realpath boundaries before reads, and skips linked entries when root or linked realpath resolution fails. Added unit regressions for symlink-realpath escapes and realpath failure branches in search-command tests."
    },
    {
      "created_at": "2026-03-04T21:29:10.025Z",
      "author": "maintainer-agent",
      "text": "Evidence: pm test pm-lxa0 --run --timeout 7200 --json passed with run_results passed=2 failed=0 skipped=0 after adding branch-coverage regressions. Regression sweeps passed: pm test-all --status in_progress --timeout 7200 --json totals items=1 linked_tests=2 passed=2 failed=0 skipped=0; pm test-all --status closed --timeout 7200 --json totals items=60 linked_tests=192 passed=57 failed=0 skipped=135. Coverage proof: node scripts/run-tests.mjs coverage reports All files 100% statements branches functions and lines."
    },
    {
      "created_at": "2026-03-04T21:29:35.747Z",
      "author": "maintainer-agent",
      "text": "Post-close environment check: rebuilt project with pnpm build, refreshed global install via npm i -g ., and verified pm --version outputs 0.1.0."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-04T21:16:24.297Z",
      "author": "maintainer-agent",
      "text": "Docs-first update PRD and README then implement search loader realpath checks"
    }
  ],
  "learnings": [
    {
      "created_at": "2026-03-04T21:16:24.297Z",
      "author": "maintainer-agent",
      "text": "Resolved path checks alone are insufficient when symlink targets can escape trusted roots"
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "docs-first contract update"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "docs-first contract update"
    },
    {
      "path": "src/cli/commands/search.ts",
      "scope": "project",
      "note": "realpath-aware containment enforcement"
    },
    {
      "path": "tests/unit/search-command.spec.ts",
      "scope": "project",
      "note": "symlink containment regression"
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
      "command": "node scripts/run-tests.mjs test -- tests/unit/search-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 900,
      "note": "targeted search include-linked regression"
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
      "note": "authoritative search security contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "user-facing contract"
    }
  ]
}

Context: include-linked path containment currently blocks traversal with path.resolve checks but symlink targets can still escape project or global roots. Approach: update docs-first contract to require symlink-resolved containment then implement realpath-aware root checks and add regression tests.
