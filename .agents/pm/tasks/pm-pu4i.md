{
  "id": "pm-pu4i",
  "title": "M5 roadmap: Todos import/export extension parity polish",
  "description": "Implement parity polish for todos import/export.",
  "type": "Task",
  "status": "closed",
  "priority": 2,
  "tags": [
    "area:extensions",
    "milestone:5",
    "pm-cli",
    "roadmap"
  ],
  "created_at": "2026-03-07T14:01:19.511Z",
  "updated_at": "2026-03-07T14:07:32.995Z",
  "author": "maintainer-agent",
  "estimated_minutes": 60,
  "acceptance_criteria": "Todos import/export is fully polished.",
  "comments": [
    {
      "created_at": "2026-03-07T14:05:30.075Z",
      "author": "unknown",
      "text": "author=,text=Implemented parity polish for todos export/import to map full ItemFrontMatter natively"
    }
  ],
  "files": [
    {
      "path": "src/extensions/builtins/todos/import-export.ts",
      "scope": "project",
      "note": "added all missing ItemFrontMatter fields to export and import mapping"
    }
  ],
  "close_reason": "Implemented and tested parity polish for todos import/export."
}

Implement remaining parity polish and hardening for built-in todos import/export extension.
