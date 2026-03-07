{
  "id": "pm-m6yd",
  "title": "M5 roadmap: Broader call-site expansion for hooks",
  "description": "Expand hook lifecycle call-sites to include init directory bootstrap writes and add deterministic warning propagation coverage.",
  "type": "Task",
  "status": "closed",
  "priority": 2,
  "tags": [
    "area:extensions",
    "milestone:5",
    "pm-cli",
    "roadmap"
  ],
  "created_at": "2026-03-07T14:01:18.992Z",
  "updated_at": "2026-03-07T22:02:41.823Z",
  "deadline": "2026-03-10T21:36:41.713Z",
  "author": "maintainer-agent",
  "estimated_minutes": 120,
  "acceptance_criteria": "runInit dispatches onWrite hooks for each required directory ensure operation, docs reflect expanded hook call-site coverage, and regression tests/coverage stay at 100%.",
  "comments": [
    {
      "created_at": "2026-03-07T21:36:53.800Z",
      "author": "maintainer-agent",
      "text": "Planned change-set: docs-first update PRD and README hook lifecycle call-site contract to include init directory bootstrap writes, then implement runInit onWrite hook dispatch for directory ensure operations and add unit regression coverage for deterministic warning propagation."
    },
    {
      "created_at": "2026-03-07T21:51:23.643Z",
      "author": "maintainer-agent",
      "text": "Implemented docs-first and code/test updates for hook lifecycle call-site expansion: PRD/README now include init directory bootstrap ensure-write dispatch, runInit now dispatches onWrite hooks for each required directory ensure operation, and tests/unit/init-command.spec.ts adds deterministic regression coverage for trace + warning behavior."
    },
    {
      "created_at": "2026-03-07T21:51:23.809Z",
      "author": "maintainer-agent",
      "text": "Evidence: pm test pm-m6yd --run --timeout 7200 --json passed (linked tests 2/2, including node scripts/run-tests.mjs coverage with 100% lines/branches/functions/statements). pm test-all --status in_progress --timeout 7200 --json passed totals items=1 linked_tests=2 passed=2 failed=0 skipped=0. pm test-all --status closed --timeout 7200 --json passed totals items=136 linked_tests=352 passed=63 failed=0 skipped=289. pnpm build passed."
    },
    {
      "created_at": "2026-03-07T22:02:41.823Z",
      "author": "maintainer-agent",
      "text": "Post-close polish: refactored init settings branch to avoid negated-condition lint pattern without behavior change. Re-verified with pm test pm-m6yd --run --timeout 7200 --json (2/2 linked tests passed, coverage still 100%), pm test-all --status in_progress --timeout 7200 --json (items=0 linked_tests=0), and pm test-all --status closed --timeout 7200 --json (items=137 linked_tests=354 passed=64 failed=0 skipped=290)."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "milestone hook lifecycle checklist update"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "hook lifecycle contract update"
    },
    {
      "path": "src/cli/commands/init.ts",
      "scope": "project",
      "note": "init directory bootstrap hook dispatch"
    },
    {
      "path": "tests/unit/init-command.spec.ts",
      "scope": "project",
      "note": "init hook dispatch regression coverage"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 5400,
      "note": "coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/init-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "targeted init hook regression"
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
      "note": "governing spec for hook lifecycle"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public behavior contract for extension hooks"
    }
  ],
  "close_reason": "Hook lifecycle call-site expansion completed: init directory bootstrap now dispatches onWrite hooks; docs and tests updated; pm test and regression sweeps passed with coverage at 100 percent."
}

Expand hook lifecycle baseline for broader call-site expansion.
