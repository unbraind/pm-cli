{
  "id": "pm-gus1",
  "title": "Add integration test for pm list active-only behavior",
  "description": "The pm list command (without qualifiers) now excludes terminal statuses (closed/canceled) by default, but there is no integration test for this CLI behavior. Unit test covers excludeTerminal option in runList(), but integration test only covers list-draft/list-open/list-in-progress/list-blocked/list-closed/list-canceled/list-all, not the bare 'pm list' command.",
  "type": "Task",
  "status": "closed",
  "priority": 0,
  "tags": [
    "area:tests",
    "code",
    "milestone:6",
    "pm-cli",
    "tests"
  ],
  "created_at": "2026-03-08T22:29:52.874Z",
  "updated_at": "2026-03-08T22:33:58.030Z",
  "deadline": "2026-03-09T22:29:52.874Z",
  "author": "maintainer-agent",
  "estimated_minutes": 30,
  "acceptance_criteria": "pm list integration test verifies active-only behavior: terminal statuses excluded, non-terminal included. Tests pass at 100% coverage.",
  "definition_of_ready": "pm list behavior is already implemented; just need to add integration test coverage",
  "order": 1,
  "goal": "Maintain 100% integration test coverage for all CLI behaviors",
  "objective": "Cover pm list terminal-exclusion behavior in integration tests",
  "value": "Prevents regression of pm list active-only behavior",
  "impact": "Ensures pm list excludeTerminal wiring is always tested at CLI level",
  "outcome": "Integration test suite covers pm list bare command",
  "why_now": "pm list behavior was changed in session 6 but no integration test was added for the CLI wiring",
  "risk": "low",
  "confidence": "high",
  "comments": [
    {
      "created_at": "2026-03-08T22:29:52.874Z",
      "author": "maintainer-agent",
      "text": "Gap found: integration test suite tests list-draft/list-open/list-in-progress/list-blocked/list-closed/list-canceled/list-all but not bare pm list. The excludeTerminal unit test in list-command.spec.ts covers the function but not CLI wiring."
    },
    {
      "created_at": "2026-03-08T22:32:17.926Z",
      "author": "maintainer-agent",
      "text": "Implementation: added pm list active-only assertions to 'filters list/list-* status commands across lifecycle states' integration test. The test creates 7 items (draft/open/open/in_progress/blocked/closed/canceled), runs pm list, and asserts count=5 (non-terminal), no closed/canceled, all of draft/open/in_progress/blocked present. Full suite: 536/536 tests pass, 100% coverage maintained."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-08T22:29:52.874Z",
      "author": "maintainer-agent",
      "text": "Add to the existing filters list/list-* integration test or create new test. Should use existing createItem helper pattern. Assert count=4 for non-terminal items only."
    }
  ],
  "files": [
    {
      "path": "tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "note": "add pm list integration test"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 300,
      "note": "full coverage gate"
    }
  ],
  "docs": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "section 12 determinism requirements"
    }
  ],
  "close_reason": "Integration test for pm list active-only behavior added and verified. 536/536 tests pass, 100% coverage maintained."
}

Add an integration test in cli.integration.spec.ts that:\n1. Creates items with draft/open/in_progress/blocked/closed/canceled statuses\n2. Runs pm list (bare command)\n3. Verifies closed and canceled items are NOT present\n4. Verifies draft/open/in_progress/blocked items ARE present
