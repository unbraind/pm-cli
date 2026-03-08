{
  "id": "pm-mwap",
  "title": "Add npm provenance attestation to release workflow",
  "description": "The release workflow has id-token: write permission but does not use --provenance flag on npm publish. Provenance attestation is a 2024-2025 npm best practice that links published packages to their source commit and build pipeline via Sigstore, enabling users to verify supply chain integrity. npm shows a Provenance badge on the package page.",
  "type": "Chore",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:ci",
    "area:security",
    "code",
    "milestone:6",
    "pm-cli",
    "tests"
  ],
  "created_at": "2026-03-08T21:48:02.472Z",
  "updated_at": "2026-03-08T21:49:11.361Z",
  "deadline": "2026-03-09T21:48:02.472Z",
  "author": "maintainer-agent",
  "estimated_minutes": 20,
  "acceptance_criteria": "release.yml npm publish uses --provenance flag. CHANGELOG documents provenance. Tests pass.",
  "goal": "Supply chain security",
  "objective": "Enable npm provenance attestation for package verification",
  "value": "Package consumers can verify build provenance via Sigstore",
  "impact": "npm shows Provenance badge; supply chain attacks become detectable",
  "outcome": "npm publish with --provenance enabled in release workflow",
  "why_now": "id-token: write is already present; provenance is a simple one-flag add",
  "risk": "low",
  "confidence": "high",
  "sprint": "maintainer-loop",
  "release": "v0.1.0",
  "comments": [
    {
      "created_at": "2026-03-08T21:48:02.472Z",
      "author": "maintainer-agent",
      "text": "release.yml already has id-token: write permission. Adding --provenance to npm publish command is a one-line change."
    },
    {
      "created_at": "2026-03-08T21:49:07.159Z",
      "author": "maintainer-agent",
      "text": "Implemented: npm publish --access public --provenance in release.yml. CHANGELOG updated. 535/535 tests pass. Contract test still passes (contains check on 'run: npm publish' matches the full command)."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-08T21:48:02.472Z",
      "author": "maintainer-agent",
      "text": "Also add --provenance documentation to CHANGELOG.md"
    }
  ],
  "files": [
    {
      "path": ".github/workflows/release.yml",
      "scope": "project",
      "note": "add --provenance to npm publish"
    },
    {
      "path": "CHANGELOG.md",
      "scope": "project",
      "note": "document provenance attestation"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs test",
      "scope": "project",
      "timeout_seconds": 300,
      "note": "full test suite"
    }
  ],
  "docs": [
    {
      "path": "PRD.md",
      "scope": "project",
      "note": "governing spec"
    }
  ],
  "close_reason": "npm publish --provenance added to release.yml; CHANGELOG updated; 535/535 tests pass; all contract tests still pass."
}

Add --provenance flag to npm publish command in .github/workflows/release.yml. The id-token: write permission is already present. Update CHANGELOG.md to document.
