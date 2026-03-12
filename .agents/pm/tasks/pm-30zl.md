{
  "id": "pm-30zl",
  "title": "Generalize CLI help text for universal positioning",
  "description": "Update pm help descriptions so the CLI is presented as a general, universal, flexible, extensible, agent-optimized project management tool suitable for any project and programming language, without exposing private or internal-only wording.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "agents",
    "cli",
    "docs",
    "help",
    "pm-cli"
  ],
  "created_at": "2026-03-12T22:38:16.043Z",
  "updated_at": "2026-03-12T22:49:46.907Z",
  "deadline": "2026-03-13T22:38:16.043Z",
  "author": "codex-maintainer",
  "estimated_minutes": 60,
  "acceptance_criteria": "1) Top-level and command help descriptions describe pm as general, flexible, extensible, and agent-optimized for any project/language. 2) Help contract tests are updated and passing. 3) Diff is reviewed for private-data leakage before push.",
  "definition_of_ready": "Help text sources and affected help-contract tests are identified.",
  "goal": "Public CLI positioning",
  "objective": "Make help output universal and project-agnostic",
  "value": "Clearer public-facing product positioning for humans and agents",
  "impact": "Reduces overly narrow wording in command help output",
  "outcome": "Help text consistently presents pm as a universal extensible CLI",
  "why_now": "The help surface is user-visible and should match the intended public positioning before release.",
  "risk": "low",
  "confidence": "high",
  "component": "cli-help",
  "customer_impact": "Public help text should accurately describe the CLI without leaking internal/private context.",
  "comments": [
    {
      "created_at": "2026-03-12T22:38:16.043Z",
      "author": "codex-maintainer",
      "text": "Track public help-text wording refresh and leak review for the CLI surface."
    },
    {
      "created_at": "2026-03-12T22:45:08.082Z",
      "author": "codex-maintainer",
      "text": "Updated top-level CLI help, command descriptions, shell completion descriptions, and help-contract tests to use broader public-facing wording suitable for any project or language. Verification and leak review pending."
    },
    {
      "created_at": "2026-03-12T22:49:46.882Z",
      "author": "codex-maintainer",
      "text": "Evidence: pm test pm-30zl --run passed the scoped help/completion regression command (8 tests passed). node scripts/check-secrets.mjs reported no credential-like secrets in tracked files. A full node scripts/run-tests.mjs coverage sweep still fails on pre-existing README/contract drift outside this change."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-12T22:38:16.043Z",
      "author": "codex-maintainer",
      "text": "Primary edits expected in src/cli/main.ts with help-contract regression coverage updates."
    }
  ],
  "files": [
    {
      "path": "src/cli/commands/completion.ts",
      "scope": "project",
      "note": "shell completion help descriptions"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "primary help text source"
    },
    {
      "path": "tests/integration/help-readme-contract.spec.ts",
      "scope": "project",
      "note": "top-level help description contract"
    },
    {
      "path": "tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "note": "mutation help wording contract"
    },
    {
      "path": "tests/unit/completion-command.spec.ts",
      "scope": "project",
      "note": "completion description contract"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/completion-command.spec.ts tests/integration/help-readme-contract.spec.ts tests/integration/release-readiness-contract.spec.ts --testNamePattern='includes all pm subcommand descriptions|includes all pm subcommands with descriptions|describes top-level help as a universal extensible CLI|describes reindex help text as keyword plus semantic/hybrid capable|keeps close mutation metadata contract aligned across PRD and CLI help|keeps delete mutation metadata contract aligned across PRD and CLI help|keeps append mutation metadata contract aligned across PRD and CLI help|keeps restore mutation metadata contract aligned across PRD and CLI help'",
      "scope": "project",
      "timeout_seconds": 900,
      "note": "targeted help and completion regression"
    }
  ],
  "docs": [
    {
      "path": "README.md",
      "scope": "project",
      "note": "public product/help positioning reference"
    }
  ],
  "close_reason": "Universal help/completion wording updated; scoped regressions passed; secret scan clean; full coverage currently fails on unrelated pre-existing README contract drift."
}

Refresh command help copy to better reflect pm's universal positioning while keeping wording public-safe and consistent across command surfaces.
