{
  "id": "pm-zzt1",
  "title": "Differentiate pm list (active-only) from pm list-all (all items)",
  "description": "Currently pm list and pm list-all are functionally identical. pm list should show only non-terminal items while pm list-all shows everything.",
  "type": "Task",
  "status": "closed",
  "priority": 0,
  "tags": [
    "area:cli",
    "area:ux",
    "code",
    "milestone:6",
    "pm-cli",
    "priority:0",
    "tests"
  ],
  "created_at": "2026-03-08T22:07:09.126Z",
  "updated_at": "2026-03-08T22:12:59.805Z",
  "deadline": "2026-03-09T22:07:09.126Z",
  "author": "maintainer-agent",
  "estimated_minutes": 60,
  "acceptance_criteria": "pm list excludes closed and canceled items by default; pm list-all shows all items; tests verify the distinction",
  "order": 1,
  "goal": "Production-ready UX consistency",
  "objective": "Make pm list intuitive for daily use",
  "value": "Users get expected behavior: pm list shows working set not historical data",
  "impact": "Reduces confusion; aligns with CLI conventions",
  "outcome": "pm list shows active items; pm list-all shows full inventory",
  "why_now": "All features complete; polishing UX is the last mile",
  "risk": "low",
  "confidence": "high",
  "sprint": "release-polish",
  "release": "v0.1",
  "comments": [
    {
      "created_at": "2026-03-08T22:07:09.126Z",
      "author": "maintainer-agent",
      "text": "pm list and pm list-all are currently identical. Fix: pm list should exclude terminal statuses by default."
    },
    {
      "created_at": "2026-03-08T22:12:48.671Z",
      "author": "maintainer-agent",
      "text": "Implementation complete. Changed: list.ts (excludeTerminal option in ListOptions + applyFilters), main.ts (normalizeListOptions returns ListOptions, registerListCommand adds excludeTerminal param, pm list wired with excludeTerminal=true). Updated: PRD.md, README.md (new pm list vs pm list-all section), CHANGELOG.md. Tests: added excludes-terminal-statuses test case in list-command.spec.ts. Result: 536/536 tests pass, 100% coverage maintained."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-08T22:07:09.126Z",
      "author": "maintainer-agent",
      "text": "Update runList() to accept excludeTerminal option and wire pm list in main.ts with that flag set."
    }
  ],
  "files": [
    {
      "path": "src/cli/commands/list.ts",
      "scope": "project",
      "note": "runList function needs excludeTerminal option"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "wire pm list with excludeTerminal=true"
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
      "note": "update pm list vs pm list-all distinction"
    },
    {
      "path": "README.md",
      "scope": "project",
      "note": "update commands section"
    }
  ],
  "close_reason": "pm list now excludes terminal statuses by default; pm list-all shows all items; 536 tests pass at 100% coverage; PRD+README+CHANGELOG updated"
}

Implementation: update runList() with excludeTerminal option, wire pm list in main.ts, update PRD+README, update tests
