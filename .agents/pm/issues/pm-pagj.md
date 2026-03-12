{
  "id": "pm-pagj",
  "title": "Track GitHub Dependabot alert #12 for undici (GHSA-cxrh-j4jr-qwg3)",
  "description": "undici Denial of Service attack via bad certificate data",
  "type": "Issue",
  "status": "open",
  "priority": 2,
  "tags": [
    "dependabot",
    "github-alert",
    "security",
    "undici"
  ],
  "created_at": "2026-03-12T22:34:29.526Z",
  "updated_at": "2026-03-12T22:34:29.526Z",
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
  "repro_steps": "Open https://github.com/unbraind/pm-cli/security/dependabot/12",
  "expected_result": "No open GitHub Dependabot alert remains for GHSA-cxrh-j4jr-qwg3.",
  "actual_result": "GitHub reports open alert #12 for undici affecting < 5.29.0.",
  "affected_version": "< 5.29.0",
  "fixed_version": "5.29.0",
  "component": "dependency:undici",
  "customer_impact": "Runtime dependency vulnerabilities may affect CLI users and maintainers until remediated.",
  "comments": [
    {
      "created_at": "2026-03-12T22:34:29.526Z",
      "author": "codex-agent",
      "text": "Imported GitHub Dependabot alert GHSA-cxrh-j4jr-qwg3."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-12T22:34:29.526Z",
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

GitHub Dependabot alert #12
Package: undici
GHSA: GHSA-cxrh-j4jr-qwg3
CVE: CVE-2025-47279
Severity: low
Manifest: package.json
Scope: runtime
Relationship: direct
Vulnerable range: < 5.29.0
First patched version: 5.29.0
Alert URL: https://github.com/unbraind/pm-cli/security/dependabot/12
