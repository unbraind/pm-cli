{
  "id": "pm-7sd",
  "title": "M5: Extension manifest loader and sandbox boundary",
  "description": "Implement extension loading and isolation boundaries.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:extensions-loader",
    "core",
    "milestone:5",
    "pm-cli"
  ],
  "created_at": "2026-02-17T23:02:11.313Z",
  "updated_at": "2026-02-19T12:00:48.886Z",
  "deadline": "2026-03-13T23:02:11.313Z",
  "author": "steve",
  "estimated_minutes": 150,
  "acceptance_criteria": "Extension loader scans global/project manifests with deterministic precedence, respects settings and --no-extensions, and isolates module load failures without breaking core commands.",
  "dependencies": [
    {
      "id": "pm-b1w",
      "kind": "parent",
      "created_at": "2026-02-17T23:02:11.313Z",
      "author": "steve"
    },
    {
      "id": "pm-f45",
      "kind": "blocks",
      "created_at": "2026-02-17T23:02:11.313Z",
      "author": "steve"
    }
  ],
  "comments": [
    {
      "created_at": "2026-02-18T23:25:05.989Z",
      "author": "cursor-maintainer",
      "text": "Planned changeset: implement extension-root discovery and deterministic extension diagnostics in pm health (respects --no-extensions), then add unit coverage for healthy/missing/invalid manifests and disabled entries."
    },
    {
      "created_at": "2026-02-19T00:02:04.388Z",
      "author": "cursor-maintainer",
      "text": "Implemented extension diagnostics in pm health: added global extension-root resolution (PM_GLOBAL_PATH override with ~/.pm-cli fallback), manifest scanning for global/project extension directories, deterministic warning codes for missing/invalid manifests and missing entry files, and --no-extensions bypass that returns a skipped extension check without warnings."
    },
    {
      "created_at": "2026-02-19T00:02:04.529Z",
      "author": "cursor-maintainer",
      "text": "Evidence: pm test pm-7sd --run --timeout 1800 --json passed (node scripts/run-tests.mjs coverage + targeted health test + pnpm build). Coverage gate remains 100% lines/branches/functions/statements, including src/cli/commands/health.ts. Regression sweeps passed: pm test-all --status in_progress --timeout 1800 --json => items=4 linked_tests=20 passed=19 failed=0 skipped=1; pm test-all --status closed --timeout 1800 --json => items=13 linked_tests=34 passed=31 failed=0 skipped=3."
    },
    {
      "created_at": "2026-02-19T00:02:08.965Z",
      "author": "cursor-maintainer",
      "text": "Follow-up polish: removed an unsupported generic type argument in health unit test assertion (toMatchObject<PmCliError> -> toMatchObject) to satisfy TypeScript linting, then re-ran pm test + both pm test-all sweeps to confirm no regressions."
    },
    {
      "created_at": "2026-02-19T01:45:23.581Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: add a core extension manifest loader module used by command runtime, with deterministic layer/priority ordering, enabled/disabled filtering, and isolated module import failures reported as warnings. Then add focused unit coverage for precedence, disabled filtering, and failure isolation."
    },
    {
      "created_at": "2026-02-19T02:09:17.507Z",
      "author": "maintainer-agent",
      "text": "Implemented runtime extension loader groundwork: added src/core/extensions/loader.ts with deterministic global/project discovery, manifest validation (priority/capabilities), enabled/disabled filtering, layer precedence (project overrides global), and isolated dynamic import failures captured as warnings. Integrated discovery into pm health via shared core loader logic and wired runtime loading in src/cli/main.ts preAction hook so extension load failures never break core command execution. Added unit coverage in tests/unit/extension-loader.spec.ts for roots resolution, precedence/filtering, invalid manifest warnings, failure isolation, and --no-extensions skip path. Evidence: pm test pm-7sd --run --timeout 1800 --json passed; coverage command reported 100% lines/branches/functions/statements. Regression sweeps passed: pm test-all --status in_progress --timeout 1800 --json => items=4 linked_tests=21 passed=20 failed=0 skipped=1; pm test-all --status closed --timeout 1800 --json => items=14 linked_tests=37 passed=34 failed=0 skipped=3."
    },
    {
      "created_at": "2026-02-19T02:09:44.491Z",
      "author": "maintainer-agent",
      "text": "Planned doc-alignment follow-up: update PRD/README milestone language to reflect that extension manifest discovery/precedence and failure-isolated runtime loading are now partially implemented, while command/render/hook extension APIs remain pending."
    },
    {
      "created_at": "2026-02-19T02:10:09.804Z",
      "author": "maintainer-agent",
      "text": "Docs aligned with implementation: README Planned Search and Extensions now states runtime extension loading baseline (manifest discovery, filtering, precedence, failure-isolated imports), and PRD Milestone 5 checklist marks extension manifest loader/sandbox boundary as in-progress with explicit implemented vs pending scope."
    },
    {
      "created_at": "2026-02-19T02:35:55.393Z",
      "author": "maintainer-agent",
      "text": "Post-doc-alignment verification rerun completed successfully. Commands: pm test pm-7sd --run --timeout 1800 --json; pm test-all --status in_progress --timeout 1800 --json; pm test-all --status closed --timeout 1800 --json. Results: in_progress sweep totals items=4 linked_tests=21 passed=20 failed=0 skipped=1; closed sweep totals items=14 linked_tests=37 passed=34 failed=0 skipped=3. Coverage output remains 100% lines/branches/functions/statements."
    },
    {
      "created_at": "2026-02-19T02:42:45.521Z",
      "author": "cursor-maintainer",
      "text": "Planned changeset: update docs/contracts first, then make pm health run extension load probe and include extension_load_failed diagnostics in unhealthy warnings while preserving no-extensions and deterministic output behavior."
    },
    {
      "created_at": "2026-02-19T03:13:13.659Z",
      "author": "cursor-maintainer",
      "text": "Implemented docs-first and code alignment for extension health load-failure reporting. Docs: README Planned Search and Extensions now states pm health must surface extension_load_failed diagnostics, and PRD 14.5 now explicitly requires a safe runtime load probe in health checks. Code: src/cli/commands/health.ts now uses loadExtensions (not discover-only) so extension import failures are included in extension warnings/details; tests/unit/health-command.spec.ts adds runtime load probe coverage with a failing boom-ext and successful ok-ext module. Evidence: node dist/cli.js test pm-7sd --run --timeout 1800 --json passed all linked commands; node dist/cli.js test-all --status in_progress --timeout 1800 --json totals passed=20 failed=0 skipped=1; node dist/cli.js test-all --status closed --timeout 1800 --json totals passed=34 failed=0 skipped=3. Coverage remains 100% lines/branches/functions/statements."
    },
    {
      "created_at": "2026-02-19T10:57:51.321Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: raise extension loader to enforced 100% gate by adding branch-complete loader tests and then include src/core/extensions/loader.ts in vitest coverage include. Behavior remains unchanged; this is hardening for release-readiness and PRD coverage policy."
    },
    {
      "created_at": "2026-02-19T11:27:25.129Z",
      "author": "maintainer-agent",
      "text": "Implemented changeset: expanded tests/unit/extension-loader.spec.ts with deterministic tie-break, malformed-manifest matrix, and non-Error load-failure coverage branches; updated vitest.config.ts coverage include to enforce src/core/extensions/loader.ts. Evidence: pm test pm-7sd --run --timeout 1800 --json passed all linked commands (coverage/test/build) and reports 100% lines/branches/functions/statements including core/extensions/loader.ts. Regression sweeps (sequential): pm test-all --status in_progress --timeout 1800 --json => items=4 linked_tests=20 passed=19 failed=0 skipped=1; pm test-all --status closed --timeout 1800 --json => items=15 linked_tests=40 passed=37 failed=0 skipped=3. Note: initial concurrent test-all execution produced contention-related false negatives, resolved by required sequential rerun."
    },
    {
      "created_at": "2026-02-19T11:39:21.275Z",
      "author": "cursor-maintainer",
      "text": "Planned change: enforce extension entry-path sandbox boundary so manifests cannot escape their extension directory; update PRD/README first, then loader + tests."
    },
    {
      "created_at": "2026-02-19T12:00:34.217Z",
      "author": "cursor-maintainer",
      "text": "Implemented extension entry-path sandbox enforcement: manifests whose entry resolves outside their own extension directory now emit extension_entry_outside_extension warnings, are marked warn in discovery diagnostics, and are excluded from effective load candidates. Docs aligned first in PRD.md and README.md, then code/tests updated in src/core/extensions/loader.ts, tests/unit/extension-loader.spec.ts, and tests/unit/health-command.spec.ts. Verification: (1) pm test pm-7sd --run --timeout 1800 --json passed after adding coverage branch test (first run failed 100% gate; fixed with new self-entry branch test), (2) pm test-all --status in_progress --timeout 1800 --json => items=4 linked_tests=20 passed=19 failed=0 skipped=1, (3) pm test-all --status closed --timeout 1800 --json => items=15 linked_tests=40 passed=37 failed=0 skipped=3. Coverage remains 100% lines/branches/functions/statements."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "update milestone 5 checklist for partial extension loader completion"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "document extension loader baseline and remaining roadmap"
    },
    {
      "path": "src/cli/commands/health.ts",
      "scope": "project",
      "note": "add extension health diagnostics"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "invoke extension loader during command runtime"
    },
    {
      "path": "src/core/extensions/index.ts",
      "scope": "project",
      "note": "export extension loader namespace"
    },
    {
      "path": "src/core/extensions/loader.ts",
      "scope": "project",
      "note": "implement deterministic extension loader"
    },
    {
      "path": "src/core/store/paths.ts",
      "scope": "project",
      "note": "resolve global extension root"
    },
    {
      "path": "tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "note": "health check list now includes extensions"
    },
    {
      "path": "tests/unit/extension-loader.spec.ts",
      "scope": "project",
      "note": "cover loader precedence and isolation"
    },
    {
      "path": "tests/unit/health-command.spec.ts",
      "scope": "project",
      "note": "cover extension health check branches"
    },
    {
      "path": "vitest.config.ts",
      "scope": "project",
      "note": "expand enforced coverage include to extension loader"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "coverage gate in sandbox"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/extension-loader.spec.ts",
      "scope": "project",
      "timeout_seconds": 600,
      "note": "targeted extension loader unit coverage"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/health-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 600,
      "note": "targeted extension health regression"
    },
    {
      "command": "pnpm build",
      "scope": "project",
      "timeout_seconds": 240,
      "note": "compile verification"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "agent troubleshooting expects health extension checks"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "governing spec for extension health"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "user contract for extension behavior"
    }
  ]
}

Build extension loading and execution boundary controls.
