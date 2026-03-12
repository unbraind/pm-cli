{
  "id": "pm-rbdu",
  "title": "Track and commit imported pm issue/history files",
  "description": "Audit the untracked imported Dependabot pm issue/history files for private data, then commit and push the safe tracker records so repository pm data stays complete.",
  "type": "Task",
  "status": "closed",
  "priority": 0,
  "tags": [
    "pm-cli",
    "pm-data",
    "security",
    "tracker"
  ],
  "created_at": "2026-03-12T23:13:24.830Z",
  "updated_at": "2026-03-12T23:14:37.172Z",
  "deadline": "2026-03-13T23:13:24.830Z",
  "author": "codex-maintainer",
  "estimated_minutes": 45,
  "acceptance_criteria": "1) Untracked pm issue/history files are audited for secrets or private data. 2) Safe files are committed and pushed. 3) The commit excludes unrelated local-only tracker files if any remain unsafe or unrelated.",
  "definition_of_ready": "Imported untracked pm issue/history files are present in the worktree and their origin is understood.",
  "goal": "Tracker completeness",
  "objective": "Version imported pm issue/history records safely",
  "value": "Keeps repository pm data complete and reproducible",
  "impact": "Dependabot-derived tracker items and histories become part of the repo state",
  "outcome": "Imported pm issues/history are committed without leaking private data",
  "why_now": "The user explicitly wants the imported issue/history files tracked in git.",
  "risk": "medium",
  "confidence": "medium",
  "component": "tracker:pm-data",
  "customer_impact": "Repository users can inspect current security-tracker items directly from git history.",
  "comments": [
    {
      "created_at": "2026-03-12T23:13:24.830Z",
      "author": "codex-maintainer",
      "text": "Audit imported tracker files for private data before committing them."
    },
    {
      "created_at": "2026-03-12T23:14:13.187Z",
      "author": "codex-maintainer",
      "text": "Audited 13 imported issue files and 13 matching history logs. No credentials, tokens, private keys, JWT-like strings, emails, or auth-token assignments were found. Content is limited to Dependabot advisory metadata, package paths, and repository alert reference URLs."
    },
    {
      "created_at": "2026-03-12T23:14:31.109Z",
      "author": "codex-maintainer",
      "text": "Evidence: staged imported issue/history files passed node scripts/check-secrets.mjs, targeted regex audit found no credentials/private keys/JWT-like strings/emails, and git diff --cached --check reported no whitespace or patch-format issues."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-12T23:13:24.830Z",
      "author": "codex-maintainer",
      "text": "Use pm as the system of record while preserving append-only item history."
    }
  ],
  "files": [
    {
      "path": ".agents/pm/history/pm-4ydh.jsonl",
      "scope": "project",
      "note": "representative imported tracker history"
    },
    {
      "path": ".agents/pm/issues/pm-4ydh.md",
      "scope": "project",
      "note": "representative imported tracker file"
    },
    {
      "path": ".agents/pm/issues/pm-51y8.md",
      "scope": "project",
      "note": "imported tracker file"
    }
  ],
  "tests": [
    {
      "command": "node scripts/check-secrets.mjs",
      "scope": "project",
      "timeout_seconds": 240,
      "note": "tracked-file credential scan after staging intended files"
    }
  ],
  "docs": [
    {
      "path": "SECURITY.md",
      "scope": "project",
      "note": "security handling reference"
    }
  ],
  "close_reason": "Imported pm issue/history files were audited, found free of credential-like private data, and are ready to be committed and pushed."
}

User asked that the imported .agents/pm/issues and .agents/pm/history files be versioned as well. Audit them for private data first, then commit and push only if clean.
