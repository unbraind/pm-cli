{
  "id": "pm-mlc3",
  "title": "Reject flagged package-manager test runners in pm test --add",
  "description": "Reject sandbox-unsafe linked test runner commands when npm/pnpm flags appear before test invocations (for example pnpm --dir /tmp test).",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:test-command",
    "code",
    "milestone:3",
    "pm-cli",
    "priority:1",
    "tests"
  ],
  "created_at": "2026-03-05T12:21:41.101Z",
  "updated_at": "2026-03-05T12:34:32.035Z",
  "deadline": "2026-03-06T23:59:00.000Z",
  "author": "maintainer-agent",
  "estimated_minutes": 90,
  "acceptance_criteria": "pm test --add rejects sandbox-unsafe direct test runner invocations even when package-manager flags precede test/vitest; unit tests cover variants and coverage remains 100%.",
  "dependencies": [
    {
      "id": "pm-11t5",
      "kind": "related",
      "created_at": "2026-03-05T12:21:41.101Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-05T12:21:41.101Z",
      "author": "maintainer-agent",
      "text": "Gap reproduced: pnpm --dir /tmp test currently bypasses sandbox-unsafe runner guard."
    },
    {
      "created_at": "2026-03-05T12:21:58.029Z",
      "author": "maintainer-agent",
      "text": "Intent before edits: harden sandbox-unsafe runner detection so package-manager flags before test/vitest cannot bypass validation; then add targeted regressions for pnpm/npm/yarn/bun flagged variants."
    },
    {
      "created_at": "2026-03-05T12:23:38.331Z",
      "author": "maintainer-agent",
      "text": "Changeset applied: refactored direct test-runner detection in src/cli/commands/test.ts to parse package-manager flags before subcommands (pnpm/npm/yarn/bun/npx), and expanded tests/unit/test-command.spec.ts with flagged unsafe variants plus explicit-env safe allowance coverage."
    },
    {
      "created_at": "2026-03-05T12:24:42.507Z",
      "author": "maintainer-agent",
      "text": "Follow-up coverage hardening: added unsafe regression case './node_modules/.bin/vitest run' to exercise executable-path vitest detection branch and restore 100% gate compliance."
    },
    {
      "created_at": "2026-03-05T12:25:44.532Z",
      "author": "maintainer-agent",
      "text": "Coverage cleanup: removed redundant direct-runner regex fallback branch in src/cli/commands/test.ts because executable suffix checks already cover vitest path executables; behavior unchanged and branch dead code eliminated."
    },
    {
      "created_at": "2026-03-05T12:34:17.713Z",
      "author": "maintainer-agent",
      "text": "Evidence: pm test pm-mlc3 --run --timeout 2400 --json => linked_tests=2 passed=2 failed=0 (coverage gate 100% lines/branches/functions/statements). Regression sweeps: pm test-all --status in_progress --timeout 2400 --json => items=1 linked_tests=2 passed=2 failed=0 skipped=0; pm test-all --status closed --timeout 2400 --json => items=69 linked_tests=214 passed=59 failed=0 skipped=155."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-05T12:21:41.101Z",
      "author": "maintainer-agent",
      "text": "Plan docs-check then parser hardening and unit regression additions."
    }
  ],
  "learnings": [
    {
      "created_at": "2026-03-05T12:21:41.101Z",
      "author": "maintainer-agent",
      "text": "Token-aware launcher parsing must also handle package-manager flag prefixes for runner safety checks."
    }
  ],
  "files": [
    {
      "path": "src/cli/commands/test.ts",
      "scope": "project",
      "note": "runner safety detection logic"
    },
    {
      "path": "tests/unit/test-command.spec.ts",
      "scope": "project",
      "note": "regression coverage for package-manager flag variants"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 2400,
      "note": "coverage gate validation after hardening"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/test-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "targeted runner safety regression suite"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "dogfood and test safety policy"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative sandbox-safe test runner contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public sandbox-safe runner contract"
    }
  ]
}

Observed gap: pm test --add currently accepts commands like 'pnpm --dir /tmp test' which bypass sandbox-safe runner guard. Implement parser-aware detection for npm/pnpm/yarn/bun direct runner invocations with leading flags and add regression coverage.
