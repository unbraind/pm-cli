{
  "id": "pm-rs40",
  "title": "Add issue-specific metadata fields to item schema and CLI",
  "description": "Docs-first add issue lifecycle metadata (reporter severity environment repro expected actual component version resolution impact) to create/update schema and serialization contracts.",
  "type": "Task",
  "status": "closed",
  "priority": 0,
  "tags": [
    "area:cli",
    "area:docs",
    "area:schema",
    "code",
    "milestone:8",
    "pm-cli",
    "priority:0",
    "tests"
  ],
  "created_at": "2026-03-08T10:34:28.069Z",
  "updated_at": "2026-03-08T10:58:56.850Z",
  "deadline": "2026-03-09T10:34:28.069Z",
  "author": "maintainer-agent",
  "estimated_minutes": 120,
  "acceptance_criteria": "Create and update accept issue-specific metadata flags with deterministic none-unset semantics and canonical storage; docs and tests updated with 100% coverage preserved.",
  "definition_of_ready": "PRD README AGENTS contracts updated and target files/tests linked.",
  "order": 1,
  "goal": "Release-hardening",
  "objective": "Close issue-management metadata parity gap",
  "value": "Richer issue tracking data for production workflows",
  "impact": "Improves incident triage and audit readiness",
  "outcome": "Issue records capture reproducibility and impact context",
  "why_now": "Current all-fields maintainer workflow requires these metadata fields",
  "risk": "medium",
  "confidence": "high",
  "sprint": "maintainer-loop-2026-03-08",
  "release": "v0.1",
  "comments": [
    {
      "created_at": "2026-03-08T10:34:28.069Z",
      "author": "maintainer-agent",
      "text": "Why this exists: issue workflows need richer metadata than the current shared schema supports."
    },
    {
      "created_at": "2026-03-08T10:34:45.942Z",
      "author": "maintainer-agent",
      "text": "Planned changeset before edits: update PRD README and AGENTS to add issue-specific metadata contract (reporter severity environment repro expected actual versions component regression customer impact resolution), then implement create/update flag wiring, schema/key-order normalization, and focused+full regression tests."
    },
    {
      "created_at": "2026-03-08T10:37:02.803Z",
      "author": "maintainer-agent",
      "text": "Docs-first phase complete: PRD README and AGENTS now treat issue-specific metadata fields as canonical create/update contract fields with explicit none-unset semantics and severity med normalization."
    },
    {
      "created_at": "2026-03-08T10:58:56.521Z",
      "author": "maintainer-agent",
      "text": "Implementation complete: docs-first contract update plus CLI/schema/test changes for issue metadata flags (reporter,severity,environment,repro_steps,resolution,expected_result,actual_result,affected_version,fixed_version,component,regression,customer_impact) with create/update alias support and none-unset semantics. Evidence: pm test pm-rs40 --run --timeout 7200 --json passed all 3 linked tests including node scripts/run-tests.mjs coverage with 100% lines/branches/functions/statements; pm test-all --status in_progress --timeout 7200 --json passed (items=1 linked_tests=3 passed=3 failed=0 skipped=0); pm test-all --status closed --timeout 7200 --json passed (items=145 linked_tests=371 passed=66 failed=0 skipped=305)."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-08T10:34:28.069Z",
      "author": "maintainer-agent",
      "text": "Plan docs-first update then add schema fields create/update parsing and comprehensive tests."
    }
  ],
  "files": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "all-flags template includes issue metadata options"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "docs-first issue metadata schema+flag contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "create/update issue metadata contract"
    },
    {
      "path": "src/cli/commands/create.ts",
      "scope": "project",
      "note": "parse issue metadata flags"
    },
    {
      "path": "src/cli/commands/update.ts",
      "scope": "project",
      "note": "update issue metadata flags"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "create/update option wiring"
    },
    {
      "path": "src/core/item/item-format.ts",
      "scope": "project",
      "note": "issue metadata normalization and validation"
    },
    {
      "path": "src/core/shared/constants.ts",
      "scope": "project",
      "note": "front matter key order update"
    },
    {
      "path": "src/types.ts",
      "scope": "project",
      "note": "item schema extension"
    },
    {
      "path": "tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "note": "docs/help contract assertions"
    },
    {
      "path": "tests/unit/create-command.spec.ts",
      "scope": "project",
      "note": "create issue metadata tests"
    },
    {
      "path": "tests/unit/update-command.spec.ts",
      "scope": "project",
      "note": "update issue metadata tests"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 7200,
      "note": "sandbox-safe 100% coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test",
      "scope": "project",
      "timeout_seconds": 3600,
      "note": "sandbox-safe full regression"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/create-command.spec.ts tests/unit/update-command.spec.ts tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "targeted issue metadata regressions"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "maintainer all-fields workflow contract"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public contract for create/update flags"
    }
  ],
  "close_reason": "Issue metadata parity implemented with docs+CLI+schema+tests and verification sweeps passing at 100% coverage."
}

Implement issue-specific metadata fields with deterministic parsing, normalization, serialization, and docs/help parity.
