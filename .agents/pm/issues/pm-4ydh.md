{
  "id": "pm-4ydh",
  "title": "Track GitHub Dependabot alert #7 for zod (GHSA-m95q-7qp3-xv42)",
  "description": "Zod denial of service vulnerability",
  "type": "Issue",
  "status": "open",
  "priority": 1,
  "tags": [
    "dependabot",
    "github-alert",
    "security",
    "zod"
  ],
  "created_at": "2026-03-12T22:34:25.426Z",
  "updated_at": "2026-03-12T22:34:25.426Z",
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
  "risk": "medium",
  "confidence": "high",
  "reporter": "github-dependabot",
  "severity": "medium",
  "environment": "runtime direct dependency in package.json",
  "repro_steps": "Open https://github.com/unbraind/pm-cli/security/dependabot/7",
  "expected_result": "No open GitHub Dependabot alert remains for GHSA-m95q-7qp3-xv42.",
  "actual_result": "GitHub reports open alert #7 for zod affecting <= 3.22.2.",
  "affected_version": "<= 3.22.2",
  "fixed_version": "3.22.3",
  "component": "dependency:zod",
  "customer_impact": "Runtime dependency vulnerabilities may affect CLI users and maintainers until remediated.",
  "comments": [
    {
      "created_at": "2026-03-12T22:34:25.426Z",
      "author": "codex-agent",
      "text": "Imported GitHub Dependabot alert GHSA-m95q-7qp3-xv42."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-12T22:34:25.426Z",
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
  ]
}

GitHub Dependabot alert #7
Package: zod
GHSA: GHSA-m95q-7qp3-xv42
CVE: CVE-2023-4316
Severity: medium
Manifest: package.json
Scope: runtime
Relationship: direct
Vulnerable range: <= 3.22.2
First patched version: 3.22.3
Alert URL: https://github.com/unbraind/pm-cli/security/dependabot/7
