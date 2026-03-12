{
  "id": "pm-axl0",
  "title": "Fix Beads Import Lossiness",
  "description": "Make beads import preserve Beads dependency kinds and source metadata, owner fallback, due dates, and structured import fields without touching live tracker data during validation.",
  "type": "Task",
  "status": "closed",
  "priority": 0,
  "tags": [
    "beads",
    "import",
    "pm-cli"
  ],
  "created_at": "2026-03-12T21:42:11.716Z",
  "updated_at": "2026-03-12T22:08:19.528Z",
  "deadline": "2026-03-13T21:42:11.716Z",
  "author": "codex-maintainer",
  "estimated_minutes": 180,
  "acceptance_criteria": "Beads import preserves owner fallback, due_at, dependency kind/source metadata, and structured design/closed_at fields; regression tests cover the mapping; isolated temp-folder validation against the real Beads dataset runs without writing to this repo tracker.",
  "definition_of_ready": "Bug report analyzed and safe validation plan defined.",
  "goal": "Migration safety",
  "objective": "Lossless Beads import",
  "value": "Prevents migration data loss",
  "impact": "Allows safe pm adoption for Beads workspaces",
  "outcome": "Beads imports retain critical source semantics",
  "why_now": "A real migration is blocked on current importer behavior",
  "risk": "high",
  "confidence": "medium",
  "sprint": "maintainer-loop",
  "customer_impact": "Migration data would be lost without this fix",
  "comments": [
    {
      "created_at": "2026-03-12T21:42:11.716Z",
      "author": "codex-maintainer",
      "text": "Track the reported Beads import lossiness and validate only in isolated temp workspaces."
    },
    {
      "created_at": "2026-03-12T22:08:13.057Z",
      "author": "codex-maintainer",
      "text": "Implemented lossless Beads import fixes: dependency kind now reads type then kind, Beads-specific kinds are preserved (with source_kind when needed), assignee falls back to owner, due_at maps to deadline, closed_at/design/source_type/source_owner/external_ref are stored structurally, timestamps keep source offsets, stdin and safer auto-discovery are supported, and --preserve-source-ids keeps source ids intact. Evidence: PM_AUTHOR=codex-maintainer pm test pm-axl0 --run --json passed both linked regressions; PM_AUTHOR=codex-maintainer node scripts/run-tests.mjs coverage passed with 54 files / 551 tests / 100% statements, branches, functions, and lines. Isolated real-data validation used a temp tracker with explicit PM_PATH and PM_GLOBAL_PATH plus copied Beads data from a local issues.jsonl export; import succeeded with 2282 imported, 0 skipped, autodiscovered source=issues.jsonl, dependency/source-type/closed_at/design counts preserved, and no existing tracker data was overwritten."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-12T21:42:11.716Z",
      "author": "codex-maintainer",
      "text": "Start with importer mapping gaps then validate against real external Beads data under sandboxed PM_PATH and PM_GLOBAL_PATH."
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "Document beads import behavior contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "Document beads import auto-discovery and source-id preservation"
    },
    {
      "path": "src/cli/commands/beads.ts",
      "scope": "project",
      "note": "Beads import compatibility mapping and auto-discovery"
    },
    {
      "path": "src/cli/commands/list.ts",
      "scope": "project",
      "note": "Timestamp-aware list sorting for preserved offsets"
    },
    {
      "path": "src/cli/commands/search.ts",
      "scope": "project",
      "note": "Timestamp-aware search sorting for preserved offsets"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "Beads import CLI flags"
    },
    {
      "path": "src/core/item/id.ts",
      "scope": "project",
      "note": "Allow raw preserved source ids to remain addressable"
    },
    {
      "path": "src/core/item/item-format.ts",
      "scope": "project",
      "note": "Structured field preservation and timestamp-safe sorting"
    },
    {
      "path": "src/core/shared/constants.ts",
      "scope": "project",
      "note": "Expanded dependency kind compatibility constants"
    },
    {
      "path": "src/core/shared/time.ts",
      "scope": "project",
      "note": "Timestamp comparison helpers for offset-preserving imports"
    },
    {
      "path": "src/core/store/item-store.ts",
      "scope": "project",
      "note": "Fallback item lookup for preserved source ids"
    },
    {
      "path": "src/extensions/builtins/beads/index.ts",
      "scope": "project",
      "note": "Extension option coercion for preserve-source-ids"
    },
    {
      "path": "src/types.ts",
      "scope": "project",
      "note": "Beads compatibility metadata fields and dependency kinds"
    },
    {
      "path": "tests/fixtures/beads/import-records.jsonl",
      "scope": "project",
      "note": "Fixture coverage for lossless Beads mappings"
    },
    {
      "path": "tests/unit/beads-command.spec.ts",
      "scope": "project",
      "note": "Regression coverage for owner due_at design closed_at dependency kinds and source ids"
    },
    {
      "path": "tests/unit/builtin-extension-entrypoints.spec.ts",
      "scope": "project",
      "note": "Extension option coverage"
    },
    {
      "path": "tests/unit/item-format-validation.spec.ts",
      "scope": "project",
      "note": "Structured metadata and dependency source_kind coverage"
    },
    {
      "path": "tests/unit/item-store.spec.ts",
      "scope": "project",
      "note": "Store coverage for imported metadata persistence"
    },
    {
      "path": "tests/unit/shared-constants-errors.spec.ts",
      "scope": "project",
      "note": "Dependency kind validation coverage"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs test -- tests/integration/cli.integration.spec.ts -t \"imports Beads JSONL records through the beads import CLI command\"",
      "scope": "project",
      "timeout_seconds": 900,
      "note": "CLI-level beads import integration regression"
    },
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/beads-command.spec.ts tests/unit/builtin-extension-entrypoints.spec.ts tests/unit/list-command.spec.ts tests/unit/search-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 900,
      "note": "Focused unit regression set for beads import and timestamp comparisons"
    }
  ],
  "docs": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "Beads import contract updates"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "User-facing beads import behavior and safety notes"
    }
  ],
  "close_reason": "Beads import lossiness fixed and validated in isolated temp trackers with linked tests and full coverage passing"
}

Address the reported migration blockers in beads import and validate with a temp workspace plus real Beads export data from a local Beads workspace.
