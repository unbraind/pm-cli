{
  "id": "pm-cxn3",
  "title": "Respect --path for pm install --project destination",
  "description": "Align install command with global --path semantics so project scope installs Pi extension relative to resolved PM root instead of CWD.",
  "type": "Task",
  "status": "closed",
  "priority": 0,
  "tags": [
    "area:install",
    "code",
    "docs",
    "milestone:6",
    "pm-cli",
    "priority:0",
    "release-readiness",
    "tests"
  ],
  "created_at": "2026-03-08T22:50:29.347Z",
  "updated_at": "2026-03-08T23:14:49.023Z",
  "deadline": "2026-03-09T22:50:29.347Z",
  "author": "maintainer-agent",
  "estimated_minutes": 90,
  "acceptance_criteria": "pm install pi --project writes to <project-root>/.pi/extensions/pm-cli/index.ts where project-root derives from resolved PM root when --path or PM_PATH is set; docs and tests updated; regression suite remains green with 100% coverage.",
  "definition_of_ready": "Reproduction captured for current behavior and target behavior documented in PRD/README.",
  "order": 1,
  "goal": "Release-hardening",
  "objective": "Close install command global-flag parity gap",
  "value": "Makes maintainer automation reliable from any working directory",
  "impact": "Prevents extension installation into unintended projects",
  "outcome": "Install destination is deterministic with --path overrides",
  "why_now": "Recent install rollout needs parity with documented global-flag contract before release",
  "parent": "pm-8a2s",
  "risk": "medium",
  "confidence": "high",
  "sprint": "maintainer-loop",
  "release": "v0.1",
  "repro_steps": "From temp cwd run pm --path <other-project>/.agents/pm install pi --project --json and observe destination currently points to cwd/.pi.",
  "expected_result": "Project-scope install destination follows resolved PM root project.",
  "actual_result": "Current destination follows cwd regardless of --path.",
  "affected_version": "0.1.0",
  "component": "cli/install",
  "regression": true,
  "customer_impact": "Automation scripts may install integration files into wrong repository when using --path.",
  "dependencies": [
    {
      "id": "pm-8a2s",
      "kind": "related",
      "created_at": "2026-03-08T22:50:29.347Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-08T22:50:29.347Z",
      "author": "maintainer-agent",
      "text": "Why this exists install command should honor global --path semantics for deterministic project-targeted integration installs."
    },
    {
      "created_at": "2026-03-08T22:50:39.256Z",
      "author": "maintainer-agent",
      "text": "Planned changeset before edits: update PRD and README install contract to state project scope follows resolved PM root then implement install destination derivation from --path or PM_PATH and add unit plus contract tests."
    },
    {
      "created_at": "2026-03-08T22:51:18.727Z",
      "author": "maintainer-agent",
      "text": "Docs-first update complete: PRD and README now state that pm install pi --project writes under project root derived from resolved PM root via --path or PM_PATH."
    },
    {
      "created_at": "2026-03-08T22:52:24.737Z",
      "author": "maintainer-agent",
      "text": "Implemented code updates: runInstall now derives project destination from resolved PM root using --path or PM_PATH and install help text documents the same semantics; added unit and release-contract coverage for this behavior."
    },
    {
      "created_at": "2026-03-08T22:55:49.416Z",
      "author": "maintainer-agent",
      "text": "Adjusted implementation semantics after regression feedback: project installs now honor explicit --path only and continue using current working directory when --path is absent; added CLI integration coverage for --path override behavior."
    },
    {
      "created_at": "2026-03-08T23:14:40.851Z",
      "author": "maintainer-agent",
      "text": "Evidence: pm test pm-cxn3 --run --timeout 7200 --json passed both linked commands; coverage command reported All files 100/100/100/100. Regression sweeps passed: pm test-all --status in_progress --timeout 7200 --json totals items=1 linked_tests=2 passed=2 failed=0 skipped=0; pm test-all --status closed --timeout 7200 --json totals items=167 linked_tests=407 passed=74 failed=0 skipped=333."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-08T22:50:29.347Z",
      "author": "maintainer-agent",
      "text": "Plan docs-first update PRD and README then implement project-root derivation and add unit integration tests and run pm test plus test-all."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "install contract update for --path semantics"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public command contract update for install destination semantics"
    },
    {
      "path": "src/cli/commands/install.ts",
      "scope": "project",
      "note": "install destination resolution logic"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "install command help text update for path-derived project root"
    },
    {
      "path": "tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "note": "integration coverage for install --path project destination"
    },
    {
      "path": "tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "note": "contract coverage for install semantics"
    },
    {
      "path": "tests/unit/install-command.spec.ts",
      "scope": "project",
      "note": "unit coverage for path-aware project scope installs"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 7200,
      "note": "coverage gate verification"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/install-command.spec.ts tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "timeout_seconds": 7200,
      "note": "sandbox-safe targeted regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "governing maintainer workflow"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative install command contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "user-facing install semantics"
    }
  ],
  "close_reason": "Install project scope now honors explicit --path with cwd default preserved; docs and tests are aligned and regression plus 100% coverage evidence is recorded."
}

Docs-first: clarify install destination semantics. Then implement runInstall project-root resolution from global --path/PM_PATH and add unit+integration coverage.
