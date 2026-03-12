{
  "id": "pm-d3i5",
  "title": "Track GitHub Dependabot alert #9 for undici (GHSA-3787-6prv-h9w3)",
  "description": "Undici proxy-authorization header not cleared on cross-origin redirect in fetch",
  "type": "Issue",
  "status": "closed",
  "priority": 2,
  "tags": [
    "dependabot",
    "github-alert",
    "security",
    "undici"
  ],
  "created_at": "2026-03-12T22:34:27.041Z",
  "updated_at": "2026-03-12T23:19:36.999Z",
  "author": "codex-agent",
  "estimated_minutes": 30,
  "acceptance_criteria": "Alert is resolved by an upgrade or explicitly dismissed with recorded rationale and verification.",
  "definition_of_ready": "GitHub alert details are captured and remediation path is understood.",
  "goal": "Security hygiene",
  "objective": "Track runtime dependency vulnerabilities reported by GitHub",
  "value": "Makes dependency risk visible in the project tracker",
  "impact": "Enables explicit prioritization and remediation of open security alerts",
  "outcome": "Each GitHub vulnerability alert has a tracked pm issue",
  "why_now": "GitHub currently reports this alert as open on the default branch",
  "risk": "low",
  "confidence": "high",
  "reporter": "github-dependabot",
  "severity": "low",
  "environment": "runtime direct dependency in package.json",
  "repro_steps": "Open https://github.com/unbraind/pm-cli/security/dependabot/9",
  "expected_result": "No open GitHub Dependabot alert remains for GHSA-3787-6prv-h9w3.",
  "actual_result": "GitHub reports open alert #9 for undici affecting <= 5.28.2.",
  "affected_version": "<= 5.28.2",
  "fixed_version": "5.28.3",
  "component": "dependency:undici",
  "customer_impact": "Runtime dependency vulnerabilities may affect CLI users and maintainers until remediated.",
  "comments": [
    {
      "created_at": "2026-03-12T22:34:27.041Z",
      "author": "codex-agent",
      "text": "Imported GitHub Dependabot alert GHSA-3787-6prv-h9w3."
    },
    {
      "created_at": "2026-03-12T23:19:36.203Z",
      "author": "cursor-agent",
      "text": "Verification: pnpm audit --prod reports 'No known vulnerabilities found' on 2026-03-12. Current lockfile resolves undici@7.22.0, fast-json-patch@3.1.1, and zod@4.3.6, meeting or exceeding fixed versions recorded in this alert."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-12T22:34:27.041Z",
      "author": "codex-agent",
      "text": "Remediate or dismiss this alert with verification evidence."
    }
  ],
  "files": [
    {
      "path": "package.json",
      "scope": "project",
      "note": "affected dependency manifest"
    }
  ],
  "docs": [
    {
      "path": "SECURITY.md",
      "scope": "project",
      "note": "security reporting and handling policy"
    }
  ],
  "close_reason": "Dependency remediation verified locally; no remaining known vulnerabilities in current dependency graph."
}

GitHub Dependabot alert #9
Package: undici
GHSA: GHSA-3787-6prv-h9w3
CVE: CVE-2024-24758
Severity: low
Manifest: package.json
Scope: runtime
Relationship: direct
Vulnerable range: <= 5.28.2
First patched version: 5.28.3
Alert URL: https://github.com/unbraind/pm-cli/security/dependabot/9
