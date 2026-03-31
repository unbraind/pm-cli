{
  "id": "pm-gudp",
  "title": "Document include-body list contract and capture validation evidence",
  "description": "Update PRD and changelog for include-body and close tracking items with linked test evidence.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:docs",
    "area:release",
    "body",
    "json",
    "list",
    "pm-cli"
  ],
  "created_at": "2026-03-31T19:37:36.074Z",
  "updated_at": "2026-03-31T19:45:35.517Z",
  "deadline": "2026-04-02T19:37:36.074Z",
  "author": "codex-agent",
  "estimated_minutes": 75,
  "acceptance_criteria": "PRD and CHANGELOG document include-body semantics and task closure comments include passing test evidence.",
  "definition_of_ready": "Implementation and test tasks are defined and docs files are linked.",
  "order": 3,
  "goal": "JSON contract clarity",
  "objective": "Finalize documentation and closure evidence",
  "value": "Users understand list output contract and migration path",
  "impact": "Reduces confusion about metadata completeness expectations",
  "outcome": "Docs and release notes match runtime behavior",
  "why_now": "Contract updates must land alongside behavior changes.",
  "parent": "pm-ykib",
  "risk": "low",
  "confidence": "high",
  "sprint": "maintainer-loop-2026-03-31",
  "release": "v0.1",
  "component": "docs/contracts",
  "regression": false,
  "customer_impact": "Users can interpret list payload completeness correctly.",
  "dependencies": [
    {
      "id": "pm-ote",
      "kind": "related",
      "created_at": "2026-03-31T19:37:36.074Z",
      "author": "codex-agent"
    },
    {
      "id": "pm-ykib",
      "kind": "parent",
      "created_at": "2026-03-31T19:37:36.074Z",
      "author": "codex-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-31T19:37:36.074Z",
      "author": "codex-agent",
      "text": "Task C records contract docs changes and final evidence"
    },
    {
      "created_at": "2026-03-31T19:45:16.998Z",
      "author": "codex-agent",
      "text": "Updated PRD and CHANGELOG to document include-body semantics and list row projection behavior with deterministic filters.include_body."
    },
    {
      "created_at": "2026-03-31T19:45:25.456Z",
      "author": "codex-agent",
      "text": "Evidence: pm test pm-gudp --run passed (passed=1 failed=0 skipped=0). node scripts/run-tests.mjs coverage completed with 100% statements, branches, functions, and lines."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-31T19:37:36.074Z",
      "author": "codex-agent",
      "text": "Update PRD and changelog after behavior is verified"
    }
  ],
  "files": [
    {
      "path": "CHANGELOG.md",
      "scope": "project",
      "note": "unreleased note for include-body"
    },
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "list filter and output contract"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 3600,
      "note": "full coverage evidence"
    }
  ],
  "docs": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "authoritative contract doc"
    }
  ],
  "close_reason": "Updated PRD and changelog for include-body contract and confirmed 100% coverage in sandbox runs."
}

Document new include-body flag behavior and record final test plus coverage evidence before closing feature and epic.
