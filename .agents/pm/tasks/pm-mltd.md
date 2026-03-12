{
  "id": "pm-mltd",
  "title": "Expand README quick start create example to full field surface",
  "description": "Update the README quick start pm create example so it demonstrates every currently available create field with plausible sample data while treating markdown files strictly as documentation, not contract sources.",
  "type": "Task",
  "status": "closed",
  "priority": 1,
  "tags": [
    "area:docs",
    "pm-cli",
    "quickstart",
    "readme"
  ],
  "created_at": "2026-03-12T23:22:33.164Z",
  "updated_at": "2026-03-12T23:30:13.829Z",
  "deadline": "2026-03-13T23:22:33.164Z",
  "author": "codex-maintainer",
  "estimated_minutes": 60,
  "acceptance_criteria": "README quick start shows all currently supported pm create fields with plausible public-safe values; runtime create-field verification passes; no markdown docs are used as contract sources for this work.",
  "definition_of_ready": "README quick start location, create CLI field surface, and runtime verification paths are identified.",
  "goal": "Release-ready docs",
  "objective": "Make the create command surface obvious to new users",
  "value": "Reduces ambiguity around optional metadata and seed flags",
  "impact": "Fewer incorrect create invocations and better discoverability",
  "outcome": "Users can see the full create surface from the README quick start",
  "why_now": "The quick start is the first public example many users will copy, so it must show the full contract clearly.",
  "risk": "low",
  "confidence": "high",
  "environment": "docs",
  "expected_result": "README quick start create example demonstrates the complete field surface.",
  "affected_version": "2026.3.9",
  "component": "documentation",
  "customer_impact": "Users should understand the full pm create capability without reading source code.",
  "comments": [
    {
      "created_at": "2026-03-12T23:22:33.164Z",
      "author": "codex-maintainer",
      "text": "Track public README quick start expansion and pre-push leak review."
    },
    {
      "created_at": "2026-03-12T23:25:16.747Z",
      "author": "codex-maintainer",
      "text": "Constraint update from user: markdown files are documentation only and must not be treated as contract sources; verification for this work will rely on pm runtime behavior and source/tests instead."
    },
    {
      "created_at": "2026-03-12T23:27:32.623Z",
      "author": "codex-maintainer",
      "text": "Planned change-set: replace the minimal README quick start create example with one exhaustive all-fields example, then verify using runtime create coverage, a sandboxed sample invocation, and a secret scan instead of markdown-contract checks."
    },
    {
      "created_at": "2026-03-12T23:29:57.500Z",
      "author": "codex-maintainer",
      "text": "Implemented README quick start expansion: the create example now shows every field with plausible public-safe sample data and explicitly states that CLI help/runtime behavior are authoritative while README content is illustrative. Evidence: sandboxed sample create invocation succeeded with the full all-fields command; pm test pm-mltd --run passed after fixing a shell-fragile linked test command; node scripts/run-tests.mjs coverage passed with 54 files and 528 tests at 100 percent coverage; node scripts/check-secrets.mjs reported no credential-like secrets in tracked files."
    }
  ],
  "notes": [
    {
      "created_at": "2026-03-12T23:22:33.164Z",
      "author": "codex-maintainer",
      "text": "Plan is to update README plus any contract tests that assert quick start content."
    }
  ],
  "files": [
    {
      "path": "README.md",
      "scope": "project",
      "note": "quick start create example to expand"
    },
    {
      "path": "src/cli/main.ts",
      "scope": "project",
      "note": "create command field surface reference"
    },
    {
      "path": "tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "note": "runtime create-field coverage"
    }
  ],
  "tests": [
    {
      "command": "node scripts/run-tests.mjs test -- tests/integration/cli.integration.spec.ts",
      "scope": "project",
      "timeout_seconds": 1800,
      "note": "sandboxed runtime create-field verification"
    },
    {
      "command": "pnpm build",
      "scope": "project",
      "timeout_seconds": 300,
      "note": "TypeScript build verification"
    }
  ],
  "close_reason": "README quick start now shows the full create field surface; runtime create verification, sandbox sample, coverage, and secret scan passed."
}

Refresh the public quick start snippet to be an exhaustive, realistic create example that users can copy and adapt.
