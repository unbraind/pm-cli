{
  "id": "pm-vsux",
  "title": "Implement include-body retrieval in list command pipeline",
  "description": "Add include-body option handling in list command and store retrieval so list variants can return body when requested.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:cli",
    "area:store",
    "body",
    "json",
    "list",
    "pm-cli"
  ],
  "created_at": "2026-03-31T19:37:16.976Z",
  "updated_at": "2026-03-31T19:45:34.617Z",
  "deadline": "2026-04-02T19:37:16.976Z",
  "author": "codex-agent",
  "estimated_minutes": 90,
  "acceptance_criteria": "runList supports includeBody option and list output includes body for each item when enabled.",
  "definition_of_ready": "Feature item exists and implementation files are identified.",
  "order": 1,
  "goal": "JSON contract clarity",
  "objective": "Implement opt-in body projection in list pipeline",
  "value": "Core behavior supports complete item views from list commands",
  "impact": "Unblocks metadata completeness checks needing body",
  "outcome": "List command produces body-inclusive rows on demand",
  "why_now": "Behavior change is foundation for tests and docs updates.",
  "parent": "pm-ykib",
  "risk": "medium",
  "confidence": "high",
  "sprint": "maintainer-loop-2026-03-31",
  "release": "v0.1",
  "component": "cli/list",
  "regression": true,
  "customer_impact": "Users can request body-inclusive list output.",
  "dependencies": [
    {
      "id": "pm-r0m",
      "kind": "related",
      "created_at": "2026-03-31T19:37:16.976Z",
      "author": "codex-agent"
    },
    {
      "id": "pm-ykib",
      "kind": "parent",
      "created_at": "2026-03-31T19:37:16.976Z",
      "author": "codex-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-31T19:37:16.976Z",
      "author": "codex-agent",
      "text": "Task A scope covers main list and store changes"
    },
    {
      "created_at": "2026-03-31T19:45:15.668Z",
      "author": "codex-agent",
      "text": "Implemented include-body pipeline: list option parsing in main, conditional body projection in runList, and store helper listAllFrontMatterWithBody while preserving default front-matter-only output."
    },
    {
      "created_at": "2026-03-31T19:45:24.603Z",
      "author": "codex-agent",
      "text": "Evidence: pm test pm-vsux --run passed (passed=1 failed=0 skipped=0). Full sandbox run node scripts/run-tests.mjs test passed 54 files and 529 tests."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-31T19:37:16.976Z",
      "author": "codex-agent",
      "text": "Keep default list path front-matter only and add conditional body projection"
    }
  ],
  "files": [
    {
      "path": "src/cli/commands/list.ts",
      "scope": "project",
      "note": "list options and output shape"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "add include-body flag wiring"
    },
    {
      "path": "src/core/store/item-store.ts",
      "scope": "project",
      "note": "list rows with optional body"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs test -- tests/unit/list-command.spec.ts",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "list unit behavior"
    }
  ],
  "docs": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "contract reference"
    }
  ],
  "close_reason": "Implemented include-body option wiring and conditional list body projection with passing linked and full regression tests."
}

Implement option plumbing and list item projection that merges front matter with body only when include-body is true.
