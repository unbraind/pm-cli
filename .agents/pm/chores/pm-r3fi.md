{
  "id": "pm-r3fi",
  "title": "Fix devDependency security vulnerabilities via c8 and rollup updates",
  "description": "Update c8 from v10 to v11 (fixes minimatch ReDoS vulnerabilities in test-exclude) and add pnpm.overrides for rollup >=4.59.0 (fixes Rollup path traversal CVE via vitest -> vite -> rollup chain). All 17 Dependabot alerts resolved.",
  "type": "Chore",
  "status": "closed",
  "priority": 0,
  "tags": [
    "area:ci",
    "maintenance",
    "pm-cli",
    "release-readiness",
    "security"
  ],
  "created_at": "2026-03-08T17:13:28.000Z",
  "updated_at": "2026-03-08T17:13:28.000Z",
  "deadline": "2026-03-09T17:13:28.000Z",
  "author": "maintainer-agent",
  "estimated_minutes": 30,
  "acceptance_criteria": "{\"id\":\"AC-1\",\"text\":\"pnpm audit reports no known vulnerabilities\",\"type\":\"security\",\"verification\":\"automated\"}",
  "why_now": "Dependabot alerts found after push to main",
  "risk": "low",
  "confidence": "high",
  "sprint": "maintenance-loop",
  "release": "v0.1",
  "severity": "high",
  "environment": "devDependencies only",
  "resolution": "c8 updated to v11; rollup pinned to >=4.59.0 via pnpm.overrides",
  "expected_result": "pnpm audit clean",
  "actual_result": "pnpm audit reports No known vulnerabilities found",
  "affected_version": "0.1.0",
  "fixed_version": "0.1.0",
  "component": "package.json devDependencies",
  "comments": [
    {
      "created_at": "2026-03-08T17:13:28.000Z",
      "author": "maintainer-agent",
      "text": "pnpm audit confirmed: No known vulnerabilities found. All 473 tests pass at 100% coverage after updates."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-08T17:13:28.000Z",
      "author": "maintainer-agent",
      "text": "c8 10->11 update fixes 4x minimatch vulnerabilities. pnpm.overrides rollup>=4.59.0 fixes rollup path traversal. Both are devDependencies only."
    }
  ],
  "files": [
    {
      "path": "package.json",
      "scope": "project",
      "note": "c8 and rollup override updated"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs coverage",
      "scope": "project",
      "timeout_seconds": 600,
      "note": "full coverage gate"
    }
  ]
}

Dependency path for minimatch: c8 -> test-exclude -> minimatch (9.x had ReDoS in pattern matching). Fixed by updating to c8 v11 which uses test-exclude v8 which depends on minimatch v10.\n\nDependency path for rollup: vitest -> @vitest/mocker -> vite -> rollup (4.57.1 had arbitrary file write via path traversal). Fixed by adding pnpm.overrides rollup >= 4.59.0.\n\nBoth are devDependencies and do not affect the published npm package or end users.
