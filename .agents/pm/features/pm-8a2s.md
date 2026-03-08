{
  "id": "pm-8a2s",
  "title": "Add pm install pi command and verify temp-folder Pi integration",
  "description": "Implement a dedicated installer command to place the pm Pi extension in project or global Pi extension directories and validate with a real temporary Pi run.",
  "type": "Feature",
  "status": "closed",
  "priority": 0,
  "tags": [
    "area:extensions-pi",
    "area:install",
    "code",
    "docs",
    "milestone:6",
    "pm-cli",
    "priority:0",
    "release-readiness",
    "tests"
  ],
  "created_at": "2026-03-08T19:47:48.867Z",
  "updated_at": "2026-03-08T20:20:53.762Z",
  "deadline": "2026-03-10T20:00:00.000Z",
  "author": "maintainer-agent",
  "estimated_minutes": 180,
  "acceptance_criteria": "pm install pi supports --project and --global (default project), copies .pi/extensions/pm-cli/index.ts to the correct Pi extension path with deterministic JSON/TOON output, docs reflect usage, pm test and test-all sweeps pass, and a manual temp-folder pi run loads the installed extension successfully.",
  "definition_of_ready": "Gap confirmed: pm CLI currently lacks install command for Pi extension placement despite docs/users requiring one-step setup.",
  "order": 1,
  "goal": "Release-hardening",
  "objective": "Make Pi extension installation first-class and deterministic",
  "value": "Reduces setup friction and prevents incorrect manual copy paths",
  "impact": "Improves adoption and reliability of pm integration in Pi TUI",
  "outcome": "Users can install and use pm Pi extension via pm command",
  "why_now": "User workflow requires direct pm-driven extension installation with immediate usability in Pi TUI",
  "risk": "medium",
  "confidence": "high",
  "sprint": "maintainer-loop-2026-03-08",
  "release": "v0.1",
  "environment": "linux",
  "repro_steps": "run pm --help and observe no install command",
  "expected_result": "pm install pi installs extension into selected Pi scope",
  "affected_version": "0.1.0",
  "component": "cli-installer",
  "regression": false,
  "customer_impact": "Pi users can load pm tracking tools in TUI without manual file-copy steps",
  "dependencies": [
    {
      "id": "pm-oqe0",
      "kind": "related",
      "created_at": "2026-03-08T19:47:48.867Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-08T19:47:48.867Z",
      "author": "maintainer-agent",
      "text": "Why this exists users need one-command Pi extension install for project/global scopes and reliable TUI availability."
    },
    {
      "created_at": "2026-03-08T19:48:00.841Z",
      "author": "maintainer-agent",
      "text": "Planned changeset before edits: update PRD/README/AGENTS with install command contract and Pi scope semantics, implement runInstallPi command + CLI wiring, add unit/integration/release-contract tests, then run temporary-folder Pi smoke validation."
    },
    {
      "created_at": "2026-03-08T19:54:30.312Z",
      "author": "maintainer-agent",
      "text": "Implemented docs-first command contract plus code: added runInstall command for pi scope install, wired CLI command pm install <target> with --project/--global semantics, and expanded completion/help docs contracts and tests."
    },
    {
      "created_at": "2026-03-08T20:18:49.520Z",
      "author": "maintainer-agent",
      "text": "Evidence: validated Pi docs/examples and ran real temp-folder smoke tests (pm install pi --project --json, PI_CODING_AGENT_DIR=<tmp> pm install pi --global --json, PI_CODING_AGENT_DIR=<tmp> pi install ./.pi/extensions/pm-cli/index.ts, PI_CODING_AGENT_DIR=<tmp> pi --no-session --print -e ./.pi/extensions/pm-cli/index.ts \"Use the pm tool to run action stats...\"). Verification runs passed: pm test pm-8a2s --run --timeout 7200 --json, pm test-all --status in_progress --timeout 7200 --json, pm test-all --status closed --timeout 7200 --json with totals items=159 linked_tests=398 passed=73 failed=0 skipped=325. Coverage gate remains 100% lines/branches/functions/statements."
    },
    {
      "created_at": "2026-03-08T20:20:53.762Z",
      "author": "maintainer-agent",
      "text": "Post-fix smoke rerun in isolated temp environments passed for both scopes: project-only (PI_CODING_AGENT_DIR=<tmp> pi --no-session --print -e ./.pi/extensions/pm-cli/index.ts \"Use the pm tool to run action stats in this folder.\") and global-only (PI_CODING_AGENT_DIR=<tmp> pm install pi --global --json then PI_CODING_AGENT_DIR=<tmp> pi --no-session --print \"Use the pm tool to run action stats in this folder.\"). Both returned pm stats output successfully."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-08T19:47:48.867Z",
      "author": "maintainer-agent",
      "text": "Plan update PRD README AGENTS first then implement command and tests plus temp-folder Pi smoke validation."
    }
  ],
  "files": [
    {
      "path": "src/cli/commands/completion.ts",
      "scope": "project",
      "note": "install command completion coverage"
    },
    {
      "path": "src/cli/commands/index.ts",
      "scope": "project",
      "note": "export install command"
    },
    {
      "path": "src/cli/commands/install.ts",
      "scope": "project",
      "note": "new install command implementation"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "wire new install command"
    },
    {
      "path": "tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "note": "command integration coverage"
    },
    {
      "path": "tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "note": "docs/help contract"
    },
    {
      "path": "tests/unit/completion-command.spec.ts",
      "scope": "project",
      "note": "completion install command assertions"
    },
    {
      "path": "tests/unit/install-command.spec.ts",
      "scope": "project",
      "note": "installer behavior coverage"
    },
    {
      "path": "vitest.config.ts",
      "scope": "project",
      "note": "coverage include alignment"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 2400,
      "note": "coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/install-command.spec.ts tests/integration/cli.integration.spec.ts tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "timeout_seconds": 2400,
      "note": "targeted installer regressions"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "maintainer Pi workflow"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "command contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public install contract"
    }
  ],
  "close_reason": "Implemented pm install pi command with project/global scopes, validated Pi integration in temp workspace, and passed all required pm test sweeps with 100% coverage."
}

Docs-first: define command contract and usage; implement installer command with deterministic destination paths and safe overwrite behavior; add unit/integration tests and run Pi smoke check in temp workspace.
