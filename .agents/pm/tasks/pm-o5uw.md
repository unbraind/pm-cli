{
  "id": "pm-o5uw",
  "title": "Add AGENTS rule to check existing pm items before creating new ones",
  "description": "Update AGENTS.md to require agents to search existing pm items before creating a new item so duplicate tracker entries are not introduced.",
  "type": "Task",
  "status": "blocked",
  "priority": 1,
  "tags": [
    "agents",
    "docs",
    "pm-hygiene"
  ],
  "created_at": "2026-03-12T22:26:40.371Z",
  "updated_at": "2026-03-12T22:29:44.176Z",
  "author": "codex-agent",
  "estimated_minutes": 20,
  "acceptance_criteria": "AGENTS.md clearly instructs agents to search existing pm items before creating a new item and to avoid duplicate pm items.",
  "goal": "Tracker hygiene",
  "objective": "Prevent duplicate pm items",
  "value": "Keeps planning state accurate and avoids duplicate work records",
  "impact": "Improves multi-agent coordination and reduces cleanup",
  "outcome": "Agents search before creating",
  "why_now": "The repository instructions should explicitly encode this best practice",
  "risk": "low",
  "confidence": "high",
  "blocked_reason": "Broader README and help contract failures remain in the current coverage sweep.",
  "component": "documentation",
  "customer_impact": "Reduces duplicate tracker entries for contributors and agents",
  "comments": [
    {
      "created_at": "2026-03-12T22:26:40.371Z",
      "author": "codex-agent",
      "text": "Search existing pm items first before creating a new one."
    },
    {
      "created_at": "2026-03-12T22:29:10.653Z",
      "author": "codex-agent",
      "text": "Updated AGENTS Step A to require searching existing pm items before create. Evidence: pm test pm-o5uw --run passed the linked secret scan. Broader node scripts/run-tests.mjs coverage failed in existing README and help contract tests after the earlier README rewrite, so this item remains open for visibility."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-12T22:26:40.371Z",
      "author": "codex-agent",
      "text": "Place the rule near the workflow entry point so agents see it before create actions."
    }
  ],
  "files": [
    {
      "path": "AGENTS.md",
      "scope": "project",
      "note": "workflow rule update target"
    }
  ],
  "tests": [
    {
      "command": "node scripts/check-secrets.mjs",
      "scope": "project",
      "timeout_seconds": 240,
      "note": "publish-safety scan before push"
    }
  ]
}

Clarify the workflow so agents must search or list for an existing relevant pm item before they create a new one.
