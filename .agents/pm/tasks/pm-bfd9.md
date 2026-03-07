{
  "id": "pm-bfd9",
  "title": "M5 roadmap: Broader override surfaces",
  "description": "Expand extension command/renderer override surfaces with richer command execution context for deterministic runtime customization.",
  "type": "Task",
  "status": "closed",
  "priority": 2,
  "tags": [
    "area:extensions",
    "milestone:5",
    "pm-cli",
    "roadmap"
  ],
  "created_at": "2026-03-07T14:01:19.143Z",
  "updated_at": "2026-03-07T21:28:27.214Z",
  "author": "maintainer-agent",
  "estimated_minutes": 120,
  "acceptance_criteria": "Command and renderer override surfaces accept richer command execution context; docs and tests cover new behavior; regression sweeps remain green with 100% coverage.",
  "comments": [
    {
      "created_at": "2026-03-07T21:02:57.694Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: docs-first update PRD/README override-surface contract to include richer command execution context for command and renderer overrides, then implement loader/runtime context plumbing with regression tests before running pm test and pm test-all sweeps."
    },
    {
      "created_at": "2026-03-07T21:05:48.759Z",
      "author": "maintainer-agent",
      "text": "Docs-first updates landed in PRD.md and README.md: override/renderer contract now states cloned command args/options/global snapshots plus pm_root metadata are available during override execution. Implementation in progress in loader/runtime plumbing and unit tests."
    },
    {
      "created_at": "2026-03-07T21:28:26.849Z",
      "author": "maintainer-agent",
      "text": "Implemented broader override surfaces: command and renderer overrides now receive cloned command args/options/global snapshots plus pm_root metadata and isolated result snapshots; runtime context plumbing now carries command options/global state (including dynamic extension command paths). Added/updated unit coverage in tests/unit/extension-loader.spec.ts and tests/unit/extensions-runtime.spec.ts; updated PRD.md and README.md contract text. Evidence: pm test pm-bfd9 --run --timeout 3600 --json passed 2/2 linked tests; pm test-all --status in_progress --timeout 3600 --json passed totals items=1 linked_tests=2 passed=2 failed=0 skipped=0; pm test-all --status closed --timeout 3600 --json passed totals items=135 linked_tests=350 passed=63 failed=0 skipped=287; coverage remained 100% lines/branches/functions/statements."
    }
  ],
  "files": [
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "propagate parsed command options/global metadata into active override context"
    },
    {
      "path": "src/core/extensions/index.ts",
      "scope": "project",
      "note": "active runtime context plumbing for overrides"
    },
    {
      "path": "src/core/extensions/loader.ts",
      "scope": "project",
      "note": "expand override context surface"
    },
    {
      "path": "src/core/output/output.ts",
      "scope": "project",
      "note": "override invocation path"
    },
    {
      "path": "tests/unit/extension-loader.spec.ts",
      "scope": "project",
      "note": "unit regressions for override context expansion"
    },
    {
      "path": "tests/unit/extensions-runtime.spec.ts",
      "scope": "project",
      "note": "verify active override/renderer context propagation"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 3600,
      "note": "full coverage gate for release readiness"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/extension-loader.spec.ts",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "targeted override-surface unit suite"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "maintainer workflow and dogfood policy"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "governing spec for extension override behavior"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public behavior contract for override surfaces"
    }
  ],
  "close_reason": "Override surfaces expanded with richer contextual snapshots; docs, tests, and regression sweeps passed with 100% coverage."
}

Implement broader override surfaces for renderers and commands.
