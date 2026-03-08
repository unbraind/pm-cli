{
  "id": "pm-57lj",
  "title": "Guard todos import hierarchical ID preservation",
  "description": "Add explicit docs and regression coverage for preserving hierarchical imported IDs during todos markdown import.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:docs",
    "area:extensions",
    "area:tests",
    "code",
    "docs",
    "milestone:5",
    "pm-cli",
    "priority:1",
    "release-readiness",
    "tests"
  ],
  "created_at": "2026-03-08T15:28:23.866Z",
  "updated_at": "2026-03-08T15:57:38.460Z",
  "deadline": "2026-03-09T15:35:00.000Z",
  "author": "maintainer-agent",
  "estimated_minutes": 75,
  "acceptance_criteria": "todos import preserves hierarchical IDs such as pm-foo.1.2 verbatim; docs mention the behavior explicitly; targeted and full regression sweeps pass with 100% coverage preserved.",
  "definition_of_ready": "Gap confirmed: todos import behavior exists in code but lacks explicit docs and test guard for hierarchical imported IDs.",
  "order": 1,
  "goal": "Release-hardening",
  "objective": "Close import-contract gap for hierarchical todo IDs",
  "value": "Prevents regressions in imported tracker identity fidelity",
  "impact": "Reduces silent importer drift for users migrating nested and hierarchical work items",
  "outcome": "todos import contract is explicit and regression-tested",
  "why_now": "No open items remain and Milestone 5 built-in extensions still need incremental hardening",
  "parent": "pm-b1w",
  "risk": "low",
  "confidence": "high",
  "sprint": "maintainer-loop-2026-03-08",
  "release": "v0.1",
  "dependencies": [
    {
      "id": "pm-b1w",
      "kind": "parent",
      "created_at": "2026-03-08T15:28:23.866Z",
      "author": "maintainer-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-08T15:28:23.866Z",
      "author": "maintainer-agent",
      "text": "Why this exists because todos import should keep hierarchical IDs stable and that contract needs an explicit release hardening guard"
    },
    {
      "created_at": "2026-03-08T15:28:33.138Z",
      "author": "maintainer-agent",
      "text": "Planned changeset: clarify PRD and README that todos import preserves hierarchical imported IDs, then add focused unit and CLI integration assertions for ids like pm-legacy.1.2 before running mandatory pm verification sweeps."
    },
    {
      "created_at": "2026-03-08T15:30:56.390Z",
      "author": "maintainer-agent",
      "text": "Implementation update: clarified PRD and README todos import contract for explicit hierarchical imported IDs and added unit, CLI integration, and release-readiness regression guards for ids like pm-legacy.1.2."
    },
    {
      "created_at": "2026-03-08T15:57:38.092Z",
      "author": "maintainer-agent",
      "text": "Evidence: pm test pm-57lj --run --timeout 2400 passed both linked commands. The linked coverage run kept statements, branches, functions, and lines at 100 percent. pm test-all --status in_progress --timeout 2400 passed with items=1 linked_tests=2 passed=2 failed=0 skipped=0. pm test-all --status closed --timeout 2400 passed on rerun with items=152 linked_tests=387 passed=70 failed=0 skipped=317 after one transient pm-06t coverage failure that cleared under direct rerun and clean closed-sweep rerun."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-08T15:28:23.866Z",
      "author": "maintainer-agent",
      "text": "Plan update docs first then add targeted unit and integration assertions then run pm verification sweeps"
    }
  ],
  "files": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative import contract clarification"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public import contract clarification"
    },
    {
      "path": "tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "note": "CLI-level hierarchical import guard"
    },
    {
      "path": "tests/unit/todos-extension.spec.ts",
      "scope": "project",
      "note": "hierarchical ID regression guard"
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
      "command": "node scripts/run-tests.mjs test -- tests/unit/todos-extension.spec.ts tests/integration/cli.integration.spec.ts tests/integration/release-readiness-contract.spec.ts",
      "scope": "project",
      "timeout_seconds": 2400,
      "note": "targeted todos import contract regression"
    }
  ],
  "docs": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "dogfood workflow contract"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative import behavior contract"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "public import behavior contract"
    }
  ],
  "close_reason": "Todos import hierarchical ID contract clarified and regression-tested with full passing verification sweeps."
}

Context: PRD requires imported hierarchical IDs to be preserved verbatim. Beads import is covered but todos import lacks an explicit release-hardening contract guard. Approach: clarify docs, add focused unit and integration assertions for hierarchical todo IDs, and rerun pm verification sweeps.
