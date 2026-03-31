{
  "id": "pm-0lbm",
  "title": "List JSON Body Projection Contract",
  "description": "Track opt-in include-body support for list commands so metadata completeness analysis can request body content without changing default lightweight output.",
  "type": "Epic",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:cli",
    "area:contracts",
    "body",
    "json",
    "list",
    "pm-cli"
  ],
  "created_at": "2026-03-31T19:36:37.724Z",
  "updated_at": "2026-03-31T19:45:53.284Z",
  "deadline": "2026-04-03T19:36:37.724Z",
  "author": "codex-agent",
  "estimated_minutes": 180,
  "acceptance_criteria": "All list variants accept include-body as opt-in, default list payload remains unchanged, and tests plus docs reflect the contract.",
  "definition_of_ready": "Duplicate guard completed and no existing open item covers list body projection.",
  "order": 1,
  "goal": "JSON contract clarity",
  "objective": "Make list payload completeness explicit and controllable",
  "value": "Prevents false metadata-completeness conclusions while preserving lightweight defaults",
  "impact": "Improves reliability for automation consuming list JSON",
  "outcome": "Consumers can opt into body on list results",
  "why_now": "External issue report shows current behavior appears misleading without explicit opt-in.",
  "risk": "low",
  "confidence": "high",
  "sprint": "maintainer-loop-2026-03-31",
  "release": "v0.1",
  "component": "cli/list",
  "regression": true,
  "customer_impact": "Users and agents can accurately analyze item completeness from list JSON when needed.",
  "dependencies": [
    {
      "id": "pm-54d",
      "kind": "related",
      "created_at": "2026-03-31T19:36:37.724Z",
      "author": "codex-agent"
    },
    {
      "id": "pm-gus1",
      "kind": "related",
      "created_at": "2026-03-31T19:36:37.724Z",
      "author": "codex-agent"
    },
    {
      "id": "pm-ote",
      "kind": "related",
      "created_at": "2026-03-31T19:36:37.724Z",
      "author": "codex-agent"
    },
    {
      "id": "pm-r0m",
      "kind": "related",
      "created_at": "2026-03-31T19:36:37.724Z",
      "author": "codex-agent"
    },
    {
      "id": "pm-zzt1",
      "kind": "related",
      "created_at": "2026-03-31T19:36:37.724Z",
      "author": "codex-agent"
    }
  ],
  "comments": [
    {
      "created_at": "2026-03-31T19:36:37.724Z",
      "author": "codex-agent",
      "text": "Epic created after duplicate-guard sweep and external issue report."
    },
    {
      "created_at": "2026-03-31T19:45:51.565Z",
      "author": "codex-agent",
      "text": "Feature pm-ykib and child tasks are closed with evidence: include-body is now opt-in for list variants, docs/changelog are updated, and sandbox test plus coverage runs remain green at 100%."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-31T19:36:37.724Z",
      "author": "codex-agent",
      "text": "Implement opt-in include-body without changing default list performance profile."
    }
  ],
  "files": [
    {
      "path": "src/cli/commands/list.ts",
      "scope": "project",
      "note": "primary list payload command"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs test",
      "scope": "project",
      "timeout_seconds": 3600,
      "note": "full regression"
    }
  ],
  "docs": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "command output contract"
    }
  ],
  "close_reason": "Completed optional list body projection contract with implementation, tests, docs, and validation evidence."
}

Coordinate implementation, tests, docs, and release evidence for optional list body projection.
