{
  "id": "pm-k8v",
  "title": "M0: Project scaffolding CLI entrypoint config loader",
  "description": "Validate and close Milestone 0 scaffolding task by linking canonical CLI/config-loader files, docs, and sandbox-safe verification evidence.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:cli",
    "core",
    "milestone:0",
    "pm-cli"
  ],
  "created_at": "2026-02-17T23:02:06.596Z",
  "updated_at": "2026-02-22T15:03:04.323Z",
  "deadline": "2026-02-23T14:44:54.941Z",
  "author": "steve",
  "estimated_minutes": 90,
  "acceptance_criteria": "CLI entrypoint and config loader are present and deterministic, linked evidence includes sandbox-safe tests plus regression sweeps, and closure notes capture 100% coverage gate status.",
  "dependencies": [
    {
      "id": "pm-2xl",
      "kind": "parent",
      "created_at": "2026-02-17T23:02:06.596Z",
      "author": "steve"
    }
  ],
  "comments": [
    {
      "created_at": "2026-02-22T14:45:08.201Z",
      "author": "cursor-maintainer",
      "text": "Planned validation change-set: align tracking metadata with completed milestone-0 scaffolding by linking governing docs, canonical CLI/config-loader files, and sandbox-safe verification commands before running pm test + regression sweeps."
    },
    {
      "created_at": "2026-02-22T15:03:03.728Z",
      "author": "cursor-maintainer",
      "text": "Evidence: pm test pm-k8v --run --timeout 2400 --json passed 2/2 linked tests (coverage + focused settings/cli integration). Regression sweeps passed: pm test-all --status in_progress --timeout 2400 --json => items=11 linked_tests=37 passed=16 failed=0 skipped=21; pm test-all --status closed --timeout 2400 --json => items=23 linked_tests=88 passed=42 failed=0 skipped=46. Coverage proof remains 100% lines/branches/functions/statements in sandbox coverage runs."
    }
  ],
  "files": [
    {
      "path": "src/cli.ts",
      "scope": "project",
      "note": "legacy compatibility entrypoint"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "canonical CLI entrypoint wiring"
    },
    {
      "path": "src/core/store/paths.ts",
      "scope": "project",
      "note": "pm root/global path resolution"
    },
    {
      "path": "src/core/store/settings.ts",
      "scope": "project",
      "note": "deterministic settings loader and defaults"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "coverage-gate-proof"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/settings-store.spec.ts tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "focused-cli-config-loader-validation"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "dogfood workflow and evidence requirements"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative requirements for milestone-0 foundations"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public CLI/bootstrap contract"
    }
  ]
}

Implement baseline project scaffold and command bootstrap.
