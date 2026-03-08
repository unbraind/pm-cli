{
  "id": "pm-jdt8",
  "title": "Add definition-of-done config baseline",
  "description": "Docs-first add a config command baseline for team Definition of Done settings so maintainer workflows can persist release-quality criteria deterministically.",
  "type": "Task",
  "status": "closed",
  "priority": 0,
  "tags": [
    "area:config",
    "area:workflow",
    "code",
    "docs",
    "milestone:7",
    "pm-cli",
    "priority:0",
    "release-readiness",
    "tests"
  ],
  "created_at": "2026-03-08T14:33:25.586Z",
  "updated_at": "2026-03-08T15:05:51.939Z",
  "deadline": "2026-03-09T14:33:25.586Z",
  "author": "maintainer-agent",
  "estimated_minutes": 150,
  "acceptance_criteria": "pm config supports project/global Definition of Done criteria persistence with deterministic TOON/JSON output; PRD README and AGENTS document the baseline; unit/integration coverage keeps the repository at 100 percent.",
  "definition_of_ready": "Gap confirmed: maintainer workflow requires Definition of Done configuration but the CLI currently exposes no config command or settings slot.",
  "order": 1,
  "goal": "Release-hardening",
  "objective": "Close maintainer workflow gap for team Definition of Done configuration",
  "value": "Enables deterministic team-level quality policy storage in pm itself",
  "impact": "Reduces release-readiness drift between maintainer instructions and CLI behavior",
  "outcome": "Maintainers can persist and inspect Definition of Done criteria through the CLI",
  "why_now": "Current maintainer protocol references pm config for Definition of Done but implementation has no command support yet",
  "risk": "medium",
  "confidence": "high",
  "sprint": "maintainer-loop-2026-03-08",
  "release": "v0.1",
  "dependencies": [
    {
      "id": "pm-ote",
      "kind": "related",
      "created_at": "2026-03-08T14:33:25.586Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-08T14:33:25.586Z",
      "author": "maintainer-agent",
      "text": "Why this exists because the maintainer workflow expects Definition of Done configuration but pm currently has no config command or workflow settings storage."
    },
    {
      "created_at": "2026-03-08T14:33:33.555Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: update PRD README and AGENTS first to document a minimal pm config baseline for Definition of Done criteria, then implement settings persistence plus config command wiring and targeted release-readiness tests."
    },
    {
      "created_at": "2026-03-08T14:39:19.710Z",
      "author": "maintainer-agent",
      "text": "Docs-first implementation is in place: added workflow.definition_of_done settings storage, a new config command baseline for project/global get and set flows, CLI integration coverage, and Pi wrapper action parity for the new command surface."
    },
    {
      "created_at": "2026-03-08T15:05:51.939Z",
      "author": "maintainer-agent",
      "text": "Evidence: pm test pm-jdt8 --run passed all 3 linked tests; pm test-all --status in_progress rerun passed 3 of 3 linked tests after one transient todos-import false negative on the first sweep; pm test-all --status closed passed 68 linked tests with 316 deterministic duplicate or path skips across 151 closed items; node scripts/run-tests.mjs coverage remained at 100 percent statements, branches, functions, and lines."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-08T14:33:25.586Z",
      "author": "maintainer-agent",
      "text": "Plan update docs first then add settings storage and config command wiring then run focused and full regression checks."
    }
  ],
  "files": [
    {
      "path": ".pi/extensions/pm-cli/index.ts",
      "scope": "project",
      "note": "Pi wrapper config action parity"
    },
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "maintainer workflow contract"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative config contract update"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public config command documentation"
    },
    {
      "path": "src/cli/commands/config.ts",
      "scope": "project",
      "note": "config command implementation"
    },
    {
      "path": "src/cli/commands/index.ts",
      "scope": "project",
      "note": "export config command"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "config command wiring"
    },
    {
      "path": "src/core/shared/constants.ts",
      "scope": "project",
      "note": "settings defaults include workflow definition-of-done"
    },
    {
      "path": "src/core/store/settings.ts",
      "scope": "project",
      "note": "settings schema persistence update"
    },
    {
      "path": "src/types.ts",
      "scope": "project",
      "note": "settings schema includes workflow definition-of-done"
    },
    {
      "path": "tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "note": "config CLI integration coverage"
    },
    {
      "path": "tests/unit/config-command.spec.ts",
      "scope": "project",
      "note": "unit coverage for config command"
    },
    {
      "path": "tests/unit/pi-agent-extension.spec.ts",
      "scope": "project",
      "note": "Pi wrapper config action coverage"
    },
    {
      "path": "tests/unit/settings-store.spec.ts",
      "scope": "project",
      "note": "settings workflow compatibility coverage"
    },
    {
      "path": "vitest.config.ts",
      "scope": "project",
      "note": "coverage include for config command"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 2400,
      "note": "sandbox-safe coverage gate"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/config-command.spec.ts tests/unit/settings-store.spec.ts tests/unit/pi-agent-extension.spec.ts tests/integration/cli.integration.spec.ts tests/integration/help-readme-contract.spec.ts tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "timeout_seconds": 2400,
      "note": "targeted config baseline regressions"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/settings-store.spec.ts tests/integration/help-readme-contract.spec.ts tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "timeout_seconds": 2400,
      "note": "targeted config contract regressions"
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
      "note": "governing spec"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public command contract"
    }
  ],
  "close_reason": "Definition-of-Done config baseline implemented with docs, CLI, settings persistence, Pi wrapper parity, and verified 100 percent coverage."
}

Implement the narrowest release-safe baseline for Definition of Done settings: document the command contract, add settings storage for workflow.definition_of_done, wire a config command surface for set/list flows, and keep the repository release-ready with sandbox-safe regression evidence.
