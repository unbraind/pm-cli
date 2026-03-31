{
  "id": "pm-6e0p",
  "title": "Add tests and completion coverage for include-body list flag",
  "description": "Extend unit integration and shell completion tests for include-body across all list variants.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:completion",
    "area:tests",
    "body",
    "json",
    "list",
    "pm-cli"
  ],
  "created_at": "2026-03-31T19:37:26.991Z",
  "updated_at": "2026-03-31T19:45:35.061Z",
  "deadline": "2026-04-02T19:37:26.991Z",
  "author": "codex-agent",
  "estimated_minutes": 90,
  "acceptance_criteria": "Unit and integration tests verify include-body behavior and completion output includes include-body for list commands.",
  "definition_of_ready": "Implementation task is tracked and test files identified.",
  "order": 2,
  "goal": "JSON contract clarity",
  "objective": "Protect include-body behavior with regression coverage",
  "value": "Prevents regressions and keeps CLI UX discoverable",
  "impact": "Ensures stable behavior across list commands and shells",
  "outcome": "Automated tests validate include-body end-to-end",
  "why_now": "Behavior changes require contract coverage before release.",
  "parent": "pm-ykib",
  "risk": "medium",
  "confidence": "high",
  "sprint": "maintainer-loop-2026-03-31",
  "release": "v0.1",
  "component": "tests/list",
  "regression": true,
  "customer_impact": "Users and automation keep predictable list behavior.",
  "dependencies": [
    {
      "id": "pm-gus1",
      "kind": "related",
      "created_at": "2026-03-31T19:37:26.991Z",
      "author": "codex-agent"
    },
    {
      "id": "pm-ykib",
      "kind": "parent",
      "created_at": "2026-03-31T19:37:26.991Z",
      "author": "codex-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-31T19:37:26.991Z",
      "author": "codex-agent",
      "text": "Task B covers list tests plus shell completion updates"
    },
    {
      "created_at": "2026-03-31T19:45:16.269Z",
      "author": "codex-agent",
      "text": "Added include-body coverage in list unit/integration tests and shell completion generation for bash, zsh, and fish list flags."
    },
    {
      "created_at": "2026-03-31T19:45:25.031Z",
      "author": "codex-agent",
      "text": "Evidence: pm test pm-6e0p --run passed (passed=1 failed=0 skipped=0). Targeted suites passed (tests/unit/list-command.spec.ts, list-sort-branches, completion-command, and integration list lifecycle case)."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-31T19:37:26.991Z",
      "author": "codex-agent",
      "text": "Validate both default and include-body paths to preserve backward compatibility"
    }
  ],
  "files": [
    {
      "path": "src/cli/commands/completion.ts",
      "scope": "project",
      "note": "completion flag support"
    },
    {
      "path": "tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "note": "integration include-body behavior"
    },
    {
      "path": "tests/unit/completion-command.spec.ts",
      "scope": "project",
      "note": "completion flag tests"
    },
    {
      "path": "tests/unit/list-command.spec.ts",
      "scope": "project",
      "note": "unit include-body assertions"
    },
    {
      "path": "tests/unit/list-sort-branches.spec.ts",
      "scope": "project",
      "note": "mock support for list body loader"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/list-command.spec.ts tests/unit/completion-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "targeted behavior tests"
    }
  ],
  "docs": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "behavior contract"
    }
  ],
  "close_reason": "Added completion and regression coverage for include-body across list variants with passing targeted and full tests."
}

Cover default no-body behavior and include-body behavior in list unit and integration suites plus completion script generation.
