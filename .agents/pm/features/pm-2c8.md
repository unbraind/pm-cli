{
  "id": "pm-2c8",
  "title": "Repo restructure and module boundaries",
  "description": "Refactor source layout into clear CLI wiring vs core domain modules while preserving deterministic behavior and public command compatibility.",
  "type": "Feature",
  "status": "closed",
  "priority": 1,
  "tags": [
    "architecture",
    "pm-cli",
    "refactor",
    "release-readiness"
  ],
  "created_at": "2026-02-17T23:37:26.647Z",
  "updated_at": "2026-03-07T00:36:48.513Z",
  "deadline": "2026-02-21T23:37:26.647Z",
  "author": "cursor-agent",
  "estimated_minutes": 360,
  "acceptance_criteria": "Module boundaries keep src/cli and src/core as canonical implementation locations while legacy root exports remain deterministic and covered by tests/build.",
  "dependencies": [
    {
      "id": "pm-ote",
      "kind": "parent",
      "created_at": "2026-02-17T23:37:26.647Z",
      "author": "cursor-agent"
    },
    {
      "id": "pm-pq8",
      "kind": "related",
      "created_at": "2026-02-17T23:37:26.647Z",
      "author": "cursor-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-02-17T23:51:03.059Z",
      "author": "cursor-agent",
      "text": "Implemented first-pass modular layout (src/cli + src/core + src/types) with stable bin wrapper and new list/test-all command wiring while preserving existing behavior through compatibility bridges."
    },
    {
      "created_at": "2026-02-17T23:51:36.869Z",
      "author": "cursor-agent",
      "text": "Validation evidence: pnpm build succeeded; pm --help includes version/list-in-progress/list-blocked/list-closed/list-canceled/test-all; test-all command executed successfully with dependency_failed semantics available via exit code when failures exist."
    },
    {
      "created_at": "2026-02-18T00:10:15.533Z",
      "author": "cursor-agent",
      "text": "Removed recursive linked test command that invoked test-all from within test-all to prevent self-referential execution loops."
    },
    {
      "created_at": "2026-02-18T15:23:24.689Z",
      "author": "cursor-maintainer",
      "text": "Planned changeset: migrate command-layer imports from legacy flat wrappers to src/core and src/types boundary modules; preserve behavior and keep compatibility wrappers in place for now."
    },
    {
      "created_at": "2026-02-18T15:31:27.978Z",
      "author": "cursor-maintainer",
      "text": "Implemented a behavior-preserving import-boundary migration across command modules to consume src/core/* and src/types/index.js paths directly (activity, append, claim, comments, create, docs, files, gc, get, health, history, init, list, restore, stats, test, test-all, update). Validation: pnpm build; node dist/cli.js test pm-2c8 --run --timeout 1200 --json; node dist/cli.js test-all --status in_progress --timeout 1200 --json. Result: all linked tests passed (13/13 in test-all) and coverage remains 100% lines/branches/functions/statements via node scripts/run-tests.mjs coverage."
    },
    {
      "created_at": "2026-02-18T15:31:55.854Z",
      "author": "cursor-maintainer",
      "text": "Handoff: import-boundary migration step completed and validated; item remains in_progress for future wrapper inversion/removal work."
    },
    {
      "created_at": "2026-02-18T15:35:49.994Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: move list/history/activity implementations into src/cli/commands, leave src/commands/* as compatibility re-export wrappers, and update coverage include paths to enforce implementation files."
    },
    {
      "created_at": "2026-02-18T15:44:18.123Z",
      "author": "maintainer-agent",
      "text": "Implemented command-boundary inversion step: moved list/history/activity implementations into src/cli/commands/*, converted src/commands/{list,history,activity}.ts into compatibility re-export wrappers, and updated src/cli/commands/index.ts + vitest coverage include paths to enforce the new implementation files. Validation evidence: pm test pm-2c8 --run --timeout 1200 --json passed all 4 linked tests; pm test-all --status in_progress --timeout 1200 --json passed totals items=4 linked_tests=13 passed=13 failed=0 skipped=0; coverage remains 100% statements/branches/functions/lines (including cli/commands/activity.ts, history.ts, list.ts)."
    },
    {
      "created_at": "2026-02-18T15:44:34.179Z",
      "author": "maintainer-agent",
      "text": "Handoff: completed list/history/activity command migration to src/cli/commands with compatibility wrappers retained in src/commands. Next incremental step can migrate remaining command implementations similarly and eventually remove wrapper layer when imports are fully switched."
    },
    {
      "created_at": "2026-02-18T16:59:45.039Z",
      "author": "cursor-maintainer",
      "text": "Planned change: migrate store implementation to src/core/store/* and turn root store modules into compatibility re-exports. Goal is to improve module boundaries without changing CLI behavior."
    },
    {
      "created_at": "2026-02-18T17:08:30.877Z",
      "author": "cursor-maintainer",
      "text": "Implemented store-boundary inversion: moved implementations into src/core/store/{item-store,paths,settings}.ts, updated src/core/store/index.ts to local exports, and converted src/{item-store,paths,settings}.ts to compatibility re-exports. Fixed test mock compatibility in tests/unit/list-sort-branches.spec.ts to cover both root and core import paths. Evidence: pm test pm-2c8 --run --timeout 1800 --json passed all linked tests; pm test-all --status in_progress --timeout 1800 --json totals passed=15 failed=0 skipped=0 across 4 items; coverage from node scripts/run-tests.mjs coverage remains 100% for statements/branches/functions/lines."
    },
    {
      "created_at": "2026-02-18T17:08:49.682Z",
      "author": "cursor-maintainer",
      "text": "Iteration complete: store-domain core migration validated and claim released for next incremental boundary refactor step."
    },
    {
      "created_at": "2026-02-18T17:14:20.797Z",
      "author": "cursor-maintainer",
      "text": "Plan for this changeset: tighten module-boundary compatibility by removing stale command wrappers and adding contract tests so core/cli namespace boundaries remain deterministic and release-safe."
    },
    {
      "created_at": "2026-02-18T17:15:33.621Z",
      "author": "cursor-maintainer",
      "text": "Implemented module-boundary refinement: moved runTestAll implementation into src/cli/commands/test-all.ts and converted src/commands/test-all.ts into a compatibility re-export."
    },
    {
      "created_at": "2026-02-18T17:21:25.035Z",
      "author": "cursor-maintainer",
      "text": "Found coverage-gate gap after migration: vitest include list still targets src/commands/test-all.ts and does not include src/cli/commands/test-all.ts. Updating coverage include paths to keep 100% gate meaningful for canonical command location."
    },
    {
      "created_at": "2026-02-18T17:21:40.195Z",
      "author": "cursor-maintainer",
      "text": "Updated coverage include list to target src/cli/commands/test-all.ts (canonical implementation) so migration remains enforced by the 100% coverage gate."
    },
    {
      "created_at": "2026-02-18T17:26:45.568Z",
      "author": "cursor-maintainer",
      "text": "Evidence: pm test pm-2c8 --run --timeout 1200 => passed=4 failed=0 skipped=0; pm test-all --status in_progress --timeout 1200 => items=4 linked_tests=15 passed=15 failed=0 skipped=0; node scripts/run-tests.mjs coverage => All files 100% statements/branches/functions/lines with cli/commands/test-all.ts at 100%."
    },
    {
      "created_at": "2026-02-18T17:27:04.480Z",
      "author": "cursor-maintainer",
      "text": "Handoff: command-boundary migration and coverage alignment complete for this iteration; leaving item in_progress for additional command migrations."
    },
    {
      "created_at": "2026-02-18T17:27:26.692Z",
      "author": "cursor-maintainer",
      "text": "Discovery check this iteration: PRD milestone and major feature areas already have corresponding pm items (M0-M6 epics and subtasks), so no new tracking items were created."
    },
    {
      "created_at": "2026-02-18T17:37:23.979Z",
      "author": "cursor-maintainer",
      "text": "Planned changeset: invert remaining shared/core wrapper direction so src/core contains canonical implementations (shared/fs/item/history/lock/output), while legacy src/* modules remain compatibility re-exports; no behavior changes intended."
    },
    {
      "created_at": "2026-02-18T17:50:17.270Z",
      "author": "cursor-maintainer",
      "text": "Implemented shared/core wrapper inversion step: moved implementations into src/core/{shared,fs,item,history,lock,output} modules, updated core namespace index exports to local modules, and converted legacy root modules in src/* (constants/errors/serialization/time/fs-utils/id/item-format/parse/history/lock/output/command-types) into compatibility re-exports. Validation: pnpm build passed; pm test pm-2c8 --run --timeout 1800 --json passed 4/4 linked tests including sandboxed coverage; pm test-all --status in_progress --timeout 1800 --json passed totals items=4 linked_tests=15 passed=15 failed=0 skipped=0. Coverage remains 100% statements/branches/functions/lines."
    },
    {
      "created_at": "2026-02-18T18:49:44.103Z",
      "author": "cursor-maintainer",
      "text": "Planned changeset: migrate append command implementation to src/cli/commands/append.ts, keep src/commands/append.ts as a compatibility re-export, and update CLI command exports accordingly without behavior changes."
    },
    {
      "created_at": "2026-02-18T18:50:26.059Z",
      "author": "cursor-maintainer",
      "text": "Implemented append-boundary migration: moved runAppend implementation into src/cli/commands/append.ts, converted src/commands/append.ts into a compatibility re-export, and updated CLI command index + coverage include path to keep canonical ownership in src/cli/commands."
    },
    {
      "created_at": "2026-02-18T18:55:03.521Z",
      "author": "cursor-maintainer",
      "text": "Evidence: pnpm build passed; pm test pm-2c8 --run --timeout 1800 --json passed all linked tests (4/4); pm test-all --status in_progress --timeout 1800 --json passed totals items=4 linked_tests=15 passed=15 failed=0 skipped=0. Coverage remains 100% statements/branches/functions/lines via node scripts/run-tests.mjs coverage, including src/cli/commands/append.ts at 100%."
    },
    {
      "created_at": "2026-02-18T18:55:08.119Z",
      "author": "cursor-maintainer",
      "text": "Iteration handoff: append command boundary migration is complete and validated; item remains in_progress for migrating additional command implementations to src/cli/commands while preserving compatibility wrappers."
    },
    {
      "created_at": "2026-02-18T18:58:46.265Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: migrate get command implementation to src/cli/commands/get.ts, keep src/commands/get.ts as compatibility re-export, and update command exports/coverage include path without behavior changes."
    },
    {
      "created_at": "2026-02-18T19:04:10.540Z",
      "author": "maintainer-agent",
      "text": "Implemented get-boundary migration: moved runGet/GetResult implementation into src/cli/commands/get.ts, converted src/commands/get.ts into a compatibility re-export, updated src/cli/commands/index.ts to export runGet from cli namespace, and aligned vitest coverage include to src/cli/commands/get.ts. Behavior and CLI contract unchanged."
    },
    {
      "created_at": "2026-02-18T19:04:10.745Z",
      "author": "maintainer-agent",
      "text": "Evidence: node dist/cli.js test pm-2c8 --run --timeout 1800 --json passed all linked tests (4/4). Regression: node dist/cli.js test-all --status in_progress --timeout 1800 --json passed totals items=4 linked_tests=15 passed=15 failed=0 skipped=0. Coverage from node scripts/run-tests.mjs coverage remains 100% lines/branches/functions/statements, including src/cli/commands/get.ts at 100%."
    },
    {
      "created_at": "2026-02-18T19:04:16.107Z",
      "author": "maintainer-agent",
      "text": "Iteration handoff: get command boundary migration is complete and validated; item remains in_progress for future command migrations while compatibility wrappers are retained."
    },
    {
      "created_at": "2026-02-18T19:07:13.382Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: migrate claim/release command implementation into src/cli/commands/claim.ts, keep src/commands/claim.ts as compatibility re-export, and update command export/coverage include paths so canonical ownership continues moving to cli namespace without behavior changes."
    },
    {
      "created_at": "2026-02-18T19:14:17.176Z",
      "author": "maintainer-agent",
      "text": "Implemented claim-boundary migration: moved runClaim/runRelease and ClaimResult/ReleaseResult into src/cli/commands/claim.ts, converted src/commands/claim.ts into compatibility re-export wrapper, updated src/cli/commands/index.ts to export from ./claim.js, and aligned vitest coverage include to src/cli/commands/claim.ts. Validation: node dist/cli.js test pm-2c8 --run --timeout 1800 --json passed all linked tests (5/5). Regression: node dist/cli.js test-all --status in_progress --timeout 1800 --json passed totals items=4 linked_tests=16 passed=16 failed=0 skipped=0. Coverage remains 100% lines/branches/functions/statements with cli/commands/claim.ts at 100%. Docs alignment check: PRD.md/README.md/AGENTS.md required no text changes because command behavior and surface remained unchanged."
    },
    {
      "created_at": "2026-02-18T19:14:26.388Z",
      "author": "maintainer-agent",
      "text": "Iteration handoff: claim/release command migration to src/cli/commands is complete and validated; compatibility wrapper remains in src/commands/claim.ts and item stays in_progress for remaining command migrations."
    },
    {
      "created_at": "2026-02-18T19:20:32.268Z",
      "author": "cursor-agent",
      "text": "Planned changeset: migrate gc/health/stats implementations into src/cli/commands as canonical command-layer modules, convert src/commands/{gc,health,stats}.ts to compatibility re-exports, and update coverage includes to enforce the canonical files."
    },
    {
      "created_at": "2026-02-18T19:22:38.104Z",
      "author": "cursor-agent",
      "text": "Implemented command-boundary migration for gc/health/stats: moved canonical logic to src/cli/commands/{gc,health,stats}.ts, converted src/commands/{gc,health,stats}.ts to compatibility re-exports, and switched vitest coverage includes to canonical cli command files."
    },
    {
      "created_at": "2026-02-18T19:36:17.397Z",
      "author": "cursor-agent",
      "text": "Evidence: pnpm build passed. pm test pm-2c8 --run --timeout 1800 --json passed all linked checks (5/5). pm test-all --status in_progress --timeout 1800 --json totals: items=4, linked_tests=16, passed=16, failed=0, skipped=0. pm test-all --status closed --timeout 1800 --json totals: items=11, linked_tests=25, passed=22, failed=0, skipped=3. Coverage remains 100% statements/branches/functions/lines (All files 100 in coverage output, including cli/commands/{gc,health,stats}.ts). No new tracking items were required for this changeset."
    },
    {
      "created_at": "2026-02-18T19:41:56.486Z",
      "author": "cursor-maintainer",
      "text": "Planned changeset: migrate comments/docs/files/restore/test command implementations into src/cli/commands, convert src/commands counterparts to compatibility re-exports, and update coverage include paths to enforce canonical cli-boundary ownership."
    },
    {
      "created_at": "2026-02-18T20:00:28.431Z",
      "author": "cursor-maintainer",
      "text": "Implemented command-boundary migration step: moved comments/docs/files/init/restore/test implementations into src/cli/commands/* and converted src/commands/* counterparts into compatibility re-exports. Updated src/cli/commands/index.ts to import canonical cli modules and updated vitest coverage include paths to enforce cli command ownership. Evidence: pnpm build passed; pm test pm-2c8 --run --timeout 1800 --json passed all linked tests; pm test-all --status in_progress --timeout 1800 --json totals items=4 linked_tests=16 passed=16 failed=0 skipped=0; pm test-all --status closed --timeout 1800 --json totals items=11 linked_tests=25 passed=22 failed=0 skipped=3; coverage remains 100% statements/branches/functions/lines (All files 100% from node scripts/run-tests.mjs coverage output)."
    },
    {
      "created_at": "2026-02-18T20:03:49.209Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: migrate create/update command implementations into src/cli/commands, convert src/commands/{create,update}.ts into compatibility re-exports, and update cli command index exports while preserving behavior and docs contracts."
    },
    {
      "created_at": "2026-02-18T20:20:22.827Z",
      "author": "maintainer-agent",
      "text": "Implemented create/update command-boundary migration: moved canonical runCreate/runUpdate implementations to src/cli/commands/{create,update}.ts, converted src/commands/{create,update}.ts to compatibility re-export wrappers, and switched src/cli/commands/index.ts to local cli exports. Behavior and public command contracts remain unchanged."
    },
    {
      "created_at": "2026-02-18T20:20:22.997Z",
      "author": "maintainer-agent",
      "text": "Evidence: pnpm build passed. pm test pm-2c8 --run --timeout 1800 --json passed linked tests count=5 with all run_results passed. pm test-all --status in_progress --timeout 1800 --json totals items=4 linked_tests=16 passed=16 failed=0 skipped=0. pm test-all --status closed --timeout 1800 --json totals items=11 linked_tests=25 passed=22 failed=0 skipped=3. Coverage remains 100% lines/branches/functions/statements in linked coverage runs."
    },
    {
      "created_at": "2026-02-18T20:20:23.159Z",
      "author": "maintainer-agent",
      "text": "Docs alignment check: PRD.md, README.md, and AGENTS.md required no text changes for this changeset because command behavior/surface did not change; this iteration only completes remaining command-boundary migration for create/update ownership."
    },
    {
      "created_at": "2026-02-18T21:23:12.316Z",
      "author": "cursor-maintainer",
      "text": "Planned changeset: remove the remaining cli-to-legacy command wrapper dependency by importing runTest directly from ./test.js inside src/cli/commands/test-all.ts; behavior should remain unchanged."
    },
    {
      "created_at": "2026-02-18T21:36:13.317Z",
      "author": "cursor-maintainer",
      "text": "Implemented boundary cleanup: src/cli/commands/test-all.ts now imports runTest from ./test.js instead of ../../commands/test.js, removing the last cli-to-legacy command-wrapper dependency while preserving behavior."
    },
    {
      "created_at": "2026-02-18T21:36:13.490Z",
      "author": "cursor-maintainer",
      "text": "Evidence: pm test pm-2c8 --run --timeout 1800 --json passed all 5 linked tests; pm test-all --status in_progress --timeout 1800 --json totals items=4 linked_tests=19 passed=18 failed=0 skipped=1; pm test-all --status closed --timeout 1800 --json totals items=11 linked_tests=25 passed=22 failed=0 skipped=3. Coverage proof from linked node scripts/run-tests.mjs coverage output remains 100% statements/branches/functions/lines (All files 100%), including test-all.ts at 100%. Docs alignment: PRD.md/README.md/AGENTS.md required no text changes for this behavior-preserving import-path cleanup."
    },
    {
      "created_at": "2026-02-18T21:40:42.201Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: add explicit compatibility-wrapper contract coverage that verifies src/commands modules remain strict re-exports of src/cli/commands modules, strengthening module-boundary acceptance criteria without behavior changes."
    },
    {
      "created_at": "2026-02-18T21:55:12.360Z",
      "author": "maintainer-agent",
      "text": "Implemented tests/unit/command-wrapper-exports.spec.ts to verify every src/commands/*.ts module is a strict runtime re-export of the matching src/cli/commands/*.ts module. Evidence: pm test pm-2c8 --run --timeout 1800 --json passed all linked tests (count=6); pm test-all --status in_progress --timeout 1800 --json totals items=4 linked_tests=20 passed=19 failed=0 skipped=1; pm test-all --status closed --timeout 1800 --json totals items=11 linked_tests=25 passed=22 failed=0 skipped=3; coverage from linked run-tests coverage output remains 100% statements/branches/functions/lines."
    },
    {
      "created_at": "2026-03-07T00:36:48.513Z",
      "author": "maintainer-agent",
      "text": "Maintenance fix: removed stale linked test command for deleted tests/unit/command-wrapper-exports.spec.ts after closed regression sweep surfaced deterministic missing-file failure in pm test-all."
    }
  ],
  "files": [
    {
      "path": "src/cli.ts",
      "scope": "project",
      "note": "Stable bin wrapper that delegates to src/cli/main.ts"
    },
    {
      "path": "src/cli/commands/activity.ts",
      "scope": "project",
      "note": "command implementation moved under cli boundary"
    },
    {
      "path": "src/cli/commands/append.ts",
      "scope": "project",
      "note": "canonical append command implementation"
    },
    {
      "path": "src/cli/commands/claim.ts",
      "scope": "project",
      "note": "canonical claim/release command implementation"
    },
    {
      "path": "src/cli/commands/comments.ts",
      "scope": "project",
      "note": "cli-boundary-migration"
    },
    {
      "path": "src/cli/commands/create.ts",
      "scope": "project",
      "note": "canonical create command implementation"
    },
    {
      "path": "src/cli/commands/docs.ts",
      "scope": "project",
      "note": "cli-boundary-migration"
    },
    {
      "path": "src/cli/commands/files.ts",
      "scope": "project",
      "note": "cli-boundary-migration"
    },
    {
      "path": "src/cli/commands/gc.ts",
      "scope": "project",
      "note": "canonical gc command implementation"
    },
    {
      "path": "src/cli/commands/get.ts",
      "scope": "project",
      "note": "canonical get command implementation"
    },
    {
      "path": "src/cli/commands/health.ts",
      "scope": "project",
      "note": "canonical health command implementation"
    },
    {
      "path": "src/cli/commands/history.ts",
      "scope": "project",
      "note": "command implementation moved under cli boundary"
    },
    {
      "path": "src/cli/commands/index.ts",
      "scope": "project",
      "note": "CLI command boundary bridge"
    },
    {
      "path": "src/cli/commands/init.ts",
      "scope": "project",
      "note": "cli-boundary-migration"
    },
    {
      "path": "src/cli/commands/list.ts",
      "scope": "project",
      "note": "command implementation moved under cli boundary"
    },
    {
      "path": "src/cli/commands/restore.ts",
      "scope": "project",
      "note": "cli-boundary-migration"
    },
    {
      "path": "src/cli/commands/stats.ts",
      "scope": "project",
      "note": "canonical stats command implementation"
    },
    {
      "path": "src/cli/commands/test-all.ts",
      "scope": "project",
      "note": "Canonical test-all implementation moved into cli command namespace"
    },
    {
      "path": "src/cli/commands/test.ts",
      "scope": "project",
      "note": "cli-boundary-migration"
    },
    {
      "path": "src/cli/commands/update.ts",
      "scope": "project",
      "note": "canonical update command implementation"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "New CLI wiring entrypoint with expanded commands"
    },
    {
      "path": "src/command-types.ts",
      "scope": "project",
      "note": "compatibility wrapper to core shared command types"
    },
    {
      "path": "src/commands/activity.ts",
      "scope": "project",
      "note": "import-boundary migration candidate"
    },
    {
      "path": "src/commands/append.ts",
      "scope": "project",
      "note": "import-boundary migration candidate"
    },
    {
      "path": "src/commands/claim.ts",
      "scope": "project",
      "note": "import-boundary migration candidate"
    },
    {
      "path": "src/commands/comments.ts",
      "scope": "project",
      "note": "import-boundary migration candidate"
    },
    {
      "path": "src/commands/create.ts",
      "scope": "project",
      "note": "import-boundary migration candidate"
    },
    {
      "path": "src/commands/docs.ts",
      "scope": "project",
      "note": "import-boundary migration candidate"
    },
    {
      "path": "src/commands/files.ts",
      "scope": "project",
      "note": "import-boundary migration candidate"
    },
    {
      "path": "src/commands/gc.ts",
      "scope": "project",
      "note": "import-boundary migration to core modules"
    },
    {
      "path": "src/commands/get.ts",
      "scope": "project",
      "note": "import-boundary migration candidate"
    },
    {
      "path": "src/commands/health.ts",
      "scope": "project",
      "note": "import-boundary migration to core modules"
    },
    {
      "path": "src/commands/history.ts",
      "scope": "project",
      "note": "import-boundary migration candidate"
    },
    {
      "path": "src/commands/init.ts",
      "scope": "project",
      "note": "import-boundary migration to core modules"
    },
    {
      "path": "src/commands/list.ts",
      "scope": "project",
      "note": "List limit support for deterministic filtering"
    },
    {
      "path": "src/commands/release.ts",
      "scope": "project",
      "note": "import-boundary migration candidate"
    },
    {
      "path": "src/commands/restore.ts",
      "scope": "project",
      "note": "import-boundary migration candidate"
    },
    {
      "path": "src/commands/stats.ts",
      "scope": "project",
      "note": "import-boundary migration to core modules"
    },
    {
      "path": "src/commands/test-all.ts",
      "scope": "project",
      "note": "Cross-item linked test orchestration command"
    },
    {
      "path": "src/commands/test.ts",
      "scope": "project",
      "note": "import-boundary migration candidate"
    },
    {
      "path": "src/commands/update.ts",
      "scope": "project",
      "note": "import-boundary migration candidate"
    },
    {
      "path": "src/constants.ts",
      "scope": "project",
      "note": "compatibility wrapper to core shared constants"
    },
    {
      "path": "src/core/fs/fs-utils.ts",
      "scope": "project",
      "note": "Core boundary wrapper"
    },
    {
      "path": "src/core/fs/index.ts",
      "scope": "project",
      "note": "Core namespace export"
    },
    {
      "path": "src/core/history/history.ts",
      "scope": "project",
      "note": "Core boundary wrapper"
    },
    {
      "path": "src/core/history/index.ts",
      "scope": "project",
      "note": "Core namespace export"
    },
    {
      "path": "src/core/item/id.ts",
      "scope": "project",
      "note": "Core boundary wrapper"
    },
    {
      "path": "src/core/item/index.ts",
      "scope": "project",
      "note": "Core namespace export"
    },
    {
      "path": "src/core/item/item-format.ts",
      "scope": "project",
      "note": "Core boundary wrapper"
    },
    {
      "path": "src/core/item/parse.ts",
      "scope": "project",
      "note": "Core boundary wrapper"
    },
    {
      "path": "src/core/lock/index.ts",
      "scope": "project",
      "note": "Core namespace export"
    },
    {
      "path": "src/core/lock/lock.ts",
      "scope": "project",
      "note": "Core boundary wrapper"
    },
    {
      "path": "src/core/output/output.ts",
      "scope": "project",
      "note": "Core boundary wrapper"
    },
    {
      "path": "src/core/shared/command-types.ts",
      "scope": "project",
      "note": "Core boundary wrapper"
    },
    {
      "path": "src/core/shared/constants.ts",
      "scope": "project",
      "note": "Core boundary wrapper"
    },
    {
      "path": "src/core/shared/errors.ts",
      "scope": "project",
      "note": "Core boundary wrapper"
    },
    {
      "path": "src/core/shared/index.ts",
      "scope": "project",
      "note": "Core namespace export"
    },
    {
      "path": "src/core/shared/serialization.ts",
      "scope": "project",
      "note": "Core boundary wrapper"
    },
    {
      "path": "src/core/shared/time.ts",
      "scope": "project",
      "note": "Core boundary wrapper"
    },
    {
      "path": "src/core/store/index.ts",
      "scope": "project",
      "note": "Core namespace export"
    },
    {
      "path": "src/core/store/item-store.ts",
      "scope": "project",
      "note": "Core boundary wrapper"
    },
    {
      "path": "src/core/store/paths.ts",
      "scope": "project",
      "note": "Core boundary wrapper"
    },
    {
      "path": "src/core/store/settings.ts",
      "scope": "project",
      "note": "Core boundary wrapper"
    },
    {
      "path": "src/errors.ts",
      "scope": "project",
      "note": "compatibility wrapper to core shared errors"
    },
    {
      "path": "src/fs-utils.ts",
      "scope": "project",
      "note": "compatibility wrapper to core fs module"
    },
    {
      "path": "src/history.ts",
      "scope": "project",
      "note": "compatibility wrapper to core history module"
    },
    {
      "path": "src/id.ts",
      "scope": "project",
      "note": "compatibility wrapper to core item id module"
    },
    {
      "path": "src/item-format.ts",
      "scope": "project",
      "note": "compatibility wrapper to core item format module"
    },
    {
      "path": "src/item-store.ts",
      "scope": "project",
      "note": "compatibility re-export"
    },
    {
      "path": "src/lock.ts",
      "scope": "project",
      "note": "compatibility wrapper to core lock module"
    },
    {
      "path": "src/output.ts",
      "scope": "project",
      "note": "compatibility wrapper to core output module"
    },
    {
      "path": "src/parse.ts",
      "scope": "project",
      "note": "compatibility wrapper to core item parse module"
    },
    {
      "path": "src/paths.ts",
      "scope": "project",
      "note": "compatibility re-export"
    },
    {
      "path": "src/serialization.ts",
      "scope": "project",
      "note": "compatibility wrapper to core shared serialization"
    },
    {
      "path": "src/settings.ts",
      "scope": "project",
      "note": "compatibility re-export"
    },
    {
      "path": "src/time.ts",
      "scope": "project",
      "note": "compatibility wrapper to core shared time"
    },
    {
      "path": "src/types/index.ts",
      "scope": "project",
      "note": "Shared type namespace entry"
    },
    {
      "path": "tests/unit/command-wrapper-exports.spec.ts",
      "scope": "project",
      "note": "wrapper parity contract coverage"
    },
    {
      "path": "tests/unit/list-sort-branches.spec.ts",
      "scope": "project",
      "note": "mock compatibility for core store boundary migration"
    },
    {
      "path": "vitest.config.ts",
      "scope": "project",
      "note": "coverage include paths updated to cli command implementations"
    }
  ],
  "tests": [
    {
      "command": "node dist/cli.js --help",
      "scope": "project",
      "timeout_seconds": 60,
      "note": "Command surface smoke check"
    },
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 900,
      "note": "sandboxed coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test",
      "scope": "project",
      "timeout_seconds": 600,
      "note": "sandboxed unit/integration suite"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/claim-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 300,
      "note": "targeted claim command regression"
    },
    {
      "command": "pnpm build",
      "scope": "project",
      "timeout_seconds": 180,
      "note": "Compile after structure refactor"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "agent workflow and dogfood protocol"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "governing spec"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public command and structure contract"
    }
  ]
}

Implement scalable TypeScript CLI structure with separated command wiring, core domain modules, and shared types; keep existing command behavior stable.
