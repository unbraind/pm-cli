{
  "id": "pm-06t",
  "title": "M1: Core command set init create get update append delete claim release close",
  "description": "Implement remaining core close command with deterministic output and atomic history writes while keeping delete deferred to roadmap.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:commands",
    "core",
    "milestone:1",
    "pm-cli"
  ],
  "created_at": "2026-02-17T23:02:08.240Z",
  "updated_at": "2026-03-05T09:34:42.762Z",
  "deadline": "2026-02-23T23:02:08.240Z",
  "author": "steve",
  "estimated_minutes": 180,
  "acceptance_criteria": "create command requires all explicit scalar and repeatable seed flags (use none for explicit empty), docs/help/tests remain aligned, and sandboxed pm test + test-all sweeps pass with coverage still 100%.",
  "dependencies": [
    {
      "id": "pm-2xl",
      "kind": "blocks",
      "created_at": "2026-02-17T23:02:08.240Z",
      "author": "steve"
    },
    {
      "id": "pm-u9r",
      "kind": "parent",
      "created_at": "2026-02-17T23:02:08.240Z",
      "author": "steve"
    }
  ],
  "comments": [
    {
      "created_at": "2026-02-17T23:13:38.874Z",
      "author": "steve",
      "text": "Implemented init/create plus list/get/update/append/comments/files/test/docs/claim/release with deterministic serialization atomic writes and history patches. Verified with pnpm build and list-open/get/update flows."
    },
    {
      "created_at": "2026-02-17T23:13:49.374Z",
      "author": "steve",
      "text": "Verification run succeeded: linked test command list-open passed and pnpm build passed after session-id persistence fixes."
    },
    {
      "created_at": "2026-02-17T23:16:06.137Z",
      "author": "steve",
      "text": "Added persistent settings-backed session id generation and improved seed parser to support quoted comma values, then revalidated with pnpm build."
    },
    {
      "created_at": "2026-02-17T23:17:33.001Z",
      "author": "steve",
      "text": "Added create rollback guard to remove partially written items on any post-write failure, then re-ran pnpm build and linked test execution successfully."
    },
    {
      "created_at": "2026-02-18T18:21:23.324Z",
      "author": "cursor-maintainer",
      "text": "Compliance fix: replace unsandboxed list-open smoke command with sandbox-safe run-tests wrapper so linked tests never read/write repo .agents/pm data."
    },
    {
      "created_at": "2026-02-18T18:26:16.622Z",
      "author": "cursor-maintainer",
      "text": "Evidence: sandbox-safe linked tests validated with pm test pm-06t --run (node scripts/run-tests.mjs test + pnpm build both passed). Regression sweep pm test-all --status in_progress --timeout 1800 --json passed totals items=4 linked_tests=15 passed=15 failed=0 skipped=0."
    },
    {
      "created_at": "2026-02-21T13:58:09.423Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: update PRD/README command tables first, then implement runClose + CLI wiring + unit/integration coverage; keep delete deferred and explicitly documented."
    },
    {
      "created_at": "2026-02-21T14:01:41.897Z",
      "author": "maintainer-agent",
      "text": "Implemented docs-first close-command changeset: PRD/README now classify close as core and delete as roadmap; added runClose command, CLI wiring, command exports, and focused unit/integration tests."
    },
    {
      "created_at": "2026-02-21T14:11:41.220Z",
      "author": "maintainer-agent",
      "text": "Evidence: ran pm test pm-06t --run --timeout 3600 --json (all 4 linked checks passed: node scripts/run-tests.mjs coverage, node scripts/run-tests.mjs test, focused close-command test slice, pnpm build). Coverage gate remained green under the enforced 100% thresholds. Regression sweeps passed: pm test-all --status in_progress --timeout 3600 --json => items=11 linked_tests=62 passed=36 failed=0 skipped=26; pm test-all --status closed --timeout 3600 --json => items=21 linked_tests=57 passed=20 failed=0 skipped=37. Follow-up items created: none."
    },
    {
      "created_at": "2026-02-21T14:12:19.231Z",
      "author": "maintainer-agent",
      "text": "Handoff note: close command implementation/docs/tests completed this iteration; item remains in_progress for future delete-command roadmap work. Releasing claim until next session."
    },
    {
      "created_at": "2026-02-22T15:10:05.016Z",
      "author": "cursor-maintainer",
      "text": "Planned change-set: enforce create --assigned-to-session as an explicit required flag to match PRD/README/AGENTS all-fields contract; update CLI normalization and Pi wrapper create arg builder defaulting to none for omitted input, then validate with focused + regression coverage."
    },
    {
      "created_at": "2026-02-22T15:36:02.797Z",
      "author": "cursor-maintainer",
      "text": "Implemented create all-fields contract parity: create now requires --assigned-to-session in CLI command wiring/normalization (src/cli/main.ts + src/cli/commands/create.ts), Pi wrapper create args now always include --assigned-to-session (default none when omitted) in docs/pi/extensions/pm/index.ts, and regression tests were added/updated in tests/integration/cli.integration.spec.ts, tests/unit/pi-agent-extension.spec.ts, and tests/unit/todos-extension.spec.ts. Evidence: pnpm build passed; node scripts/run-tests.mjs test -- tests/unit/pi-agent-extension.spec.ts tests/unit/todos-extension.spec.ts tests/integration/cli.integration.spec.ts passed. Required pm validation rerun after fixture updates: pm test pm-06t --run --timeout 3600 --json passed all 6 linked tests (including node scripts/run-tests.mjs coverage), pm test-all --status in_progress --timeout 3600 --json passed totals items=10 linked_tests=37 passed=16 failed=0 skipped=21, and pm test-all --status closed --timeout 3600 --json passed totals items=24 linked_tests=90 passed=43 failed=0 skipped=47. Coverage statement: coverage gate remained at 100% lines/branches/functions/statements in sandboxed runs. Follow-up items created: none."
    },
    {
      "created_at": "2026-02-22T16:07:49.269Z",
      "author": "cursor-maintainer",
      "text": "Planned docs-first change-set: require explicit repeatable create seed flags (--dep/--comment/--note/--learning/--file/--test/--doc) using none as empty sentinel, then enforce in CLI normalization and Pi wrapper arg defaults with integration/unit coverage updates."
    },
    {
      "created_at": "2026-02-22T16:12:23.919Z",
      "author": "cursor-maintainer",
      "text": "Implemented docs-first contract hardening: README.md + PRD.md now require every repeatable create seed flag to be passed explicitly (use none for empty), AGENTS.md template section documents the same requirement, src/cli/main.ts normalizeCreateOptions now enforces presence of --dep/--comment/--note/--learning/--file/--test/--doc, docs/pi/extensions/pm/index.ts defaults omitted create repeatables to none, and tests were updated in tests/integration/cli.integration.spec.ts + tests/unit/pi-agent-extension.spec.ts."
    },
    {
      "created_at": "2026-02-22T16:27:52.824Z",
      "author": "cursor-maintainer",
      "text": "Evidence: pm test pm-06t --run --timeout 3600 --json passed (6/6 linked tests). Regression sweeps passed: pm test-all --status in_progress --timeout 3600 --json => totals items=9 linked_tests=34 passed=14 failed=0 skipped=20; pm test-all --status closed --timeout 3600 --json => totals items=24 linked_tests=92 passed=43 failed=0 skipped=49. Coverage proof remains 100% lines/branches/functions/statements in sandboxed coverage runs. Commands now enforce explicit create repeatable seed flags with none sentinel and Pi wrapper defaults omitted create repeatables to none."
    },
    {
      "created_at": "2026-02-22T16:32:21.287Z",
      "author": "maintainer-agent",
      "text": "Planned change-set: run release-readiness contract checks to detect any remaining docs/help/implementation drift in create command surface, then apply docs-first fixes and tests if required."
    },
    {
      "created_at": "2026-02-22T17:00:17.473Z",
      "author": "maintainer-agent",
      "text": "Blocked from closure this run: pm test-all --status closed failed (exit 5) due timeout in tests/integration/cli.integration.spec.ts > restores an item by version through CLI during pm-66o linked regression command. Pausing pm-06t closure while fixing reliability in pm-66o."
    },
    {
      "created_at": "2026-02-22T17:15:46.593Z",
      "author": "maintainer-agent",
      "text": "Unblock note: pm-66o reliability fix removed closed-sweep timeout flake; latest validation is green: pm test pm-06t --run passed (6/6), pm test-all --status in_progress passed (items=10 linked_tests=35 passed=15 failed=0 skipped=20), and pm test-all --status closed passed (items=24 linked_tests=92 passed=43 failed=0 skipped=49) with coverage gate still 100%."
    }
  ],
  "files": [
    {
      "path": ".pi/extensions/pm-cli/index.ts",
      "scope": "project",
      "note": "Pi wrapper project-scoped module path"
    },
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "create repeatable seed requirement note"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "core vs roadmap command list update"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "command matrix updated for close"
    },
    {
      "path": "src/cli.ts",
      "scope": "project",
      "note": "command registration and global flags"
    },
    {
      "path": "src/cli/commands/close.ts",
      "scope": "project",
      "note": "close command implementation"
    },
    {
      "path": "src/cli/commands/index.ts",
      "scope": "project",
      "note": "export runClose"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "register close command"
    },
    {
      "path": "src/commands/claim.ts",
      "scope": "project",
      "note": "session ownership commands"
    },
    {
      "path": "src/commands/close.ts",
      "scope": "project",
      "note": "compat re-export for close command"
    },
    {
      "path": "src/commands/comments.ts",
      "scope": "project",
      "note": "comments mutation and listing"
    },
    {
      "path": "src/commands/create.ts",
      "scope": "project",
      "note": "create rollback and session-aware lock usage"
    },
    {
      "path": "src/commands/docs.ts",
      "scope": "project",
      "note": "linked docs tracking command"
    },
    {
      "path": "src/commands/files.ts",
      "scope": "project",
      "note": "linked file tracking command"
    },
    {
      "path": "src/commands/test.ts",
      "scope": "project",
      "note": "linked test tracking and optional execution"
    },
    {
      "path": "src/commands/update.ts",
      "scope": "project",
      "note": "update command implementation"
    },
    {
      "path": "src/item-format.ts",
      "scope": "project",
      "note": "undefined-key normalization cleanup"
    },
    {
      "path": "src/item-store.ts",
      "scope": "project",
      "note": "shared lock mutate and history pipeline"
    },
    {
      "path": "src/parse.ts",
      "scope": "project",
      "note": "CSV key-value parser with quoted comma support"
    },
    {
      "path": "src/settings.ts",
      "scope": "project",
      "note": "persistent session id generation"
    },
    {
      "path": "tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "note": "exercise close command in lifecycle"
    },
    {
      "path": "tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "note": "doc/help command alignment contract"
    },
    {
      "path": "tests/unit/close-command.spec.ts",
      "scope": "project",
      "note": "unit coverage for runClose"
    },
    {
      "path": "tests/unit/pi-agent-extension.spec.ts",
      "scope": "project",
      "note": "assert Pi wrapper emits required assigned-to-session flag"
    },
    {
      "path": "tests/unit/todos-extension.spec.ts",
      "scope": "project",
      "note": "update create fixtures for required assigned-to-session contract"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 3600,
      "note": "full coverage gate in sandbox"
    },
    {
      "command": "node scripts/run-tests.mjs test",
      "scope": "project",
      "timeout_seconds": 1200,
      "note": "Sandboxed core command regression"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/close-command.spec.ts tests/integration/cli.integration.spec.ts tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "sandboxed focused validation for close command"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/pi-agent-extension.spec.ts tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "targeted create/PI parity regression"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/todos-extension.spec.ts",
      "scope": "project",
      "timeout_seconds": 900,
      "note": "validate create-required assigned flag across todos fixtures"
    },
    {
      "command": "pnpm build",
      "scope": "project",
      "timeout_seconds": 120,
      "note": "TypeScript build verification"
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
      "note": "authoritative behavior contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "user-facing command contract"
    }
  ]
}

Implement primary mutation and ownership commands.

Added shared mutation helper and integrated command handlers for list get update append comments files docs test claim release.
